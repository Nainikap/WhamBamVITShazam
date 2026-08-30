import { rationalToRate, validateProject, type Project, type Track } from '../domain';

export interface PreviewSegment {
  id: string;
  kind: 'clip' | 'gap' | 'caption' | 'transition';
  name: string;
  timelineStart: number;
  duration: number;
  sourceStart: number;
  assetFingerprint?: string;
  assetName?: string;
  /** True for a title or other clip with no file behind it by nature. */
  isGenerator?: boolean;
  mediaUrl?: string;
  available: boolean;
  gainDb: number;
  preset?: 'none' | 'warm' | 'cool' | 'mono';
  text?: string;
  enabled?: boolean;
  markerCount?: number;
  effectCount?: number;
}

export interface PreviewTrack {
  id: string;
  name: string;
  kind: 'video' | 'audio' | 'caption';
  totalFrames: number;
  segments: PreviewSegment[];
}

export interface PreviewPlan {
  revision: string;
  commitId: string;
  snapshotDigest: string;
  fps: number;
  width: number;
  height: number;
  totalFrames: number;
  videoTrackName: string | null;
  /** Segments of the primary video track, which drives the viewer. */
  segments: PreviewSegment[];
  /** Every track in the sequence, in sequence order, for the timeline. */
  tracks: PreviewTrack[];
  missingAssets: Array<{ fingerprint: string; name: string }>;
}

export interface PreviewMediaAvailability {
  available: boolean;
  mediaUrl?: string;
}

function buildTrack(
  project: Project,
  track: Track,
  availability: Readonly<Record<string, PreviewMediaAvailability>>,
  missing: Map<string, string>,
): PreviewTrack {
  const clipById = new Map(project.clips.map((clip) => [clip.id, clip]));
  const gapById = new Map(project.gaps.map((gap) => [gap.id, gap]));
  const captionById = new Map(project.captions.map((caption) => [caption.id, caption]));
  const transitionById = new Map(project.transitions.map((transition) => [transition.id, transition]));
  const assetById = new Map(project.assets.map((asset) => [asset.id, asset]));
  const segments: PreviewSegment[] = [];
  let timelineStart = 0;

  for (const itemId of track.itemIds) {
    const caption = captionById.get(itemId);
    if (caption) {
      // Captions carry an absolute sequence range rather than a running offset.
      segments.push({
        id: caption.id,
        kind: 'caption',
        name: caption.text,
        timelineStart: caption.range.start,
        duration: caption.range.duration,
        sourceStart: 0,
        available: true,
        gainDb: 0,
        text: caption.text,
        enabled: caption.enabled,
        markerCount: caption.markers.length,
        effectCount: caption.effects.length,
      });
      continue;
    }
    const transition = transitionById.get(itemId);
    if (transition) {
      // A transition overlaps the items beside it rather than occupying its own time.
      const width = transition.inOffsetFrames + transition.outOffsetFrames;
      segments.push({
        id: transition.id,
        kind: 'transition',
        name: transition.name,
        timelineStart: Math.max(0, timelineStart - transition.inOffsetFrames),
        duration: Math.max(1, width),
        sourceStart: 0,
        available: true,
        gainDb: 0,
        enabled: transition.enabled,
        markerCount: transition.markers.length,
        effectCount: transition.effects.length,
      });
      continue;
    }
    const gap = gapById.get(itemId);
    if (gap) {
      segments.push({
        id: gap.id,
        kind: 'gap',
        name: 'Gap',
        timelineStart,
        duration: gap.durationFrames,
        sourceStart: 0,
        available: false,
        gainDb: 0,
        enabled: gap.enabled,
        markerCount: gap.markers.length,
        effectCount: gap.effects.length,
      });
      timelineStart += gap.durationFrames;
      continue;
    }
    const clip = clipById.get(itemId);
    if (!clip) continue;
    const asset = assetById.get(clip.assetId);
    if (!asset) continue;
    const media = availability[asset.fingerprint];
    const generator = asset.extras.generator === true;
    const segment: PreviewSegment = {
      id: clip.id,
      kind: 'clip',
      name: clip.name,
      timelineStart,
      duration: clip.sourceRange.duration,
      sourceStart: clip.sourceRange.start,
      assetFingerprint: asset.fingerprint,
      assetName: asset.name,
      available: media?.available === true,
      ...(generator ? { isGenerator: true } : {}),
      gainDb: clip.gainDb,
      preset: clip.preset,
      enabled: clip.enabled,
      markerCount: clip.markers.length,
      effectCount: clip.effects.length,
    };
    if (media?.mediaUrl) segment.mediaUrl = media.mediaUrl;
    segments.push(segment);
    if (!segment.available && !generator) missing.set(asset.fingerprint, asset.name);
    timelineStart += clip.sourceRange.duration;
  }

  const totalFrames = track.kind === 'caption'
    ? segments.reduce((total, segment) => Math.max(total, segment.timelineStart + segment.duration), 0)
    : timelineStart;
  return { id: track.id, name: track.name, kind: track.kind, totalFrames, segments };
}

/**
 * Resolve composites higher-numbered video tracks over lower ones. The player
 * needs one non-overlapping stream, so slice the visible clip at every layer
 * boundary and select the highest enabled clip for that interval. Gaps reveal
 * the track below instead of hiding it.
 */
function compositeVideoTracks(tracks: PreviewTrack[], totalFrames: number): PreviewSegment[] {
  const boundaries = new Set([0, totalFrames]);
  for (const track of tracks) {
    for (const segment of track.segments) {
      if (segment.kind !== 'clip' || segment.enabled === false) continue;
      boundaries.add(Math.max(0, Math.min(totalFrames, segment.timelineStart)));
      boundaries.add(Math.max(0, Math.min(totalFrames, segment.timelineStart + segment.duration)));
    }
  }

  const frames = [...boundaries].sort((left, right) => left - right);
  const composite: PreviewSegment[] = [];
  for (let index = 0; index < frames.length - 1; index += 1) {
    const start = frames[index] as number;
    const end = frames[index + 1] as number;
    if (end <= start) continue;

    let visible: PreviewSegment | undefined;
    for (let trackIndex = tracks.length - 1; trackIndex >= 0 && !visible; trackIndex -= 1) {
      visible = tracks[trackIndex]?.segments.find((segment) => segment.kind === 'clip'
        && segment.enabled !== false
        && segment.timelineStart <= start
        && segment.timelineStart + segment.duration >= end);
    }

    const previous = composite.at(-1);
    if (!visible) {
      if (previous?.kind === 'gap' && previous.timelineStart + previous.duration === start) {
        previous.duration += end - start;
      } else {
        composite.push({
          id: `preview-gap-${start}`,
          kind: 'gap',
          name: 'Gap',
          timelineStart: start,
          duration: end - start,
          sourceStart: 0,
          available: false,
          gainDb: 0,
          enabled: true,
          markerCount: 0,
          effectCount: 0,
        });
      }
      continue;
    }

    const sourceStart = visible.sourceStart + start - visible.timelineStart;
    if (previous?.id === visible.id
      && previous.timelineStart + previous.duration === start
      && previous.sourceStart + previous.duration === sourceStart) {
      previous.duration += end - start;
      continue;
    }
    composite.push({
      ...visible,
      timelineStart: start,
      duration: end - start,
      sourceStart,
    });
  }
  return composite;
}

export function buildPreviewPlan(
  input: Project,
  revision: string,
  commitId: string,
  snapshotDigest: string,
  availability: Readonly<Record<string, PreviewMediaAvailability>>,
): PreviewPlan {
  const project = validateProject(input);
  const sequence = project.sequences[0];
  if (!sequence) throw new Error('Timeline has no sequence');
  const missing = new Map<string, string>();
  const tracks = sequence.trackIds
    .map((id) => project.tracks.find((candidate) => candidate.id === id))
    .filter((candidate): candidate is Track => candidate !== undefined)
    .map((track) => buildTrack(project, track, availability, missing));
  const videoTracks = tracks.filter((track) => track.kind === 'video');
  const video = videoTracks[0];
  const totalFrames = Math.max(0, ...tracks.map((track) => track.totalFrames));

  return {
    revision,
    commitId,
    snapshotDigest,
    fps: rationalToRate(sequence.fps),
    width: sequence.width,
    height: sequence.height,
    totalFrames,
    videoTrackName: video?.name ?? null,
    segments: videoTracks.length > 1
      ? compositeVideoTracks(videoTracks, totalFrames)
      : video?.segments ?? [],
    tracks,
    missingAssets: [...missing].map(([fingerprint, name]) => ({ fingerprint, name })),
  };
}

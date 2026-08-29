import { rationalToRate, validateProject, type Project, type Track } from '../domain';

export interface PreviewSegment {
  id: string;
  kind: 'clip' | 'gap' | 'caption';
  name: string;
  timelineStart: number;
  duration: number;
  sourceStart: number;
  assetFingerprint?: string;
  assetName?: string;
  mediaUrl?: string;
  available: boolean;
  gainDb: number;
  preset?: 'none' | 'warm' | 'cool' | 'mono';
  text?: string;
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
      });
      timelineStart += gap.durationFrames;
      continue;
    }
    const clip = clipById.get(itemId);
    if (!clip) continue;
    const asset = assetById.get(clip.assetId);
    if (!asset) continue;
    const media = availability[asset.fingerprint];
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
      gainDb: clip.gainDb,
      preset: clip.preset,
    };
    if (media?.mediaUrl) segment.mediaUrl = media.mediaUrl;
    segments.push(segment);
    if (!segment.available) missing.set(asset.fingerprint, asset.name);
    timelineStart += clip.sourceRange.duration;
  }

  const totalFrames = track.kind === 'caption'
    ? segments.reduce((total, segment) => Math.max(total, segment.timelineStart + segment.duration), 0)
    : timelineStart;
  return { id: track.id, name: track.name, kind: track.kind, totalFrames, segments };
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
  const video = tracks.find((track) => track.kind === 'video');

  return {
    revision,
    commitId,
    snapshotDigest,
    fps: rationalToRate(sequence.fps),
    width: sequence.width,
    height: sequence.height,
    totalFrames: Math.max(0, ...tracks.map(({ totalFrames }) => totalFrames)),
    videoTrackName: video?.name ?? null,
    segments: video?.segments ?? [],
    tracks,
    missingAssets: [...missing].map(([fingerprint, name]) => ({ fingerprint, name })),
  };
}

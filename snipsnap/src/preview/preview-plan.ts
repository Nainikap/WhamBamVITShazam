import { rationalToRate, validateProject, type Project } from '../domain';

export interface PreviewSegment {
  id: string;
  kind: 'clip' | 'gap';
  name: string;
  timelineStart: number;
  duration: number;
  sourceStart: number;
  assetFingerprint?: string;
  mediaUrl?: string;
  available: boolean;
  gainDb: number;
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
  segments: PreviewSegment[];
  missingAssets: Array<{ fingerprint: string; name: string }>;
}

export interface PreviewMediaAvailability {
  available: boolean;
  mediaUrl?: string;
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
  const track = sequence.trackIds
    .map((id) => project.tracks.find((candidate) => candidate.id === id))
    .find((candidate) => candidate?.kind === 'video');
  const clipById = new Map(project.clips.map((clip) => [clip.id, clip]));
  const gapById = new Map(project.gaps.map((gap) => [gap.id, gap]));
  const assetById = new Map(project.assets.map((asset) => [asset.id, asset]));
  const segments: PreviewSegment[] = [];
  const missing = new Map<string, string>();
  let timelineStart = 0;

  for (const itemId of track?.itemIds ?? []) {
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
      available: media?.available === true,
      gainDb: clip.gainDb,
    };
    if (media?.mediaUrl) segment.mediaUrl = media.mediaUrl;
    segments.push(segment);
    if (!segment.available) missing.set(asset.fingerprint, asset.name);
    timelineStart += clip.sourceRange.duration;
  }

  return {
    revision,
    commitId,
    snapshotDigest,
    fps: rationalToRate(sequence.fps),
    width: sequence.width,
    height: sequence.height,
    totalFrames: timelineStart,
    videoTrackName: track?.name ?? null,
    segments,
    missingAssets: [...missing].map(([fingerprint, name]) => ({ fingerprint, name })),
  };
}

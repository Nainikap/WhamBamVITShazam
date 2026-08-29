import type { PreviewPlan, PreviewSegment, PreviewTrack } from './preview-plan';

export type TimelineChange = 'unchanged' | 'added' | 'removed' | 'modified';

/** Every way a surviving timeline item can differ between two commits. */
export type TimelineChangeField =
  | 'trim' | 'position' | 'footage' | 'gain' | 'look' | 'name' | 'text'
  | 'enabled' | 'markers' | 'effects' | 'settings';

/**
 * A slice of one item's content. A trimmed clip becomes a kept part plus the
 * frames the trim dropped, so the lane shows exactly what left the cut.
 */
export type TimelinePartChange = 'kept' | 'added' | 'removed';

export interface TimelineDiffPart {
  change: TimelinePartChange;
  laneStart: number;
  laneDuration: number;
  /** Where these frames sit inside the source media. */
  contentStart: number;
}

export interface TimelineSegmentState {
  timelineStart: number;
  duration: number;
  sourceStart: number;
  gainDb: number;
  assetName?: string;
  preset?: string;
  text?: string;
}

export interface TimelineDiffSegment {
  id: string;
  kind: 'clip' | 'gap' | 'caption' | 'transition';
  name: string;
  change: TimelineChange;
  changedFields: TimelineChangeField[];
  /** True when the item's in/out point or its place on the timeline moved. */
  timingChanged: boolean;
  /** Placement inside the merged comparison lane, which holds items from both commits. */
  laneStart: number;
  laneDuration: number;
  /** The item split into kept, added, and removed frames. */
  parts: TimelineDiffPart[];
  addedFrames: number;
  removedFrames: number;
  available: boolean;
  before?: TimelineSegmentState;
  after?: TimelineSegmentState;
}

export interface TimelineDiffCounts {
  added: number;
  removed: number;
  modified: number;
  unchanged: number;
  /** Frames of footage that only one of the two commits holds. */
  addedFrames: number;
  removedFrames: number;
}

export interface TimelineDiffTrack {
  id: string;
  name: string;
  kind: 'video' | 'audio' | 'caption';
  change: TimelineChange;
  laneFrames: number;
  segments: TimelineDiffSegment[];
  counts: TimelineDiffCounts;
}

export interface TimelineDiff {
  baseCommit: string;
  headCommit: string;
  fps: number;
  laneFrames: number;
  tracks: TimelineDiffTrack[];
  counts: TimelineDiffCounts;
}

function state(segment: PreviewSegment): TimelineSegmentState {
  return {
    timelineStart: segment.timelineStart,
    duration: segment.duration,
    sourceStart: segment.sourceStart,
    gainDb: segment.gainDb,
    ...(segment.assetName === undefined ? {} : { assetName: segment.assetName }),
    ...(segment.preset === undefined ? {} : { preset: segment.preset }),
    ...(segment.text === undefined ? {} : { text: segment.text }),
  };
}

function changedFields(before: PreviewSegment, after: PreviewSegment): TimelineChangeField[] {
  const fields: TimelineChangeField[] = [];
  if (before.duration !== after.duration || before.sourceStart !== after.sourceStart) fields.push('trim');
  if (before.timelineStart !== after.timelineStart) fields.push('position');
  if (before.assetFingerprint !== after.assetFingerprint) fields.push('footage');
  if (before.gainDb !== after.gainDb) fields.push('gain');
  if (before.preset !== after.preset) fields.push('look');
  if (before.name !== after.name) fields.push('name');
  if (before.text !== after.text) fields.push('text');
  if (before.enabled !== after.enabled) fields.push('enabled');
  if (before.markerCount !== after.markerCount) fields.push('markers');
  if (before.effectCount !== after.effectCount) fields.push('effects');
  return fields;
}

/**
 * The interval an item covers in its own content space. For a clip that is the
 * range of source media it uses; for a caption it is where it sits in the
 * sequence; for a gap or transition it is simply its length.
 */
function contentInterval(segment: PreviewSegment): { start: number; end: number } {
  if (segment.kind === 'clip') {
    return { start: segment.sourceStart, end: segment.sourceStart + segment.duration };
  }
  if (segment.kind === 'caption') {
    return { start: segment.timelineStart, end: segment.timelineStart + segment.duration };
  }
  return { start: 0, end: segment.duration };
}

/**
 * Split an item into the frames both commits keep, the frames only the compared
 * commit has, and the frames only the base commit had.
 */
function splitParts(
  before: PreviewSegment | undefined,
  after: PreviewSegment | undefined,
  laneStart: number,
): { parts: TimelineDiffPart[]; addedFrames: number; removedFrames: number; laneDuration: number } {
  const baseSpan = before ? contentInterval(before) : null;
  const headSpan = after ? contentInterval(after) : null;
  const union = {
    start: Math.min(baseSpan?.start ?? Number.POSITIVE_INFINITY, headSpan?.start ?? Number.POSITIVE_INFINITY),
    end: Math.max(baseSpan?.end ?? Number.NEGATIVE_INFINITY, headSpan?.end ?? Number.NEGATIVE_INFINITY),
  };
  const boundaries = [...new Set([
    union.start,
    union.end,
    ...(baseSpan ? [baseSpan.start, baseSpan.end] : []),
    ...(headSpan ? [headSpan.start, headSpan.end] : []),
  ])].sort((left, right) => left - right);

  const parts: TimelineDiffPart[] = [];
  let addedFrames = 0;
  let removedFrames = 0;
  let cursor = laneStart;
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const start = boundaries[index] as number;
    const end = boundaries[index + 1] as number;
    const length = end - start;
    if (length <= 0) continue;
    const inBase = baseSpan !== null && start >= baseSpan.start && end <= baseSpan.end;
    const inHead = headSpan !== null && start >= headSpan.start && end <= headSpan.end;
    if (!inBase && !inHead) continue;
    const change: TimelinePartChange = inBase && inHead ? 'kept' : inHead ? 'added' : 'removed';
    if (change === 'added') addedFrames += length;
    if (change === 'removed') removedFrames += length;
    parts.push({ change, laneStart: cursor, laneDuration: length, contentStart: start });
    cursor += length;
  }

  return { parts, addedFrames, removedFrames, laneDuration: Math.max(cursor - laneStart, 1) };
}

/** Longest common subsequence of two identity sequences, used to align surviving items. */
function commonSubsequence(left: string[], right: string[]): string[] {
  const lengths: number[][] = Array.from(
    { length: left.length + 1 },
    () => new Array<number>(right.length + 1).fill(0),
  );
  for (let leftIndex = left.length - 1; leftIndex >= 0; leftIndex -= 1) {
    for (let rightIndex = right.length - 1; rightIndex >= 0; rightIndex -= 1) {
      const row = lengths[leftIndex] as number[];
      const nextRow = lengths[leftIndex + 1] as number[];
      row[rightIndex] = left[leftIndex] === right[rightIndex]
        ? (nextRow[rightIndex + 1] as number) + 1
        : Math.max(nextRow[rightIndex] as number, row[rightIndex + 1] as number);
    }
  }
  const result: string[] = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    if (left[leftIndex] === right[rightIndex]) {
      result.push(left[leftIndex] as string);
      leftIndex += 1;
      rightIndex += 1;
    } else if ((lengths[leftIndex + 1]?.[rightIndex] ?? 0) >= (lengths[leftIndex]?.[rightIndex + 1] ?? 0)) {
      leftIndex += 1;
    } else {
      rightIndex += 1;
    }
  }
  return result;
}

/** Interleave both item orders into one lane so removed items keep their editorial place. */
function alignIds(baseIds: string[], headIds: string[]): string[] {
  const anchors = commonSubsequence(baseIds, headIds);
  const lane: string[] = [];
  let baseIndex = 0;
  let headIndex = 0;
  for (const anchor of anchors) {
    while (baseIndex < baseIds.length && baseIds[baseIndex] !== anchor) {
      lane.push(baseIds[baseIndex] as string);
      baseIndex += 1;
    }
    while (headIndex < headIds.length && headIds[headIndex] !== anchor) {
      lane.push(headIds[headIndex] as string);
      headIndex += 1;
    }
    lane.push(anchor);
    baseIndex += 1;
    headIndex += 1;
  }
  lane.push(...baseIds.slice(baseIndex), ...headIds.slice(headIndex));
  return [...new Set(lane)];
}

function tally(segments: TimelineDiffSegment[]): TimelineDiffCounts {
  return {
    added: segments.filter(({ change }) => change === 'added').length,
    removed: segments.filter(({ change }) => change === 'removed').length,
    modified: segments.filter(({ change }) => change === 'modified').length,
    unchanged: segments.filter(({ change }) => change === 'unchanged').length,
    addedFrames: segments.reduce((total, segment) => total + segment.addedFrames, 0),
    removedFrames: segments.reduce((total, segment) => total + segment.removedFrames, 0),
  };
}

function diffTrack(
  base: PreviewTrack | undefined,
  head: PreviewTrack | undefined,
): TimelineDiffTrack | null {
  const identity = head ?? base;
  if (!identity) return null;
  const baseSegments = new Map((base?.segments ?? []).map((segment) => [segment.id, segment]));
  const headSegments = new Map((head?.segments ?? []).map((segment) => [segment.id, segment]));
  const absolute = identity.kind === 'caption';
  const lane = alignIds(
    (base?.segments ?? []).map(({ id }) => id),
    (head?.segments ?? []).map(({ id }) => id),
  );

  let cursor = 0;
  const segments = lane.map((id): TimelineDiffSegment => {
    const before = baseSegments.get(id);
    const after = headSegments.get(id);
    const present = after ?? before as PreviewSegment;
    const fields = before && after ? changedFields(before, after) : [];
    const change: TimelineChange = !before ? 'added'
      : !after ? 'removed'
        : fields.length > 0 ? 'modified' : 'unchanged';
    const laneStart = absolute ? present.timelineStart : cursor;
    const split = splitParts(before, after, laneStart);
    if (!absolute) cursor += split.laneDuration;
    return {
      id,
      kind: present.kind,
      name: present.name,
      change,
      changedFields: fields,
      timingChanged: fields.includes('trim') || fields.includes('position'),
      laneStart,
      laneDuration: split.laneDuration,
      parts: split.parts,
      addedFrames: split.addedFrames,
      removedFrames: split.removedFrames,
      available: present.available,
      ...(before ? { before: state(before) } : {}),
      ...(after ? { after: state(after) } : {}),
    };
  });

  return {
    id: identity.id,
    name: identity.name,
    kind: identity.kind,
    change: !base ? 'added' : !head ? 'removed'
      : segments.some((segment) => segment.change !== 'unchanged') || base.name !== head.name ? 'modified' : 'unchanged',
    laneFrames: Math.max(0, ...segments.map(({ laneStart, laneDuration }) => laneStart + laneDuration)),
    segments,
    counts: tally(segments),
  };
}

/**
 * Compare two committed timelines lane by lane so the split view can highlight
 * added footage, removed footage, and retimed items on video and audio tracks.
 */
export function buildTimelineDiff(base: PreviewPlan, head: PreviewPlan): TimelineDiff {
  const baseTracks = new Map(base.tracks.map((track) => [track.id, track]));
  const headTracks = new Map(head.tracks.map((track) => [track.id, track]));
  const order = [...new Set([...head.tracks.map(({ id }) => id), ...base.tracks.map(({ id }) => id)])];
  const tracks = order
    .map((id) => diffTrack(baseTracks.get(id), headTracks.get(id)))
    .filter((track): track is TimelineDiffTrack => track !== null)
    .sort((left, right) => {
      const weight = { video: 0, audio: 1, caption: 2 };
      return weight[left.kind] - weight[right.kind] || left.name.localeCompare(right.name);
    });
  const everySegment = tracks.flatMap(({ segments }) => segments);

  return {
    baseCommit: base.commitId,
    headCommit: head.commitId,
    fps: head.fps,
    laneFrames: Math.max(0, ...tracks.map(({ laneFrames }) => laneFrames)),
    tracks,
    counts: tally(everySegment),
  };
}

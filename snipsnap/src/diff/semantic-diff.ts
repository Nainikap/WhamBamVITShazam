import {
  cloneProject,
  compareCanonicalKeys,
  digestText,
  projectDigest,
  validateProject,
  type FrameRange,
  type Project,
} from '../domain';

export type EntityType = 'project' | 'sequence' | 'track' | 'asset' | 'clip' | 'gap' | 'transition' | 'caption';
export type HunkOperation = 'add' | 'delete' | 'modify' | 'reorder';

export interface SemanticHunk {
  id: string;
  baseDigest: string;
  entityType: EntityType;
  entityId: string;
  operation: HunkOperation;
  fieldGroup: string;
  before: unknown;
  after: unknown;
  parentId?: string;
  orderIndex?: number;
  /** Position in the canonical entity collection, needed for exact reversal. */
  collectionIndex?: number;
  message: string;
  affectedFrameRange?: FrameRange;
  /** Primitive edits that must stage together to keep the timeline valid. */
  parts?: SemanticHunk[];
}

type Entity = Record<string, unknown> & { id: string };
type CollectionKey = Exclude<EntityType, 'project'>;

const collectionKeys: Record<CollectionKey, keyof Project> = {
  sequence: 'sequences',
  track: 'tracks',
  asset: 'assets',
  clip: 'clips',
  gap: 'gaps',
  transition: 'transitions',
  caption: 'captions',
};

/** Everything the editor can change, so nothing moves without a hunk. */
const decorationGroups = [['enabled'], ['markers'], ['effects'], ['extras']];
const fieldGroups: Record<CollectionKey, string[][]> = {
  sequence: [['name'], ['fps'], ['width', 'height'], ['trackIds'], ['globalStartFrame'], ['markers'], ['extras']],
  track: [['name'], ['kind'], ['itemIds'], ...decorationGroups],
  asset: [['name'], ['fingerprint'], ['durationFrames'], ['extras']],
  clip: [['name'], ['assetId'], ['sourceRange'], ['gainDb'], ['preset'], ['trackId'], ['color'], ...decorationGroups],
  gap: [['durationFrames'], ['trackId'], ...decorationGroups],
  transition: [['name'], ['transitionType'], ['inOffsetFrames'], ['outOffsetFrames'], ['trackId'], ...decorationGroups],
  caption: [['text'], ['range'], ['style'], ['trackId'], ...decorationGroups],
};

const fieldLabels: Record<string, string> = {
  enabled: 'enabled state',
  markers: 'markers',
  effects: 'effects',
  extras: 'editor settings',
  color: 'colour label',
  globalStartFrame: 'timeline start',
  transitionType: 'transition type',
  inOffsetFrames: 'incoming handle',
  outOffsetFrames: 'outgoing handle',
  gainDb: 'level',
  preset: 'look',
  fps: 'frame rate',
  assetId: 'source footage',
  fingerprint: 'media identity',
  durationFrames: 'duration',
};

function countChange(before: unknown, after: unknown): string {
  const beforeLength = Array.isArray(before) ? before.length : 0;
  const afterLength = Array.isArray(after) ? after.length : 0;
  if (afterLength > beforeLength) return `added ${afterLength - beforeLength}`;
  if (afterLength < beforeLength) return `removed ${beforeLength - afterLength}`;
  return 'changed';
}

function stableValue(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => compareCanonicalKeys(left, right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableValue(item)}`)
    .join(',')}}`;
}

function same(left: unknown, right: unknown): boolean {
  return stableValue(left) === stableValue(right);
}

function groupValue(entity: Entity, fields: string[]): unknown {
  return fields.length === 1
    ? entity[fields[0] as string]
    : Object.fromEntries(fields.map((field) => [field, entity[field]]));
}

function relation(project: Project, type: CollectionKey, id: string): Record<string, never> | { parentId: string; orderIndex: number } {
  if (type === 'track') {
    const track = project.tracks.find((candidate) => candidate.id === id);
    const sequence = project.sequences.find((candidate) => candidate.id === track?.sequenceId);
    if (sequence) return { parentId: sequence.id, orderIndex: sequence.trackIds.indexOf(id) };
  }
  if (type === 'clip' || type === 'gap' || type === 'transition' || type === 'caption') {
    const items = project[collectionKeys[type]] as unknown as Array<Entity & { trackId: string }>;
    const item = items.find((candidate) => candidate.id === id);
    if (item && 'trackId' in item) {
      const track = project.tracks.find((candidate) => candidate.id === item.trackId);
      if (track) return { parentId: track.id, orderIndex: track.itemIds.indexOf(id) };
    }
  }
  return {};
}

function describe(
  type: CollectionKey,
  operation: HunkOperation,
  entity: Entity,
  fields: string[],
  before?: unknown,
  after?: unknown,
): string {
  const label = typeof entity.name === 'string'
    ? entity.name
    : typeof entity.text === 'string' ? `“${entity.text.slice(0, 32)}”` : entity.id.slice(0, 8);
  if (operation === 'add') return `Added ${type} ${label}`;
  if (operation === 'delete') return `Deleted ${type} ${label}`;
  if (operation === 'reorder') return `Reordered ${type} ${label}`;
  if (type === 'clip' && fields.includes('sourceRange')) {
    const previous = before as FrameRange;
    const next = after as FrameRange;
    const previousEnd = previous.start + previous.duration;
    const nextEnd = next.start + next.duration;
    if (previous.duration === next.duration && previous.start !== next.start) {
      const frames = Math.abs(next.start - previous.start);
      return `Slipped clip ${label} ${next.start > previous.start ? 'forward' : 'back'} by ${frames} frame${frames === 1 ? '' : 's'}`;
    }
    const startDelta = next.start - previous.start;
    const endDelta = previousEnd - nextEnd;
    if (startDelta >= 0 && endDelta >= 0 && (startDelta > 0 || endDelta > 0)) {
      if (startDelta > 0 && endDelta > 0) return `Trimmed both ends of clip ${label}`;
      const frames = startDelta || endDelta;
      return `Trimmed ${startDelta > 0 ? 'start' : 'end'} of clip ${label} by ${frames} frame${frames === 1 ? '' : 's'}`;
    }
    if (startDelta <= 0 && endDelta <= 0 && (startDelta < 0 || endDelta < 0)) {
      if (startDelta < 0 && endDelta < 0) return `Extended both ends of clip ${label}`;
      const frames = Math.abs(startDelta || endDelta);
      return `Extended ${startDelta < 0 ? 'start' : 'end'} of clip ${label} by ${frames} frame${frames === 1 ? '' : 's'}`;
    }
    return `Changed source range of clip ${label}`;
  }
  if (type === 'caption' && fields.includes('range')) return `Retimed caption ${label}`;
  if (type === 'caption' && fields.includes('text')) return `Changed caption text ${label}`;
  if (fields.includes('markers')) return `${countChange(before, after)} markers on ${type} ${label}`;
  if (fields.includes('effects')) return `${countChange(before, after)} effects on ${type} ${label}`;
  if (fields.includes('enabled')) return `${after === true ? 'Enabled' : 'Disabled'} ${type} ${label}`;
  if (type === 'gap' && fields.includes('durationFrames')) {
    const delta = Number(after) - Number(before);
    const frames = Math.abs(delta);
    return `${delta < 0 ? 'Shortened' : 'Extended'} gap by ${frames} frame${frames === 1 ? '' : 's'}`;
  }
  if (fields.includes('extras')) return `Changed editor settings on ${type} ${label}`;
  const readable = fields.map((field) => fieldLabels[field] ?? field).join(' + ');
  return `Changed ${type} ${label}: ${readable}`;
}

function rangeFor(type: CollectionKey, entity: Entity): FrameRange | undefined {
  const value = type === 'clip' ? entity.sourceRange : type === 'caption' ? entity.range : undefined;
  if (value && typeof value === 'object' && 'start' in value && 'duration' in value) return value as FrameRange;
  return undefined;
}

function createHunk(input: Omit<SemanticHunk, 'id'>): SemanticHunk {
  const identity = stableValue([
    input.baseDigest,
    input.entityType,
    input.entityId,
    input.operation,
    input.fieldGroup,
    input.before,
    input.after,
    input.collectionIndex,
    input.parts?.map(({ id }) => id),
  ]);
  return { ...input, id: digestText(identity) };
}

function entitySide(hunk: SemanticHunk): Entity | undefined {
  const value = hunk.operation === 'delete' ? hunk.before : hunk.after;
  return value && typeof value === 'object' && 'id' in value ? value as Entity : undefined;
}

function rangeEnd(range: FrameRange): number {
  return range.start + range.duration;
}

function partitionsRange(whole: FrameRange, pieces: FrameRange[]): boolean {
  const ordered = [...pieces].sort((left, right) => left.start - right.start);
  let cursor = whole.start;
  for (const piece of ordered) {
    if (piece.start !== cursor || piece.duration <= 0) return false;
    cursor = rangeEnd(piece);
  }
  return cursor === rangeEnd(whole);
}

function connectedOnTrack(project: Project, trackId: string, ids: string[]): boolean {
  const track = project.tracks.find(({ id }) => id === trackId);
  if (!track) return false;
  const indexes = ids.map((id) => track.itemIds.indexOf(id)).sort((left, right) => left - right);
  return indexes.every((index, position) => index >= 0 && (position === 0 || index === (indexes[position - 1] as number) + 1));
}

function compoundHunk(input: {
  baseDigest: string;
  parts: SemanticHunk[];
  entityType: EntityType;
  entityId: string;
  operation: HunkOperation;
  fieldGroup: string;
  message: string;
  affectedFrameRange?: FrameRange;
}): SemanticHunk {
  return createHunk({
    baseDigest: input.baseDigest,
    entityType: input.entityType,
    entityId: input.entityId,
    operation: input.operation,
    fieldGroup: input.fieldGroup,
    before: input.parts.map(({ entityType, entityId, fieldGroup, before }) => ({ entityType, entityId, fieldGroup, value: before })),
    after: input.parts.map(({ entityType, entityId, fieldGroup, after }) => ({ entityType, entityId, fieldGroup, value: after })),
    message: input.message,
    parts: input.parts,
    ...(input.affectedFrameRange ? { affectedFrameRange: input.affectedFrameRange } : {}),
  });
}

function clipTimelineStart(project: Project, clip: Project['clips'][number]): number | undefined {
  const track = project.tracks.find(({ id }) => id === clip.trackId);
  if (!track) return undefined;
  const clips = new Map(project.clips.map((item) => [item.id, item]));
  const gaps = new Map(project.gaps.map((item) => [item.id, item]));
  let cursor = 0;
  for (const itemId of track.itemIds) {
    if (itemId === clip.id) return cursor;
    const precedingClip = clips.get(itemId);
    if (precedingClip) cursor += precedingClip.sourceRange.duration;
    else cursor += gaps.get(itemId)?.durationFrames ?? 0;
  }
  return undefined;
}

function itemPrecedesClip(project: Project, itemId: string, clip: Project['clips'][number]): boolean {
  const track = project.tracks.find(({ id }) => id === clip.trackId);
  if (!track) return false;
  const itemIndex = track.itemIds.indexOf(itemId);
  const clipIndex = track.itemIds.indexOf(clip.id);
  return itemIndex >= 0 && clipIndex >= 0 && itemIndex < clipIndex;
}

function clipFingerprint(project: Project, clip: Project['clips'][number]): string | undefined {
  return project.assets.find(({ id }) => id === clip.assetId)?.fingerprint;
}

function groupTimelineMoves(
  base: Project,
  candidate: Project,
  hunks: SemanticHunk[],
): { grouped: SemanticHunk[]; remaining: SemanticHunk[] } {
  type TimelineMove = {
    beforeClip: Project['clips'][number];
    afterClip: Project['clips'][number];
    beforeStart: number;
    afterStart: number;
    partIds: Set<string>;
  };
  const dependencies = (
    beforeClip: Project['clips'][number],
    afterClip: Project['clips'][number],
  ): Set<string> => new Set(hunks.filter((hunk) => {
    if (hunk.entityType === 'gap') {
      return itemPrecedesClip(base, hunk.entityId, beforeClip)
        || itemPrecedesClip(candidate, hunk.entityId, afterClip);
    }
    if (hunk.entityType === 'track' && hunk.fieldGroup === 'itemIds') {
      return hunk.entityId === beforeClip.trackId || hunk.entityId === afterClip.trackId;
    }
    if (hunk.entityType !== 'clip') return false;
    if (beforeClip.id !== afterClip.id) {
      return (hunk.operation === 'delete' && hunk.entityId === beforeClip.id)
        || (hunk.operation === 'add' && hunk.entityId === afterClip.id);
    }
    return hunk.entityId === beforeClip.id && hunk.fieldGroup === 'trackId';
  }).map(({ id }) => id));
  const createMove = (
    beforeClip: Project['clips'][number],
    afterClip: Project['clips'][number],
  ): TimelineMove | undefined => {
    const beforeStart = clipTimelineStart(base, beforeClip);
    const afterStart = clipTimelineStart(candidate, afterClip);
    if (beforeStart === undefined || afterStart === undefined
      || (beforeStart === afterStart && beforeClip.trackId === afterClip.trackId)) return undefined;
    const partIds = dependencies(beforeClip, afterClip);
    return partIds.size === 0 ? undefined : { beforeClip, afterClip, beforeStart, afterStart, partIds };
  };

  const moves: TimelineMove[] = base.clips.flatMap((beforeClip) => {
    const afterClip = candidate.clips.find(({ id }) => id === beforeClip.id);
    const move = afterClip ? createMove(beforeClip, afterClip) : undefined;
    return move ? [move] : [];
  });
  const unmatchedAfter = candidate.clips.filter((clip) => !base.clips.some(({ id }) => id === clip.id));
  const usedAfter = new Set<string>();
  for (const beforeClip of base.clips.filter((clip) => !candidate.clips.some(({ id }) => id === clip.id))) {
    const beforeStart = clipTimelineStart(base, beforeClip);
    if (beforeStart === undefined) continue;
    const compatible = unmatchedAfter
      .filter((afterClip) => !usedAfter.has(afterClip.id)
        && clipFingerprint(base, beforeClip) === clipFingerprint(candidate, afterClip)
        && beforeClip.name === afterClip.name
        && same(beforeClip.sourceRange, afterClip.sourceRange))
      .map((afterClip) => ({ afterClip, afterStart: clipTimelineStart(candidate, afterClip) }))
      .filter((item): item is { afterClip: Project['clips'][number]; afterStart: number } => item.afterStart !== undefined)
      .sort((left, right) => {
        const leftPenalty = left.afterClip.trackId === beforeClip.trackId ? 0 : 1_000;
        const rightPenalty = right.afterClip.trackId === beforeClip.trackId ? 0 : 1_000;
        return leftPenalty + Math.abs(left.afterStart - beforeStart)
          - rightPenalty - Math.abs(right.afterStart - beforeStart);
      });
    const match = compatible[0];
    if (!match) continue;
    const move = createMove(beforeClip, match.afterClip);
    if (!move) continue;
    usedAfter.add(match.afterClip.id);
    moves.push(move);
  }

  const parents = moves.map((_, index) => index);
  const find = (index: number): number => {
    if (parents[index] === index) return index;
    const root = find(parents[index] as number);
    parents[index] = root;
    return root;
  };
  const unite = (left: number, right: number) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
  };
  for (let left = 0; left < moves.length; left += 1) {
    for (let right = left + 1; right < moves.length; right += 1) {
      const first = moves[left];
      const second = moves[right];
      if (!first || !second) continue;
      const sharedDependency = [...first.partIds].some((id) => second.partIds.has(id));
      const linkedMedia = first.beforeClip.assetId === second.beforeClip.assetId
        && first.beforeClip.name === second.beforeClip.name
        && same(first.beforeClip.sourceRange, second.beforeClip.sourceRange)
        && first.beforeStart === second.beforeStart
        && first.afterStart === second.afterStart;
      if (sharedDependency || linkedMedia) unite(left, right);
    }
  }

  const components = new Map<number, typeof moves>();
  moves.forEach((move, index) => components.set(find(index), [...components.get(find(index)) ?? [], move]));
  const consumed = new Set<string>();
  const grouped: SemanticHunk[] = [];
  for (const component of components.values()) {
    const ordered = [...component].sort((left, right) => compareCanonicalKeys(left.beforeClip.id, right.beforeClip.id));
    const primary = ordered[0];
    if (!primary) continue;
    const partIds = new Set(ordered.flatMap(({ partIds: ids }) => [...ids]));
    const parts = hunks.filter(({ id }) => partIds.has(id));
    if (parts.length === 0 || parts.some(({ id }) => consumed.has(id))) continue;
    parts.forEach(({ id }) => consumed.add(id));
    const deltas = new Set(ordered.map(({ beforeStart, afterStart }) => afterStart - beforeStart));
    const labels = new Set(ordered.map(({ beforeClip }) => beforeClip.name));
    const delta = primary.afterStart - primary.beforeStart;
    const timing = delta === 0
      ? 'to another track'
      : `${Math.abs(delta)} frame${Math.abs(delta) === 1 ? '' : 's'} ${delta < 0 ? 'earlier' : 'later'}`;
    const linked = ordered.length > 1 && labels.size === 1 && deltas.size === 1;
    const message = linked
      ? `Moved linked clip ${primary.beforeClip.name} ${timing} across ${ordered.length} tracks`
      : ordered.length === 1
        ? `Moved clip ${primary.beforeClip.name} ${timing}`
        : `Repositioned ${ordered.length} clips on the timeline`;
    const rangeStart = Math.min(...ordered.flatMap(({ beforeStart, afterStart }) => [beforeStart, afterStart]));
    const rangeEndFrame = Math.max(...ordered.flatMap(({ beforeClip, afterClip, beforeStart, afterStart }) => [
      beforeStart + beforeClip.sourceRange.duration,
      afterStart + afterClip.sourceRange.duration,
    ]));
    grouped.push(compoundHunk({
      baseDigest: parts[0]?.baseDigest ?? projectDigest(base),
      parts,
      entityType: 'clip',
      entityId: ordered
        .flatMap(({ beforeClip, afterClip }) => [beforeClip.id, afterClip.id])
        .sort(compareCanonicalKeys)[0] as string,
      operation: 'modify',
      fieldGroup: 'timelinePosition',
      message,
      affectedFrameRange: { start: rangeStart, duration: Math.max(1, rangeEndFrame - rangeStart) },
    }));
  }
  return { grouped, remaining: hunks.filter(({ id }) => !consumed.has(id)) };
}

function groupClipSplits(
  base: Project,
  candidate: Project,
  hunks: SemanticHunk[],
): { grouped: SemanticHunk[]; remaining: SemanticHunk[] } {
  const consumed = new Set<string>();
  const grouped: SemanticHunk[] = [];
  const additions = hunks.filter(({ entityType, operation }) => entityType === 'clip' && operation === 'add');
  const deletions = hunks.filter(({ entityType, operation }) => entityType === 'clip' && operation === 'delete');

  for (const modified of hunks.filter(({ entityType, operation, fieldGroup }) => (
    entityType === 'clip' && operation === 'modify' && fieldGroup === 'sourceRange'
  ))) {
    if (consumed.has(modified.id)) continue;
    const beforeClip = base.clips.find(({ id }) => id === modified.entityId);
    const afterClip = candidate.clips.find(({ id }) => id === modified.entityId);
    if (!beforeClip || !afterClip) continue;
    const compatible = (hunk: SemanticHunk, side: 'before' | 'after') => {
      const clip = (side === 'before' ? hunk.before : hunk.after) as Project['clips'][number];
      return clip.trackId === beforeClip.trackId
        && clip.assetId === beforeClip.assetId
        && clip.name === beforeClip.name;
    };

    const added = additions.filter((hunk) => !consumed.has(hunk.id) && compatible(hunk, 'after'));
    const splitPieces = [afterClip, ...added.map(({ after }) => after as Project['clips'][number])];
    if (added.length > 0
      && partitionsRange(beforeClip.sourceRange, splitPieces.map(({ sourceRange }) => sourceRange))
      && connectedOnTrack(candidate, afterClip.trackId, splitPieces.map(({ id }) => id))) {
      const parts = [modified, ...added];
      parts.forEach(({ id }) => consumed.add(id));
      grouped.push(compoundHunk({
        baseDigest: modified.baseDigest,
        parts,
        entityType: 'clip',
        entityId: modified.entityId,
        operation: 'modify',
        fieldGroup: 'split',
        message: `Split clip ${beforeClip.name} into ${splitPieces.length} clips`,
        affectedFrameRange: beforeClip.sourceRange,
      }));
      continue;
    }

    const deleted = deletions.filter((hunk) => !consumed.has(hunk.id) && compatible(hunk, 'before'));
    const joinedPieces = [beforeClip, ...deleted.map(({ before }) => before as Project['clips'][number])];
    if (deleted.length > 0
      && partitionsRange(afterClip.sourceRange, joinedPieces.map(({ sourceRange }) => sourceRange))
      && connectedOnTrack(base, beforeClip.trackId, joinedPieces.map(({ id }) => id))) {
      const parts = [modified, ...deleted];
      parts.forEach(({ id }) => consumed.add(id));
      grouped.push(compoundHunk({
        baseDigest: modified.baseDigest,
        parts,
        entityType: 'clip',
        entityId: modified.entityId,
        operation: 'modify',
        fieldGroup: 'split',
        message: `Joined ${joinedPieces.length} clips into ${afterClip.name}`,
        affectedFrameRange: afterClip.sourceRange,
      }));
    }
  }
  return { grouped, remaining: hunks.filter(({ id }) => !consumed.has(id)) };
}

function groupStructuralDependencies(baseDigest: string, hunks: SemanticHunk[]): SemanticHunk[] {
  const candidates = hunks.filter(({ operation }) => operation === 'add' || operation === 'delete');
  const parent = new Map(candidates.map(({ id }) => [id, id]));
  const find = (id: string): string => {
    const next = parent.get(id) as string;
    if (next === id) return id;
    const root = find(next);
    parent.set(id, root);
    return root;
  };
  const unite = (left: SemanticHunk, right: SemanticHunk) => {
    const leftRoot = find(left.id);
    const rightRoot = find(right.id);
    if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot);
  };

  for (const hunk of candidates) {
    const entity = entitySide(hunk);
    if (!entity) continue;
    if (hunk.entityType === 'sequence') {
      const trackIds = entity.trackIds as string[];
      candidates.filter((item) => item.operation === hunk.operation && item.entityType === 'track'
        && trackIds.includes(item.entityId)).forEach((item) => unite(hunk, item));
    }
    if (hunk.entityType === 'track') {
      const itemIds = entity.itemIds as string[];
      candidates.filter((item) => item.operation === hunk.operation
        && ['clip', 'gap', 'transition', 'caption'].includes(item.entityType)
        && itemIds.includes(item.entityId)).forEach((item) => unite(hunk, item));
    }
    if (hunk.entityType === 'asset') {
      candidates.filter((item) => item.operation === hunk.operation && item.entityType === 'clip'
        && String(entitySide(item)?.assetId) === hunk.entityId).forEach((item) => unite(hunk, item));
    }
  }

  const components = new Map<string, SemanticHunk[]>();
  for (const hunk of candidates) components.set(find(hunk.id), [...components.get(find(hunk.id)) ?? [], hunk]);
  const groupedIds = new Set<string>();
  const groups: SemanticHunk[] = [];
  const priority: EntityType[] = ['sequence', 'track', 'clip', 'caption', 'gap', 'transition', 'asset', 'project'];
  for (const parts of components.values()) {
    if (parts.length < 2) continue;
    parts.forEach(({ id }) => groupedIds.add(id));
    const primary = [...parts].sort((left, right) => priority.indexOf(left.entityType) - priority.indexOf(right.entityType))[0] as SemanticHunk;
    const entity = entitySide(primary) as Entity;
    const label = typeof entity.name === 'string' ? entity.name : primary.entityId.slice(0, 8);
    const verb = primary.operation === 'add' ? 'Added' : 'Deleted';
    const itemCount = parts.filter(({ entityType }) => ['clip', 'gap', 'transition', 'caption'].includes(entityType)).length;
    const message = primary.entityType === 'track'
      ? `${verb} track ${label} with ${itemCount} timeline item${itemCount === 1 ? '' : 's'}`
      : primary.entityType === 'clip'
        ? `${verb} clip ${label} with its media`
        : `${verb} related ${primary.entityType} data for ${label}`;
    groups.push(compoundHunk({
      baseDigest,
      parts,
      entityType: primary.entityType,
      entityId: primary.entityId,
      operation: primary.operation,
      fieldGroup: 'structure',
      message,
      ...(primary.affectedFrameRange ? { affectedFrameRange: primary.affectedFrameRange } : {}),
    }));
  }
  return [...hunks.filter(({ id }) => !groupedIds.has(id)), ...groups];
}

export function semanticDiff(baseInput: Project, candidateInput: Project): SemanticHunk[] {
  const base = validateProject(baseInput);
  const candidate = validateProject(candidateInput);
  const baseDigest = projectDigest(base);
  const hunks: SemanticHunk[] = [];

  if (base.name !== candidate.name) {
    hunks.push(createHunk({
      baseDigest,
      entityType: 'project',
      entityId: base.id,
      operation: 'modify',
      fieldGroup: 'name',
      before: base.name,
      after: candidate.name,
      message: `Renamed project ${base.name} to ${candidate.name}`,
    }));
  }
  if (!same(base.extras, candidate.extras)) {
    hunks.push(createHunk({
      baseDigest,
      entityType: 'project',
      entityId: base.id,
      operation: 'modify',
      fieldGroup: 'extras',
      before: base.extras,
      after: candidate.extras,
      message: 'Changed timeline-wide editor settings',
    }));
  }

  (Object.keys(collectionKeys) as CollectionKey[]).forEach((type) => {
    const key = collectionKeys[type];
    const beforeEntities = base[key] as unknown as Entity[];
    const afterEntities = candidate[key] as unknown as Entity[];
    const beforeById = new Map(beforeEntities.map((entity) => [entity.id, entity]));
    const afterById = new Map(afterEntities.map((entity) => [entity.id, entity]));

    for (const [collectionIndex, entity] of beforeEntities.entries()) {
      if (!afterById.has(entity.id)) {
        const related = relation(base, type, entity.id);
        const affected = rangeFor(type, entity);
        hunks.push(createHunk({
          baseDigest,
          entityType: type,
          entityId: entity.id,
          operation: 'delete',
          fieldGroup: 'entity',
          before: entity,
          after: null,
          collectionIndex,
          ...related,
          message: describe(type, 'delete', entity, []),
          ...(affected === undefined ? {} : { affectedFrameRange: affected }),
        }));
      }
    }
    for (const [collectionIndex, entity] of afterEntities.entries()) {
      const before = beforeById.get(entity.id);
      if (!before) {
        const related = relation(candidate, type, entity.id);
        const affected = rangeFor(type, entity);
        hunks.push(createHunk({
          baseDigest,
          entityType: type,
          entityId: entity.id,
          operation: 'add',
          fieldGroup: 'entity',
          before: null,
          after: entity,
          collectionIndex,
          ...related,
          message: describe(type, 'add', entity, []),
          ...(affected === undefined ? {} : { affectedFrameRange: affected }),
        }));
        continue;
      }
      for (const fields of fieldGroups[type]) {
        if ((type === 'track' && fields[0] === 'itemIds') || (type === 'sequence' && fields[0] === 'trackIds')) {
          const commonIds = type === 'track'
            ? new Set([
              ...base.clips, ...base.gaps, ...base.transitions, ...base.captions,
            ].map(({ id }) => id).filter((id) => [
              ...candidate.clips, ...candidate.gaps, ...candidate.transitions, ...candidate.captions,
            ].some((item) => item.id === id)))
            : new Set(base.tracks.map(({ id }) => id).filter((id) => candidate.tracks.some((track) => track.id === id)));
          const beforeOrder = (groupValue(before, fields) as string[]).filter((id) => commonIds.has(id));
          const afterOrder = (groupValue(entity, fields) as string[]).filter((id) => commonIds.has(id));
          if (!same(beforeOrder, afterOrder)) {
            hunks.push(createHunk({
              baseDigest,
              entityType: type,
              entityId: entity.id,
              operation: 'reorder',
              fieldGroup: fields.join('+'),
              before: groupValue(before, fields),
              after: groupValue(entity, fields),
              message: describe(type, 'reorder', entity, fields),
            }));
          }
          continue;
        }
        const beforeValue = groupValue(before, fields);
        const afterValue = groupValue(entity, fields);
        if (!same(beforeValue, afterValue)) {
          const affected = rangeFor(type, entity);
          hunks.push(createHunk({
            baseDigest,
            entityType: type,
            entityId: entity.id,
            operation: 'modify',
            fieldGroup: fields.join('+'),
            before: beforeValue,
            after: afterValue,
            message: describe(type, 'modify', entity, fields, beforeValue, afterValue),
            ...(affected === undefined ? {} : { affectedFrameRange: affected }),
          }));
        }
      }
    }
  });

  const splitGroups = groupClipSplits(base, candidate, hunks);
  const moveGroups = groupTimelineMoves(base, candidate, splitGroups.remaining);
  return [...splitGroups.grouped, ...moveGroups.grouped, ...groupStructuralDependencies(baseDigest, moveGroups.remaining)]
    .sort((left, right) => compareCanonicalKeys(left.message, right.message) || compareCanonicalKeys(left.id, right.id));
}

function collection(project: Project, type: CollectionKey): Entity[] {
  return project[collectionKeys[type]] as unknown as Entity[];
}

function applyHunk(project: Project, hunk: SemanticHunk): void {
  if (hunk.parts) {
    for (const part of hunk.parts) applyHunk(project, part);
    return;
  }
  if (hunk.entityType === 'project') {
    if (hunk.fieldGroup === 'extras') project.extras = hunk.after as Project['extras'];
    else project.name = String(hunk.after);
    return;
  }
  const values = collection(project, hunk.entityType);
  const index = values.findIndex(({ id }) => id === hunk.entityId);
  if (hunk.operation === 'add') {
    values.splice(Math.min(hunk.collectionIndex ?? values.length, values.length), 0, hunk.after as Entity);
    if (hunk.entityType === 'track' && hunk.parentId) {
      const sequence = project.sequences.find(({ id }) => id === hunk.parentId);
      if (sequence && !sequence.trackIds.includes(hunk.entityId)) {
        sequence.trackIds.splice(hunk.orderIndex ?? sequence.trackIds.length, 0, hunk.entityId);
      }
    } else if ((hunk.entityType === 'clip' || hunk.entityType === 'gap'
      || hunk.entityType === 'transition' || hunk.entityType === 'caption') && hunk.parentId) {
      const track = project.tracks.find(({ id }) => id === hunk.parentId);
      if (track && !track.itemIds.includes(hunk.entityId)) {
        track.itemIds.splice(hunk.orderIndex ?? track.itemIds.length, 0, hunk.entityId);
      }
    }
    return;
  }
  if (index < 0) throw new Error(`Cannot apply hunk: ${hunk.entityType} ${hunk.entityId} is missing`);
  if (hunk.operation === 'delete') {
    values.splice(index, 1);
    for (const sequence of project.sequences) sequence.trackIds = sequence.trackIds.filter((id) => id !== hunk.entityId);
    for (const track of project.tracks) track.itemIds = track.itemIds.filter((id) => id !== hunk.entityId);
    return;
  }
  const entity = values[index];
  if (!entity) throw new Error('Entity disappeared while applying a hunk');
  const fields = hunk.fieldGroup.split('+');
  if (fields.length === 1) {
    entity[fields[0] as string] = hunk.after;
  } else {
    const after = hunk.after as Record<string, unknown>;
    for (const field of fields) entity[field] = after[field];
  }
}

export class StaleHunkError extends Error {
  constructor(message = 'The semantic index changed; recompute hunks before staging') {
    super(message);
    this.name = 'StaleHunkError';
  }
}

export function applySemanticHunks(
  base: Project,
  candidate: Project,
  hunkIds: string[],
  expectedBaseDigest: string,
): Project {
  if (projectDigest(base) !== expectedBaseDigest) throw new StaleHunkError();
  const available = new Map(semanticDiff(base, candidate).map((hunk) => [hunk.id, hunk]));
  const selected = hunkIds.map((id) => {
    const hunk = available.get(id);
    if (!hunk) throw new StaleHunkError(`Hunk ${id.slice(0, 12)} is no longer applicable`);
    return hunk;
  });
  const next = cloneProject(base);
  for (const hunk of selected) applyHunk(next, hunk);
  return validateProject(next);
}

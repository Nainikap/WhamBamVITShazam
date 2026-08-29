import { cloneProject, digestText, projectDigest, validateProject, type FrameRange, type Project } from '../domain';

export type EntityType = 'project' | 'sequence' | 'track' | 'asset' | 'clip' | 'gap' | 'caption';
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
  message: string;
  affectedFrameRange?: FrameRange;
}

type Entity = Record<string, unknown> & { id: string };
type CollectionKey = Exclude<EntityType, 'project'>;

const collectionKeys: Record<CollectionKey, keyof Project> = {
  sequence: 'sequences',
  track: 'tracks',
  asset: 'assets',
  clip: 'clips',
  gap: 'gaps',
  caption: 'captions',
};

const fieldGroups: Record<CollectionKey, string[][]> = {
  sequence: [['name'], ['fps'], ['width', 'height'], ['trackIds']],
  track: [['name'], ['kind'], ['itemIds']],
  asset: [['name'], ['fingerprint'], ['durationFrames']],
  clip: [['name'], ['assetId'], ['sourceRange'], ['gainDb'], ['preset'], ['trackId']],
  gap: [['durationFrames'], ['trackId']],
  caption: [['text'], ['range'], ['style'], ['trackId']],
};

function stableValue(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
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
  if (type === 'clip' || type === 'gap' || type === 'caption') {
    const items = project[collectionKeys[type]] as unknown as Array<Entity & { trackId: string }>;
    const item = items.find((candidate) => candidate.id === id);
    if (item && 'trackId' in item) {
      const track = project.tracks.find((candidate) => candidate.id === item.trackId);
      if (track) return { parentId: track.id, orderIndex: track.itemIds.indexOf(id) };
    }
  }
  return {};
}

function describe(type: CollectionKey, operation: HunkOperation, entity: Entity, fields: string[]): string {
  const label = typeof entity.name === 'string'
    ? entity.name
    : typeof entity.text === 'string' ? `“${entity.text.slice(0, 32)}”` : entity.id.slice(0, 8);
  if (operation === 'add') return `Added ${type} ${label}`;
  if (operation === 'delete') return `Deleted ${type} ${label}`;
  if (operation === 'reorder') return `Reordered ${type} ${label}`;
  if (type === 'clip' && fields.includes('sourceRange')) return `Trimmed clip ${label}`;
  if (type === 'caption' && fields.includes('range')) return `Retimed caption ${label}`;
  if (type === 'caption' && fields.includes('text')) return `Changed caption text ${label}`;
  return `Changed ${type} ${label}: ${fields.join(' + ')}`;
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
  ]);
  return { ...input, id: digestText(identity) };
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

  (Object.keys(collectionKeys) as CollectionKey[]).forEach((type) => {
    const key = collectionKeys[type];
    const beforeEntities = base[key] as unknown as Entity[];
    const afterEntities = candidate[key] as unknown as Entity[];
    const beforeById = new Map(beforeEntities.map((entity) => [entity.id, entity]));
    const afterById = new Map(afterEntities.map((entity) => [entity.id, entity]));

    for (const entity of beforeEntities) {
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
          ...related,
          message: describe(type, 'delete', entity, []),
          ...(affected === undefined ? {} : { affectedFrameRange: affected }),
        }));
      }
    }
    for (const entity of afterEntities) {
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
              ...base.clips, ...base.gaps, ...base.captions,
            ].map(({ id }) => id).filter((id) => [
              ...candidate.clips, ...candidate.gaps, ...candidate.captions,
            ].some((item) => item.id === id)))
            : new Set(base.tracks.map(({ id }) => id).filter((id) => candidate.tracks.some((track) => track.id === id)));
          const beforeOrder = (groupValue(before, fields) as string[]).filter((id) => commonIds.has(id));
          const afterOrder = (groupValue(entity, fields) as string[]).filter((id) => beforeOrder.includes(id));
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
            message: describe(type, 'modify', entity, fields),
            ...(affected === undefined ? {} : { affectedFrameRange: affected }),
          }));
        }
      }
    }
  });

  return hunks.sort((left, right) => left.message.localeCompare(right.message) || left.id.localeCompare(right.id));
}

function collection(project: Project, type: CollectionKey): Entity[] {
  return project[collectionKeys[type]] as unknown as Entity[];
}

function applyHunk(project: Project, hunk: SemanticHunk): void {
  if (hunk.entityType === 'project') {
    project.name = String(hunk.after);
    return;
  }
  const values = collection(project, hunk.entityType);
  const index = values.findIndex(({ id }) => id === hunk.entityId);
  if (hunk.operation === 'add') {
    values.push(hunk.after as Entity);
    if (hunk.entityType === 'track' && hunk.parentId) {
      const sequence = project.sequences.find(({ id }) => id === hunk.parentId);
      sequence?.trackIds.splice(hunk.orderIndex ?? sequence.trackIds.length, 0, hunk.entityId);
    } else if ((hunk.entityType === 'clip' || hunk.entityType === 'gap' || hunk.entityType === 'caption') && hunk.parentId) {
      const track = project.tracks.find(({ id }) => id === hunk.parentId);
      track?.itemIds.splice(hunk.orderIndex ?? track.itemIds.length, 0, hunk.entityId);
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

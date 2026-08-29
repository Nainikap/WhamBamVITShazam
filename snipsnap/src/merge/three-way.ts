import { digestText, ProjectSchema, validateProject, type Project } from '../domain';
import type { EntityType } from '../diff';
import { combinePlan, duplicateId, projectRate } from './combine';

export type MergeConflictType = 'same-field' | 'delete-modify' | 'order' | 'validation';

export interface MergeConflict {
  id: string;
  type: MergeConflictType;
  entityType: EntityType;
  entityId: string;
  fieldGroup: string;
  base: unknown;
  ours: unknown;
  theirs: unknown;
  message: string;
  validationErrors?: string[];
  relation?: Partial<Record<'base' | 'ours' | 'theirs', { parentId: string; index: number }>>;
}

export interface MergeResult {
  provisional: Project;
  conflicts: MergeConflict[];
  alternatives: { base: Project; ours: Project; theirs: Project };
}

export type ConflictChoice = 'base' | 'ours' | 'theirs' | 'both' | 'manual';

export interface ConflictResolution {
  conflictId: string;
  choice: ConflictChoice;
  value?: unknown;
}

type Entity = Record<string, unknown> & { id: string };
type CollectionType = Exclude<EntityType, 'project'>;

const collectionKeys: Record<CollectionType, keyof Project> = {
  sequence: 'sequences',
  track: 'tracks',
  asset: 'assets',
  clip: 'clips',
  gap: 'gaps',
  caption: 'captions',
};

const groups: Record<CollectionType, string[][]> = {
  sequence: [['name'], ['fps'], ['width', 'height'], ['trackIds']],
  track: [['name'], ['kind'], ['sequenceId'], ['itemIds']],
  asset: [['name'], ['fingerprint'], ['durationFrames']],
  clip: [['name'], ['trackId'], ['assetId'], ['sourceRange'], ['gainDb'], ['preset']],
  gap: [['trackId'], ['durationFrames']],
  caption: [['trackId'], ['text'], ['range'], ['style']],
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function stable(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${key}:${stable(item)}`)
    .join(',')}}`;
}

function same(left: unknown, right: unknown): boolean {
  return stable(left) === stable(right);
}

function valueFor(entity: Entity, fields: string[]): unknown {
  return fields.length === 1
    ? entity[fields[0] as string]
    : Object.fromEntries(fields.map((field) => [field, entity[field]]));
}

function assign(entity: Entity, fields: string[], value: unknown): void {
  if (fields.length === 1) {
    entity[fields[0] as string] = clone(value);
    return;
  }
  const grouped = value as Record<string, unknown>;
  for (const field of fields) entity[field] = clone(grouped[field]);
}

function conflict(input: Omit<MergeConflict, 'id'>): MergeConflict {
  return { ...input, id: digestText(stable(input)) };
}

function changed(base: unknown, value: unknown): boolean {
  return !same(base, value);
}

function mergeEntity(
  type: CollectionType,
  base: Entity | undefined,
  ours: Entity | undefined,
  theirs: Entity | undefined,
  conflicts: MergeConflict[],
): Entity | undefined {
  const id = base?.id ?? ours?.id ?? theirs?.id;
  if (!id) return undefined;

  if (!base) {
    if (ours && theirs && !same(ours, theirs)) {
      conflicts.push(conflict({
        type: 'same-field', entityType: type, entityId: id, fieldGroup: 'entity',
        base: null, ours, theirs, message: `Both branches added ${type} ${id.slice(0, 8)} differently`,
      }));
      return clone(ours);
    }
    return clone(ours ?? theirs);
  }

  if (!ours && !theirs) return undefined;
  if (!ours || !theirs) {
    const survivor = ours ?? theirs;
    if (same(base, survivor)) return undefined;
    conflicts.push(conflict({
      type: 'delete-modify', entityType: type, entityId: id, fieldGroup: 'entity',
      base, ours: ours ?? null, theirs: theirs ?? null,
      message: `${type} ${id.slice(0, 8)} was deleted on one branch and modified on the other`,
    }));
    return ours ? clone(ours) : undefined;
  }

  const output = clone(base);
  for (const fields of groups[type]) {
    const baseValue = valueFor(base, fields);
    const oursValue = valueFor(ours, fields);
    const theirsValue = valueFor(theirs, fields);
    const oursChanged = changed(baseValue, oursValue);
    const theirsChanged = changed(baseValue, theirsValue);

    if (!oursChanged && theirsChanged) assign(output, fields, theirsValue);
    else if (oursChanged && !theirsChanged) assign(output, fields, oursValue);
    else if (oursChanged && theirsChanged) {
      if (same(oursValue, theirsValue)) assign(output, fields, oursValue);
      else {
        const order = fields.includes('itemIds') || fields.includes('trackIds');
        conflicts.push(conflict({
          type: order ? 'order' : 'same-field',
          entityType: type,
          entityId: id,
          fieldGroup: fields.join('+'),
          base: baseValue,
          ours: oursValue,
          theirs: theirsValue,
          message: order
            ? `${type} ${id.slice(0, 8)} was reordered differently`
            : `${type} ${id.slice(0, 8)} changed ${fields.join(' + ')} differently`,
        }));
        assign(output, fields, oursValue);
      }
    }
  }
  return output;
}

function validationMessages(project: Project): string[] {
  const result = validateProjectSafe(project);
  return result.success ? [] : result.error.issues.map(({ message }) => message);
}

const validateProjectSafe = (project: Project) => ProjectSchema.safeParse(project);

function validationConflict(
  project: Project,
  errors: string[],
  alternatives: { base: Project; ours: Project; theirs: Project },
): MergeConflict {
  return conflict({
    type: 'validation',
    entityType: 'project',
    entityId: project.id,
    fieldGroup: 'validation',
    base: alternatives.base,
    ours: alternatives.ours,
    theirs: alternatives.theirs,
    message: 'Independent edits combine into an invalid timeline',
    validationErrors: errors,
  });
}

export function mergeThreeWay(baseInput: Project, oursInput: Project, theirsInput: Project): MergeResult {
  const base = validateProject(baseInput);
  const ours = validateProject(oursInput);
  const theirs = validateProject(theirsInput);
  if (base.id !== ours.id || base.id !== theirs.id) throw new Error('Cannot merge different projects');

  const provisional = clone(base);
  const conflicts: MergeConflict[] = [];
  if (ours.name === theirs.name) provisional.name = ours.name;
  else if (ours.name === base.name) provisional.name = theirs.name;
  else if (theirs.name === base.name) provisional.name = ours.name;
  else {
    conflicts.push(conflict({
      type: 'same-field', entityType: 'project', entityId: base.id, fieldGroup: 'name',
      base: base.name, ours: ours.name, theirs: theirs.name, message: 'Project was renamed differently',
    }));
    provisional.name = ours.name;
  }

  (Object.keys(collectionKeys) as CollectionType[]).forEach((type) => {
    const key = collectionKeys[type];
    const baseEntities = base[key] as unknown as Entity[];
    const oursEntities = ours[key] as unknown as Entity[];
    const theirsEntities = theirs[key] as unknown as Entity[];
    const baseById = new Map(baseEntities.map((entity) => [entity.id, entity]));
    const oursById = new Map(oursEntities.map((entity) => [entity.id, entity]));
    const theirsById = new Map(theirsEntities.map((entity) => [entity.id, entity]));
    const orderedIds = [...new Set([...baseEntities, ...oursEntities, ...theirsEntities].map(({ id }) => id))];
    const merged = orderedIds
      .map((id) => mergeEntity(type, baseById.get(id), oursById.get(id), theirsById.get(id), conflicts))
      .filter((entity): entity is Entity => entity !== undefined);
    (provisional[key] as unknown) = merged;
  });

  const relation = (project: Project, type: EntityType, id: string) => {
    if (type === 'track') {
      const parent = project.sequences.find(({ trackIds }) => trackIds.includes(id));
      return parent ? { parentId: parent.id, index: parent.trackIds.indexOf(id) } : undefined;
    }
    if (type === 'clip' || type === 'gap' || type === 'caption') {
      const parent = project.tracks.find(({ itemIds }) => itemIds.includes(id));
      return parent ? { parentId: parent.id, index: parent.itemIds.indexOf(id) } : undefined;
    }
    return undefined;
  };
  for (const item of conflicts) {
    if (item.fieldGroup !== 'entity') continue;
    const baseRelation = relation(base, item.entityType, item.entityId);
    const oursRelation = relation(ours, item.entityType, item.entityId);
    const theirsRelation = relation(theirs, item.entityType, item.entityId);
    item.relation = {
      ...(baseRelation ? { base: baseRelation } : {}),
      ...(oursRelation ? { ours: oursRelation } : {}),
      ...(theirsRelation ? { theirs: theirsRelation } : {}),
    };
  }

  const errors = validationMessages(provisional);
  const alternatives = { base: clone(base), ours: clone(ours), theirs: clone(theirs) };
  if (errors.length > 0) conflicts.push(validationConflict(provisional, errors, alternatives));
  return { provisional, conflicts, alternatives };
}

function entityCollection(project: Project, type: CollectionType): Entity[] {
  return project[collectionKeys[type]] as unknown as Entity[];
}

function applyResolution(project: Project, conflictItem: MergeConflict, value: unknown, choice: ConflictChoice): void {
  if (conflictItem.type === 'validation') {
    const replacement = validateProject(value);
    Object.assign(project, clone(replacement));
    return;
  }
  if (conflictItem.entityType === 'project') {
    project.name = String(value);
    return;
  }
  const items = entityCollection(project, conflictItem.entityType);
  const index = items.findIndex(({ id }) => id === conflictItem.entityId);
  if (conflictItem.fieldGroup === 'entity') {
    if (value === null) {
      if (index >= 0) items.splice(index, 1);
      for (const sequence of project.sequences) sequence.trackIds = sequence.trackIds.filter((id) => id !== conflictItem.entityId);
      for (const track of project.tracks) track.itemIds = track.itemIds.filter((id) => id !== conflictItem.entityId);
    } else if (index >= 0) items[index] = clone(value as Entity);
    else items.push(clone(value as Entity));
    if (value !== null) {
      const relation = choice === 'manual' || choice === 'both' ? undefined : conflictItem.relation?.[choice];
      const entity = value as Entity;
      if (conflictItem.entityType === 'track') {
        const parentId = relation?.parentId ?? String(entity.sequenceId);
        const sequence = project.sequences.find(({ id }) => id === parentId);
        if (sequence && !sequence.trackIds.includes(conflictItem.entityId)) {
          sequence.trackIds.splice(relation?.index ?? sequence.trackIds.length, 0, conflictItem.entityId);
        }
      } else if (conflictItem.entityType === 'clip' || conflictItem.entityType === 'gap' || conflictItem.entityType === 'caption') {
        const parentId = relation?.parentId ?? String(entity.trackId);
        const track = project.tracks.find(({ id }) => id === parentId);
        if (track && !track.itemIds.includes(conflictItem.entityId)) {
          track.itemIds.splice(relation?.index ?? track.itemIds.length, 0, conflictItem.entityId);
        }
      }
    }
    return;
  }
  if (index < 0) throw new Error(`Cannot resolve missing ${conflictItem.entityType} ${conflictItem.entityId}`);
  const entity = items[index];
  if (!entity) throw new Error('Conflict entity disappeared');
  assign(entity, conflictItem.fieldGroup.split('+'), value);
}

/** Every timeline item that currently belongs to a track, in no particular order. */
function itemsOf(project: Project): Array<Entity & { trackId: string }> {
  return [...project.clips, ...project.gaps, ...project.captions] as unknown as Array<Entity & { trackId: string }>;
}

/** Apply a combined order while dropping identities the merge did not keep. */
function assignCombinedOrder(project: Project, conflictItem: MergeConflict, order: string[]): void {
  if (conflictItem.fieldGroup === 'trackIds') {
    const sequence = project.sequences.find(({ id }) => id === conflictItem.entityId);
    if (!sequence) throw new Error(`Cannot combine order for missing sequence ${conflictItem.entityId}`);
    const valid = project.tracks.filter(({ sequenceId }) => sequenceId === sequence.id).map(({ id }) => id);
    sequence.trackIds = order.filter((id) => valid.includes(id));
    for (const id of valid) if (!sequence.trackIds.includes(id)) sequence.trackIds.push(id);
    return;
  }
  const track = project.tracks.find(({ id }) => id === conflictItem.entityId);
  if (!track) throw new Error(`Cannot combine order for missing track ${conflictItem.entityId}`);
  const valid = itemsOf(project).filter((item) => item.trackId === track.id).map(({ id }) => id);
  track.itemIds = order.filter((id) => valid.includes(id));
  for (const id of valid) if (!track.itemIds.includes(id)) track.itemIds.push(id);
}

/** Keep both takes by giving the incoming item a fresh identity next to the current one. */
function applyDuplicate(project: Project, conflictItem: MergeConflict, incoming: unknown): void {
  if (conflictItem.entityType === 'project' || conflictItem.entityType === 'sequence'
    || conflictItem.entityType === 'track' || conflictItem.entityType === 'asset') {
    throw new Error(`Cannot keep both ${conflictItem.entityType}s`);
  }
  const items = entityCollection(project, conflictItem.entityType);
  const current = items.find(({ id }) => id === conflictItem.entityId);
  if (!current) throw new Error(`Cannot keep both: ${conflictItem.entityType} ${conflictItem.entityId} is missing`);
  const duplicate = conflictItem.fieldGroup === 'entity'
    ? clone(incoming as Entity)
    : { ...clone(current), [conflictItem.fieldGroup]: clone(incoming) };
  duplicate.id = duplicateId(conflictItem.id);
  const trackId = typeof duplicate.trackId === 'string'
    && project.tracks.some(({ id }) => id === duplicate.trackId)
    ? String(duplicate.trackId)
    : String(current.trackId);
  duplicate.trackId = trackId;
  items.push(duplicate);
  const track = project.tracks.find(({ id }) => id === trackId);
  if (!track) throw new Error(`Cannot keep both: track ${trackId} is missing`);
  const after = track.itemIds.indexOf(conflictItem.entityId);
  track.itemIds.splice(after >= 0 ? after + 1 : track.itemIds.length, 0, duplicate.id);
}

function applyCombination(project: Project, conflictItem: MergeConflict): void {
  const plan = combinePlan(conflictItem, projectRate(project));
  switch (plan.kind) {
    case 'value':
      applyResolution(project, conflictItem, plan.value, 'manual');
      return;
    case 'survivor':
      applyResolution(project, conflictItem, plan.value, conflictItem.ours === null ? 'theirs' : 'ours');
      return;
    case 'order':
      assignCombinedOrder(project, conflictItem, plan.order);
      return;
    case 'duplicate':
      applyDuplicate(project, conflictItem, plan.value);
      return;
    default:
      throw new Error(`Cannot keep both sides: ${plan.summary}`);
  }
}

export function resolveMerge(result: MergeResult, resolutions: ConflictResolution[]): MergeResult {
  const provisional = clone(result.provisional);
  const byId = new Map(result.conflicts.map((item) => [item.id, item]));
  const resolved = new Set<string>();

  for (const resolution of resolutions) {
    const item = byId.get(resolution.conflictId);
    if (!item) continue;
    if (resolution.choice === 'both') {
      applyCombination(provisional, item);
      resolved.add(item.id);
      continue;
    }
    const value = resolution.choice === 'manual'
      ? resolution.value
      : item[resolution.choice];
    if (resolution.choice === 'manual' && value === undefined) throw new Error('Manual conflict resolution requires a value');
    applyResolution(provisional, item, value, resolution.choice);
    resolved.add(item.id);
  }

  const conflicts = result.conflicts.filter((item) => item.type !== 'validation' && !resolved.has(item.id));
  const errors = validationMessages(provisional);
  if (errors.length > 0) conflicts.push(validationConflict(provisional, errors, result.alternatives));
  return { provisional, conflicts, alternatives: result.alternatives };
}

export function completeMerge(result: MergeResult): Project {
  if (result.conflicts.length > 0) throw new Error('Cannot complete a merge with unresolved conflicts');
  return validateProject(result.provisional);
}

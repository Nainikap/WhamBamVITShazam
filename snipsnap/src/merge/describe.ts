import { framesToTimecode, type FrameRange, type Project, type Track } from '../domain';
import { combinePlan, projectRate } from './combine';
import type { MergeConflict, MergeResult } from './three-way';

/** What kind of editorial decision the two branches disagreed about. */
export type ConflictCategory =
  | 'timing'
  | 'footage'
  | 'order'
  | 'existence'
  | 'level'
  | 'look'
  | 'format'
  | 'caption'
  | 'naming'
  | 'structure'
  | 'validation';

export type ConflictScope = 'video' | 'audio' | 'caption' | 'timeline' | 'project';

export interface ConflictSide {
  label: string;
  summary: string;
  range?: FrameRange;
}

export interface ConflictBrief {
  id: string;
  category: ConflictCategory;
  scope: ConflictScope;
  trackName: string | null;
  title: string;
  explanation: string;
  original: ConflictSide;
  current: ConflictSide;
  incoming: ConflictSide;
  combination: { available: boolean; summary: string };
  validationErrors: string[];
}

const categoryTitles: Record<ConflictCategory, string> = {
  timing: 'Timestamps disagree',
  footage: 'Different footage',
  order: 'Different running order',
  existence: 'Kept on one side, cut on the other',
  level: 'Different audio level',
  look: 'Different look',
  format: 'Different sequence format',
  caption: 'Different caption',
  naming: 'Different name',
  structure: 'Different timeline structure',
  validation: 'Combined timeline is invalid',
};

function categoryOf(conflict: MergeConflict): ConflictCategory {
  if (conflict.type === 'validation') return 'validation';
  if (conflict.type === 'delete-modify') return 'existence';
  if (conflict.fieldGroup === 'entity') return 'existence';
  if (conflict.fieldGroup === 'itemIds' || conflict.fieldGroup === 'trackIds') return 'order';
  if (conflict.fieldGroup === 'sourceRange' || conflict.fieldGroup === 'range') return 'timing';
  if (conflict.fieldGroup === 'durationFrames') return conflict.entityType === 'asset' ? 'footage' : 'timing';
  if (conflict.fieldGroup === 'assetId' || conflict.fieldGroup === 'fingerprint') return 'footage';
  if (conflict.fieldGroup === 'gainDb') return 'level';
  if (conflict.fieldGroup === 'preset') return 'look';
  if (conflict.fieldGroup === 'fps' || conflict.fieldGroup === 'width+height') return 'format';
  if (conflict.fieldGroup === 'text' || conflict.fieldGroup === 'style') return 'caption';
  if (conflict.fieldGroup === 'name') return 'naming';
  return 'structure';
}

function trackFor(projects: Project[], conflict: MergeConflict): Track | null {
  for (const project of projects) {
    if (conflict.entityType === 'track') {
      const track = project.tracks.find(({ id }) => id === conflict.entityId);
      if (track) return track;
    }
    const item = [...project.clips, ...project.gaps, ...project.transitions, ...project.captions]
      .find(({ id }) => id === conflict.entityId);
    if (item) {
      const track = project.tracks.find(({ id }) => id === item.trackId);
      if (track) return track;
    }
  }
  return null;
}

function entityName(projects: Project[], conflict: MergeConflict): string | null {
  for (const project of projects) {
    const item = [...project.clips, ...project.transitions, ...project.captions].find(({ id }) => id === conflict.entityId);
    if (item) return 'name' in item ? item.name : `“${item.text}”`;
    const track = project.tracks.find(({ id }) => id === conflict.entityId);
    if (track) return track.name;
    const asset = project.assets.find(({ id }) => id === conflict.entityId);
    if (asset) return asset.name;
    const sequence = project.sequences.find(({ id }) => id === conflict.entityId);
    if (sequence) return sequence.name;
  }
  return null;
}

function scopeOf(conflict: MergeConflict, track: Track | null): ConflictScope {
  if (conflict.type === 'validation' || conflict.entityType === 'project') return 'project';
  if (track) return track.kind;
  if (conflict.entityType === 'caption') return 'caption';
  if (conflict.entityType === 'sequence') return 'timeline';
  return 'timeline';
}

function isRange(value: unknown): value is FrameRange {
  return typeof value === 'object' && value !== null
    && typeof (value as FrameRange).start === 'number'
    && typeof (value as FrameRange).duration === 'number';
}

function entityLabel(value: Record<string, unknown>): string {
  if (typeof value.name === 'string') return value.name;
  if (typeof value.text === 'string') return `“${value.text}”`;
  return String(value.id ?? 'item').slice(0, 8);
}

function side(label: string, value: unknown, conflict: MergeConflict, fps: number): ConflictSide {
  if (value === null || value === undefined) return { label, summary: 'removed from the timeline' };
  if (isRange(value)) {
    return {
      label,
      summary: `${framesToTimecode(value.start, fps)} → ${framesToTimecode(value.start + value.duration, fps)} (${value.duration} frames)`,
      range: value,
    };
  }
  if (Array.isArray(value)) return { label, summary: `${value.length} item${value.length === 1 ? '' : 's'} in this order` };
  if (typeof value === 'number') {
    if (conflict.fieldGroup === 'gainDb') return { label, summary: `${value > 0 ? '+' : ''}${value} dB` };
    return { label, summary: `${value} frames` };
  }
  if (typeof value === 'string') return { label, summary: conflict.fieldGroup === 'text' ? `“${value}”` : value };
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const range = isRange(record.sourceRange) ? record.sourceRange : isRange(record.range) ? record.range : null;
    const timing = range
      ? ` · ${framesToTimecode(range.start, fps)} → ${framesToTimecode(range.start + range.duration, fps)}`
      : '';
    return { label, summary: `${entityLabel(record)}${timing}` };
  }
  return { label, summary: String(value) };
}

function explain(category: ConflictCategory, scope: ConflictScope, conflict: MergeConflict): string {
  const media = scope === 'audio' ? 'audio' : scope === 'video' ? 'video' : 'timeline';
  switch (category) {
    case 'timing':
      return `Both branches retimed this ${media} item, so its in and out points disagree.`;
    case 'footage':
      return `Both branches pointed this ${media} item at different footage.`;
    case 'order':
      return `Both branches rearranged this ${media} lane, so the running order disagrees.`;
    case 'existence':
      return conflict.type === 'delete-modify'
        ? `One branch cut this ${media} item while the other kept editing it.`
        : `Both branches introduced this ${media} item with different contents.`;
    case 'level':
      return 'Both branches set a different level on this audio clip.';
    case 'look':
      return 'Both branches graded this clip differently.';
    case 'format':
      return 'Both branches changed the sequence format, which every clip depends on.';
    case 'caption':
      return 'Both branches rewrote this caption.';
    case 'naming':
      return 'Both branches renamed this differently.';
    case 'validation':
      return 'The independently valid edits do not combine into a timeline that validates.';
    default:
      return 'Both branches restructured this part of the timeline differently.';
  }
}

/** Turn a raw merge conflict into everything the resolution window needs to render. */
export function describeConflict(
  conflict: MergeConflict,
  alternatives: MergeResult['alternatives'],
): ConflictBrief {
  const fps = projectRate(alternatives.ours);
  const category = categoryOf(conflict);
  const track = trackFor([alternatives.ours, alternatives.theirs, alternatives.base], conflict);
  const scope = scopeOf(conflict, track);
  const plan = combinePlan(conflict, fps);
  const projects = [alternatives.ours, alternatives.theirs, alternatives.base];
  const label = entityName(projects, conflict) ?? conflict.entityType;
  const subject = track && track.name !== label ? `${track.name} · ` : '';
  const name = conflict.type === 'validation' ? 'Whole timeline' : `${subject}${label}`;

  return {
    id: conflict.id,
    category,
    scope,
    trackName: track?.name ?? null,
    title: `${categoryTitles[category]} — ${name}`,
    explanation: explain(category, scope, conflict),
    original: side('Original', conflict.type === 'validation' ? null : conflict.base, conflict, fps),
    current: side('Current', conflict.type === 'validation' ? null : conflict.ours, conflict, fps),
    incoming: side('Incoming', conflict.type === 'validation' ? null : conflict.theirs, conflict, fps),
    combination: { available: plan.kind !== 'unavailable', summary: plan.summary },
    validationErrors: conflict.validationErrors ?? [],
  };
}

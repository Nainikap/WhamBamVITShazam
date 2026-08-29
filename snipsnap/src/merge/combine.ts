import { deterministicUuid, framesToTimecode, rationalToRate, type FrameRange, type Project } from '../domain';
import type { MergeConflict } from './three-way';

/**
 * How a conflict is resolved when the editor keeps both branches instead of
 * picking one. Only combinations with an unambiguous editorial meaning exist.
 */
export type CombinePlan =
  | { kind: 'value'; value: unknown; summary: string }
  | { kind: 'order'; order: string[]; summary: string }
  | { kind: 'survivor'; value: unknown; summary: string }
  | { kind: 'duplicate'; value: unknown; summary: string }
  | { kind: 'unavailable'; summary: string };

function isRange(value: unknown): value is FrameRange {
  return typeof value === 'object' && value !== null
    && typeof (value as FrameRange).start === 'number'
    && typeof (value as FrameRange).duration === 'number';
}

function hull(left: FrameRange, right: FrameRange): FrameRange {
  const start = Math.min(left.start, right.start);
  const end = Math.max(left.start + left.duration, right.start + right.duration);
  return { start, duration: end - start };
}

function ids(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value as string[] : null;
}

/** Keep every item from both orders, using the current branch as the backbone. */
export function mergeOrders(ours: string[], theirs: string[]): string[] {
  const result = [...ours];
  const present = new Set(result);
  theirs.forEach((id, index) => {
    if (present.has(id)) return;
    let anchor = -1;
    for (let previous = index - 1; previous >= 0; previous -= 1) {
      const position = result.indexOf(theirs[previous] as string);
      if (position >= 0) {
        anchor = position;
        break;
      }
    }
    result.splice(anchor + 1, 0, id);
    present.add(id);
  });
  return result;
}

const duplicable = new Set(['clip', 'gap', 'transition', 'caption']);

export function combinePlan(conflict: MergeConflict, fps = 24): CombinePlan {
  const timecode = (range: FrameRange) => `${framesToTimecode(range.start, fps)} → ${framesToTimecode(range.start + range.duration, fps)}`;

  if (conflict.type === 'validation') {
    return { kind: 'unavailable', summary: 'The combined timeline is already invalid; choose one branch instead.' };
  }

  if (conflict.fieldGroup === 'entity') {
    if (conflict.type === 'delete-modify') {
      const survivor = conflict.ours ?? conflict.theirs;
      return {
        kind: 'survivor',
        value: survivor,
        summary: 'Keep the footage and the edit made to it instead of honouring the deletion.',
      };
    }
    if (duplicable.has(conflict.entityType)) {
      return {
        kind: 'duplicate',
        value: conflict.theirs,
        summary: 'Keep both takes: the current one stays in place and the incoming one is added right after it.',
      };
    }
    return { kind: 'unavailable', summary: `Two different ${conflict.entityType}s cannot share one identity; choose one.` };
  }

  if (conflict.fieldGroup === 'sourceRange' || conflict.fieldGroup === 'range') {
    const ours = conflict.ours;
    const theirs = conflict.theirs;
    if (isRange(ours) && isRange(theirs)) {
      const combined = hull(ours, theirs);
      return {
        kind: 'value',
        value: combined,
        summary: `Keep every frame both cuts use (${timecode(combined)}).`,
      };
    }
  }

  if (conflict.fieldGroup === 'durationFrames' && typeof conflict.ours === 'number' && typeof conflict.theirs === 'number') {
    const combined = Math.max(conflict.ours, conflict.theirs);
    return {
      kind: 'value',
      value: combined,
      summary: conflict.entityType === 'gap'
        ? `Hold the longer gap (${combined} frames).`
        : `Trust the longer available media (${combined} frames).`,
    };
  }

  if (conflict.fieldGroup === 'itemIds' || conflict.fieldGroup === 'trackIds') {
    const ours = ids(conflict.ours);
    const theirs = ids(conflict.theirs);
    if (ours && theirs) {
      const order = mergeOrders(ours, theirs);
      return {
        kind: 'order',
        order,
        summary: `Keep every item from both orders (${order.length} in the combined lane).`,
      };
    }
  }

  if (conflict.fieldGroup === 'text' && typeof conflict.ours === 'string' && typeof conflict.theirs === 'string') {
    return {
      kind: 'value',
      value: `${conflict.ours}\n${conflict.theirs}`,
      summary: 'Show both caption lines, current first.',
    };
  }

  if (conflict.fieldGroup === 'assetId' && conflict.entityType === 'clip') {
    return {
      kind: 'duplicate',
      value: conflict.theirs,
      summary: 'Keep both takes: the current footage stays and the incoming footage is added right after it.',
    };
  }

  return {
    kind: 'unavailable',
    summary: `${conflict.fieldGroup} holds a single value with no meaningful combination; choose current or incoming.`,
  };
}

export function projectRate(project: Project): number {
  const sequence = project.sequences[0];
  return sequence ? rationalToRate(sequence.fps) : 24;
}

export function duplicateId(conflictId: string): string {
  return deterministicUuid(`snipsnap:keep-both:${conflictId}`);
}

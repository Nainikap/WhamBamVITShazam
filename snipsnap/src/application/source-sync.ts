import { z } from 'zod';
import { projectDigest, validateProject, type Project } from '../domain';
import type { UnsupportedContent } from '../adapters/otio';

export const SourceBindingSchema = z.object({
  format: z.literal('otio'),
  path: z.string().min(1),
  lastSeenDigest: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  lastAppliedDigest: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  ignoredDigest: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
}).strict();

export const PendingSyncSchema = z.object({
  digest: z.string().regex(/^[a-f0-9]{64}$/u),
  detectedAt: z.string().datetime(),
  baseWorkspaceVersion: z.number().int().nonnegative(),
  project: z.unknown(),
  mediaLinks: z.record(z.string()),
  unsupported: z.array(z.object({
    path: z.string(),
    schema: z.string(),
    reason: z.string(),
  }).strict()),
}).strict();

export type SourceBinding = z.infer<typeof SourceBindingSchema>;

export interface PendingSync {
  digest: string;
  detectedAt: string;
  baseWorkspaceVersion: number;
  project: Project;
  mediaLinks: Record<string, string>;
  unsupported: UnsupportedContent[];
}

function scoreClip(
  candidate: Project['clips'][number],
  existing: Project['clips'][number],
  candidatePosition: number,
  existingPosition: number,
): number {
  const namePenalty = candidate.name === existing.name ? 0 : 10_000;
  return namePenalty
    + Math.abs(candidate.sourceRange.start - existing.sourceRange.start)
    + Math.abs(candidate.sourceRange.duration - existing.sourceRange.duration)
    + Math.abs(candidatePosition - existingPosition) * 10;
}

/**
 * Resolve may omit VideoGit UUID metadata when it rewrites OTIO. Reconcile the
 * imported graph against the current workspace so trims and moves remain
 * modifications of stable entities instead of noisy delete/add pairs.
 */
export function reconcileImportedProject(base: Project, imported: Project): Project {
  const candidate = structuredClone(imported);
  candidate.id = base.id;

  const sequenceIdMap = new Map<string, string>();
  candidate.sequences.forEach((sequence, index) => {
    const existing = base.sequences[index];
    if (existing) {
      sequenceIdMap.set(sequence.id, existing.id);
      sequence.id = existing.id;
    }
  });

  const usedTracks = new Set<string>();
  const trackIdMap = new Map<string, string>();
  candidate.tracks.forEach((track, index) => {
    const oldId = track.id;
    const sameId = base.tracks.find(({ id }) => id === track.id && !usedTracks.has(id));
    const sameName = base.tracks.find((existing) => existing.kind === track.kind
      && existing.name === track.name && !usedTracks.has(existing.id));
    const samePosition = base.tracks[index]?.kind === track.kind ? base.tracks[index] : undefined;
    const existing = sameId ?? sameName ?? (samePosition && !usedTracks.has(samePosition.id) ? samePosition : undefined);
    if (existing) {
      track.id = existing.id;
      usedTracks.add(existing.id);
    }
    track.sequenceId = sequenceIdMap.get(track.sequenceId) ?? track.sequenceId;
    trackIdMap.set(oldId, track.id);
  });
  for (const sequence of candidate.sequences) {
    sequence.trackIds = sequence.trackIds.map((id) => trackIdMap.get(id) ?? id);
  }

  const assetIdMap = new Map<string, string>();
  for (const asset of candidate.assets) {
    const oldId = asset.id;
    const existing = base.assets.find(({ fingerprint }) => fingerprint === asset.fingerprint);
    if (existing) asset.id = existing.id;
    assetIdMap.set(oldId, asset.id);
  }

  const itemIdMap = new Map<string, string>();
  const usedItems = new Set<string>();
  for (const candidateTrack of candidate.tracks) {
    const baseTrack = base.tracks.find(({ id }) => id === candidateTrack.id);
    const basePositions = new Map((baseTrack?.itemIds ?? []).map((id, index) => [id, index]));
    const baseClips = base.clips.filter(({ trackId }) => trackId === candidateTrack.id);
    const baseGaps = base.gaps.filter(({ trackId }) => trackId === candidateTrack.id);
    const baseCaptions = base.captions.filter(({ trackId }) => trackId === candidateTrack.id);

    candidateTrack.itemIds.forEach((candidateItemId, position) => {
      const clip = candidate.clips.find(({ id }) => id === candidateItemId);
      const gap = candidate.gaps.find(({ id }) => id === candidateItemId);
      const caption = candidate.captions.find(({ id }) => id === candidateItemId);
      let matchedId: string | undefined;

      if (clip) {
        const importedAsset = candidate.assets.find(({ id }) => id === clip.assetId);
        const exact = baseClips.find(({ id }) => id === clip.id && !usedItems.has(id));
        const compatible = baseClips
          .filter((existing) => !usedItems.has(existing.id)
            && base.assets.find(({ id }) => id === existing.assetId)?.fingerprint === importedAsset?.fingerprint)
          .sort((left, right) => scoreClip(clip, left, position, basePositions.get(left.id) ?? position)
            - scoreClip(clip, right, position, basePositions.get(right.id) ?? position));
        matchedId = (exact ?? compatible[0])?.id;
        clip.trackId = candidateTrack.id;
        clip.assetId = assetIdMap.get(clip.assetId) ?? clip.assetId;
        if (matchedId) clip.id = matchedId;
      } else if (gap) {
        matchedId = baseGaps.find(({ id }) => id === gap.id && !usedItems.has(id))?.id
          ?? (baseTrack?.itemIds[position]
            ? baseGaps.find(({ id }) => id === baseTrack.itemIds[position] && !usedItems.has(id))?.id
            : undefined);
        gap.trackId = candidateTrack.id;
        if (matchedId) gap.id = matchedId;
      } else if (caption) {
        matchedId = baseCaptions.find(({ id }) => id === caption.id && !usedItems.has(id))?.id
          ?? baseCaptions.find((existing) => !usedItems.has(existing.id)
            && existing.style === caption.style)?.id;
        caption.trackId = candidateTrack.id;
        if (matchedId) caption.id = matchedId;
      }

      const nextId = clip?.id ?? gap?.id ?? caption?.id ?? candidateItemId;
      itemIdMap.set(candidateItemId, nextId);
      usedItems.add(nextId);
    });
  }

  for (const track of candidate.tracks) {
    track.itemIds = track.itemIds.map((id) => itemIdMap.get(id) ?? id);
  }

  return validateProject(candidate);
}

export function pendingSync(
  project: Project,
  mediaLinks: Record<string, string>,
  unsupported: UnsupportedContent[],
  digest: string,
  baseWorkspaceVersion: number,
): PendingSync {
  return {
    digest,
    detectedAt: new Date().toISOString(),
    baseWorkspaceVersion,
    project: validateProject(project),
    mediaLinks,
    unsupported,
  };
}

export function candidateChangeCount(base: Project, candidate: Project): number {
  return projectDigest(base) === projectDigest(candidate) ? 0 : 1;
}

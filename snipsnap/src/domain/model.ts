import { z } from 'zod';

export const UUIDSchema = z.string().uuid();
export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const NameSchema = z.string().min(1).transform((value) => value.normalize('NFC'));
const TextSchema = z.string().transform((value) => value.normalize('NFC'));
const PositiveSafeIntegerSchema = z.number().int().safe().positive();
const NonnegativeSafeIntegerSchema = z.number().int().safe().nonnegative();

export const RationalSchema = z
  .object({
    numerator: PositiveSafeIntegerSchema,
    denominator: PositiveSafeIntegerSchema,
  })
  .strict();

export const FrameRangeSchema = z
  .object({
    start: NonnegativeSafeIntegerSchema,
    duration: PositiveSafeIntegerSchema,
  })
  .strict();

export const AssetSchema = z
  .object({
    id: UUIDSchema,
    name: NameSchema,
    fingerprint: Sha256Schema,
    durationFrames: PositiveSafeIntegerSchema,
  })
  .strict();

export const ClipSchema = z
  .object({
    id: UUIDSchema,
    type: z.literal('clip'),
    trackId: UUIDSchema,
    name: NameSchema,
    assetId: UUIDSchema,
    sourceRange: FrameRangeSchema,
    gainDb: z.number().min(-60).max(12),
    preset: z.enum(['none', 'warm', 'cool', 'mono']),
  })
  .strict();

export const GapSchema = z
  .object({
    id: UUIDSchema,
    type: z.literal('gap'),
    trackId: UUIDSchema,
    durationFrames: PositiveSafeIntegerSchema,
  })
  .strict();

export const CaptionSchema = z
  .object({
    id: UUIDSchema,
    type: z.literal('caption'),
    trackId: UUIDSchema,
    text: TextSchema,
    range: FrameRangeSchema,
    style: z.enum(['default', 'title', 'subtitle']),
  })
  .strict();

export const TrackSchema = z
  .object({
    id: UUIDSchema,
    sequenceId: UUIDSchema,
    name: NameSchema,
    kind: z.enum(['video', 'audio', 'caption']),
    itemIds: z.array(UUIDSchema),
  })
  .strict();

export const SequenceSchema = z
  .object({
    id: UUIDSchema,
    name: NameSchema,
    fps: RationalSchema,
    width: PositiveSafeIntegerSchema,
    height: PositiveSafeIntegerSchema,
    trackIds: z.array(UUIDSchema),
  })
  .strict();

const ProjectShape = z
  .object({
    schemaVersion: z.literal(1),
    id: UUIDSchema,
    name: NameSchema,
    sequences: z.array(SequenceSchema).min(1),
    tracks: z.array(TrackSchema),
    assets: z.array(AssetSchema),
    clips: z.array(ClipSchema),
    gaps: z.array(GapSchema),
    captions: z.array(CaptionSchema),
  })
  .strict();

export const ProjectSchema = ProjectShape.superRefine((project, context) => {
  const unique = (label: string, ids: string[]) => {
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `${label} IDs must be unique` });
    }
  };

  unique('Sequence', project.sequences.map(({ id }) => id));
  unique('Track', project.tracks.map(({ id }) => id));
  unique('Asset', project.assets.map(({ id }) => id));
  const items = [...project.clips, ...project.gaps, ...project.captions];
  unique('Timeline item', items.map(({ id }) => id));

  const sequenceIds = new Set(project.sequences.map(({ id }) => id));
  const trackIds = new Set(project.tracks.map(({ id }) => id));
  const assetById = new Map(project.assets.map((asset) => [asset.id, asset]));
  const itemById = new Map(items.map((item) => [item.id, item]));

  for (const sequence of project.sequences) {
    if (new Set(sequence.trackIds).size !== sequence.trackIds.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `Sequence ${sequence.id} repeats a track` });
    }
    for (const trackId of sequence.trackIds) {
      const track = project.tracks.find(({ id }) => id === trackId);
      if (!track || track.sequenceId !== sequence.id) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: `Sequence ${sequence.id} has an invalid track` });
      }
    }
  }

  for (const track of project.tracks) {
    if (!sequenceIds.has(track.sequenceId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `Track ${track.id} has no sequence` });
    }
    if (new Set(track.itemIds).size !== track.itemIds.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `Track ${track.id} repeats an item` });
    }
    for (const itemId of track.itemIds) {
      const item = itemById.get(itemId);
      if (!item || item.trackId !== track.id) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: `Track ${track.id} has an invalid item` });
      }
      if (item?.type === 'caption' && track.kind !== 'caption') {
        context.addIssue({ code: z.ZodIssueCode.custom, message: `Caption ${item.id} is not on a caption track` });
      }
      if (item && item.type !== 'caption' && track.kind === 'caption') {
        context.addIssue({ code: z.ZodIssueCode.custom, message: `Non-caption ${item.id} is on a caption track` });
      }
    }
  }

  for (const clip of project.clips) {
    const asset = assetById.get(clip.assetId);
    if (!trackIds.has(clip.trackId) || !asset) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `Clip ${clip.id} has an invalid reference` });
    } else if (!Number.isSafeInteger(clip.sourceRange.start + clip.sourceRange.duration)
      || clip.sourceRange.start + clip.sourceRange.duration > asset.durationFrames) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `Clip ${clip.id} exceeds its asset duration` });
    }
  }

  for (const item of [...project.gaps, ...project.captions]) {
    if (!trackIds.has(item.trackId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `Item ${item.id} has an invalid track` });
    }
  }

  const referencedTracks = project.sequences.flatMap(({ trackIds: ids }) => ids);
  for (const track of project.tracks) {
    if (referencedTracks.filter((id) => id === track.id).length !== 1) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `Track ${track.id} must appear in exactly one sequence` });
    }
  }
  const referencedItems = project.tracks.flatMap(({ itemIds: ids }) => ids);
  for (const item of items) {
    if (referencedItems.filter((id) => id === item.id).length !== 1) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `Item ${item.id} must appear in exactly one track` });
    }
  }

  const itemDuration = (itemId: string): number => {
    const item = itemById.get(itemId);
    if (!item || item.type === 'caption') return 0;
    return item.type === 'clip' ? item.sourceRange.duration : item.durationFrames;
  };
  for (const sequence of project.sequences) {
    const durationFrames = Math.max(0, ...sequence.trackIds.map((trackId) => {
      const track = project.tracks.find(({ id }) => id === trackId);
      if (!track || track.kind === 'caption') return 0;
      return track.itemIds.reduce((total, itemId) => total + itemDuration(itemId), 0);
    }));
    for (const trackId of sequence.trackIds) {
      const track = project.tracks.find(({ id }) => id === trackId);
      if (!track || track.kind !== 'caption') continue;
      for (const itemId of track.itemIds) {
        const caption = project.captions.find(({ id }) => id === itemId);
        if (caption && (!Number.isSafeInteger(caption.range.start + caption.range.duration)
          || caption.range.start + caption.range.duration > durationFrames)) {
          context.addIssue({ code: z.ZodIssueCode.custom, message: `Caption ${caption.id} exceeds its sequence duration` });
        }
      }
    }
  }
});

export type Rational = z.infer<typeof RationalSchema>;
export type FrameRange = z.infer<typeof FrameRangeSchema>;
export type Asset = z.infer<typeof AssetSchema>;
export type Clip = z.infer<typeof ClipSchema>;
export type Gap = z.infer<typeof GapSchema>;
export type Caption = z.infer<typeof CaptionSchema>;
export type TimelineItem = Clip | Gap | Caption;
export type Track = z.infer<typeof TrackSchema>;
export type Sequence = z.infer<typeof SequenceSchema>;
export type Project = z.infer<typeof ProjectShape>;

export function validateProject(input: unknown): Project {
  return ProjectSchema.parse(input);
}

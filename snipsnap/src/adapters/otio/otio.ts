import { z } from 'zod';
import {
  deterministicUuid,
  digestText,
  rateToRational,
  rationalToRate,
  validateProject,
  type Asset,
  type Caption,
  type Clip,
  type Effect,
  type Extras,
  type Gap,
  type Marker,
  type Project,
  type Rational,
  type Track,
  type Transition,
} from '../../domain';

const RationalTimeSchema = z.object({ value: z.number(), rate: z.number().positive() }).passthrough();
const TimeRangeSchema = z.object({ start_time: RationalTimeSchema, duration: RationalTimeSchema }).passthrough();
// Kdenlive can emit a zero rate for an audio ExternalReference's
// available_range even while the clip source_range has a valid timeline rate.
// OpenTimelineIO accepts that file. Keep editorial ranges strict, but accept
// this editor quirk at the media-reference boundary and repair it on import.
const MediaRationalTimeSchema = z.object({ value: z.number(), rate: z.number().nonnegative() }).passthrough();
const MediaTimeRangeSchema = z.object({
  start_time: MediaRationalTimeSchema,
  duration: MediaRationalTimeSchema,
}).passthrough();
const MediaReferenceSchema = z.object({
  target_url: z.string().optional(),
  available_range: MediaTimeRangeSchema.optional().nullable(),
}).passthrough();
const ItemSchema = z.object({
  OTIO_SCHEMA: z.string(),
  name: z.string().optional().nullable(),
  source_range: TimeRangeSchema.optional().nullable(),
  media_reference: MediaReferenceSchema.optional().nullable(),
  media_references: z.record(MediaReferenceSchema).optional(),
  active_media_reference_key: z.string().optional().nullable(),
  metadata: z.record(z.unknown()).optional(),
}).passthrough();
const TrackInputSchema = z.object({
  OTIO_SCHEMA: z.string(),
  name: z.string().optional().nullable(),
  kind: z.string().optional().nullable(),
  children: z.array(ItemSchema),
  metadata: z.record(z.unknown()).optional(),
}).passthrough();
const TimelineInputSchema = z.object({
  OTIO_SCHEMA: z.string(),
  name: z.string().optional().nullable(),
  global_start_time: RationalTimeSchema.optional().nullable(),
  tracks: z.object({
    children: z.array(TrackInputSchema),
    metadata: z.record(z.unknown()).optional(),
  }).passthrough(),
  metadata: z.record(z.unknown()).optional(),
}).passthrough();

type Json = Record<string, unknown>;
type OtioMetadata = Record<string, unknown>;

export interface UnsupportedContent {
  path: string;
  schema: string;
  reason: string;
}

export interface OtioImportResult {
  project: Project;
  unsupported: UnsupportedContent[];
  mediaLinks: Record<string, string>;
}

export interface OtioExportOptions {
  mediaLinks?: Readonly<Record<string, string>>;
}

export const ZERO_RATE_MEDIA_REASON = 'Media availability used rate 0; interpreted at the clip source rate';

/** Fields this adapter models by name. Everything else is carried in `extras`. */
const ITEM_FIELDS = [
  'OTIO_SCHEMA', 'name', 'source_range', 'media_reference', 'media_references',
  'active_media_reference_key', 'metadata', 'markers', 'effects', 'enabled', 'color',
];
const TRANSITION_FIELDS = [
  'OTIO_SCHEMA', 'name', 'transition_type', 'in_offset', 'out_offset', 'metadata',
  'markers', 'effects', 'enabled',
];
const TRACK_FIELDS = ['OTIO_SCHEMA', 'name', 'kind', 'children', 'metadata', 'markers', 'effects', 'enabled'];
const STACK_FIELDS = ['OTIO_SCHEMA', 'name', 'children', 'metadata', 'markers', 'effects', 'enabled'];
const TIMELINE_FIELDS = ['OTIO_SCHEMA', 'name', 'tracks', 'global_start_time', 'metadata'];
const MARKER_FIELDS = ['OTIO_SCHEMA', 'name', 'color', 'marked_range', 'comment'];
const MEDIA_FIELDS = ['OTIO_SCHEMA', 'target_url', 'available_range', 'name'];

/** Fields the exporter always writes; an empty one carries no editorial meaning. */
const STRUCTURAL_NULLABLE = ['source_range', 'color', 'available_image_bounds'];

function isJson(value: unknown): boolean {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJson);
  if (typeof value === 'object') return Object.values(value as Json).every((item) => item === undefined || isJson(item));
  return false;
}

/** Copy every field the model does not name, so nothing is lost on import. */
function extrasOf(source: Json | undefined, modelled: string[]): Extras {
  const extras: Extras = {};
  for (const [key, value] of Object.entries(source ?? {})) {
    if (modelled.includes(key) || value === undefined) continue;
    if (value === null && STRUCTURAL_NULLABLE.includes(key)) continue;
    if (isJson(value)) extras[key] = value as Extras[string];
  }
  return extras;
}

function videogitMetadata(metadata: OtioMetadata | undefined): Record<string, unknown> {
  const value = metadata?.videogit;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** Editor metadata other than our own must survive a round trip untouched. */
function foreignMetadata(metadata: OtioMetadata | undefined): Extras | undefined {
  const rest = extrasOf(metadata as Json | undefined, ['videogit']);
  return Object.keys(rest).length > 0 ? rest : undefined;
}

function metadataId(metadata: OtioMetadata | undefined, seed: string): string {
  const candidate = videogitMetadata(metadata).id;
  return typeof candidate === 'string' && z.string().uuid().safeParse(candidate).success
    ? candidate
    : deterministicUuid(seed);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.normalize('NFC') : '';
}

function basename(targetUrl: string): string {
  const clean = targetUrl.split(/[?#]/u)[0] ?? targetUrl;
  const segment = clean.split(/[\\/]/u).filter(Boolean).at(-1);
  try {
    return decodeURIComponent(segment || 'external-media');
  } catch {
    return segment || 'external-media';
  }
}

function mediaReference(item: z.infer<typeof ItemSchema>) {
  if (item.media_reference) return item.media_reference;
  const key = item.active_media_reference_key ?? 'DEFAULT_MEDIA';
  return item.media_references?.[key] ?? Object.values(item.media_references ?? {})[0];
}

function schemaName(value: unknown, fallback: string): string {
  if (value && typeof value === 'object' && 'OTIO_SCHEMA' in value
    && typeof (value as { OTIO_SCHEMA?: unknown }).OTIO_SCHEMA === 'string') {
    return (value as { OTIO_SCHEMA: string }).OTIO_SCHEMA;
  }
  return fallback;
}

/** Frames stay exact when the source already speaks the timeline's rate. */
function frames(value: number, fromRate: number, fps: Rational): number {
  const target = rationalToRate(fps);
  if (fromRate === target) return Math.round(value);
  return Math.round((value / fromRate) * target);
}

function timeFrames(time: { value: number; rate: number } | undefined, fps: Rational): number {
  return time ? frames(time.value, time.rate, fps) : 0;
}

function mediaTimeFrames(
  time: { value: number; rate: number },
  fallbackRate: number,
  fps: Rational,
): number {
  return frames(time.value, time.rate > 0 ? time.rate : fallbackRate, fps);
}

function importMarkers(value: unknown, fps: Rational): Marker[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const raw = (entry ?? {}) as Json;
    const range = TimeRangeSchema.safeParse(raw.marked_range);
    return {
      name: text(raw.name),
      color: text(raw.color) || 'RED',
      start: range.success ? Math.max(0, timeFrames(range.data.start_time, fps)) : 0,
      duration: range.success ? Math.max(0, timeFrames(range.data.duration, fps)) : 0,
      comment: text(raw.comment),
      extras: extrasOf(raw, MARKER_FIELDS),
    };
  });
}

function importEffects(value: unknown): Effect[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const raw = (entry ?? {}) as Json;
    return {
      name: text(raw.name),
      schema: schemaName(raw, 'Effect.1'),
      parameters: extrasOf(raw, ['OTIO_SCHEMA', 'name']),
    };
  });
}

function importDecorations(raw: Json, fps: Rational, modelled: string[]) {
  return {
    enabled: raw.enabled !== false,
    markers: importMarkers(raw.markers, fps),
    effects: importEffects(raw.effects),
    extras: {
      ...extrasOf(raw, modelled),
      ...(foreignMetadata(raw.metadata as OtioMetadata | undefined) ? { metadata: foreignMetadata(raw.metadata as OtioMetadata | undefined) as Extras[string] } : {}),
    },
  };
}

/** Pick the rate the timeline itself declares, falling back to what its items use. */
function getRate(timeline: z.infer<typeof TimelineInputSchema>): Rational {
  if (timeline.global_start_time?.rate) return rateToRational(timeline.global_start_time.rate);
  const counts = new Map<number, number>();
  for (const track of timeline.tracks.children) {
    for (const item of track.children) {
      const rate = item.source_range?.duration.rate
        ?? mediaReference(item)?.available_range?.duration.rate;
      if (rate) counts.set(rate, (counts.get(rate) ?? 0) + 1);
    }
  }
  const best = [...counts.entries()].sort((left, right) => right[1] - left[1] || right[0] - left[0])[0];
  return best ? rateToRational(best[0]) : { numerator: 24, denominator: 1 };
}

export function importOtio(input: string | unknown): OtioImportResult {
  const raw = typeof input === 'string' ? JSON.parse(input) as unknown : input;
  const timeline = TimelineInputSchema.parse(raw);
  if (!timeline.OTIO_SCHEMA.startsWith('Timeline.')) {
    throw new Error(`Expected an OTIO Timeline, received ${timeline.OTIO_SCHEMA}`);
  }

  const name = text(timeline.name) || 'Imported Timeline';
  const fps = getRate(timeline);
  const projectId = metadataId(timeline.metadata, `otio:${name}:project`);
  const stack = timeline.tracks as unknown as Json;
  const sequenceMeta = videogitMetadata(timeline.tracks.metadata);
  const sequenceId = typeof sequenceMeta.id === 'string' && z.string().uuid().safeParse(sequenceMeta.id).success
    ? sequenceMeta.id
    : deterministicUuid(`${projectId}:sequence`);
  const tracks: Track[] = [];
  const assetsByFingerprint = new Map<string, Asset>();
  const clips: Clip[] = [];
  const gaps: Gap[] = [];
  const transitions: Transition[] = [];
  const captions: Caption[] = [];
  const unsupported: UnsupportedContent[] = [];
  const mediaLinks: Record<string, string> = {};

  timeline.tracks.children.forEach((trackInput, trackIndex) => {
    const trackPath = `tracks[${trackIndex}]`;
    if (!trackInput.OTIO_SCHEMA.startsWith('Track.')) {
      unsupported.push({ path: trackPath, schema: trackInput.OTIO_SCHEMA, reason: 'Only OTIO Track objects are supported' });
      return;
    }
    const trackMeta = videogitMetadata(trackInput.metadata);
    const declaredKind = trackMeta.kind;
    const inputKind = trackInput.kind?.toLowerCase();
    if (declaredKind !== 'caption' && inputKind !== undefined && inputKind !== null
      && inputKind !== 'audio' && inputKind !== 'video') {
      unsupported.push({ path: `${trackPath}.kind`, schema: trackInput.OTIO_SCHEMA, reason: `Unsupported track kind ${trackInput.kind}` });
    }
    const kind: Track['kind'] = declaredKind === 'caption'
      ? 'caption'
      : inputKind === 'audio' ? 'audio' : 'video';
    const trackId = metadataId(trackInput.metadata, `${projectId}:track:${trackIndex}:${kind}`);
    const itemIds: string[] = [];

    trackInput.children.forEach((item, itemIndex) => {
      const itemPath = `${trackPath}.children[${itemIndex}]`;
      const itemRaw = item as unknown as Json;
      const seed = `${trackId}:item:${itemIndex}:${item.name ?? ''}`;
      const itemId = metadataId(item.metadata, seed);
      const schema = item.OTIO_SCHEMA;
      const range = item.source_range;

      if (schema.startsWith('Transition.')) {
        const inOffset = RationalTimeSchema.safeParse(itemRaw.in_offset);
        const outOffset = RationalTimeSchema.safeParse(itemRaw.out_offset);
        transitions.push({
          id: itemId,
          type: 'transition',
          trackId,
          name: text(item.name) || 'Transition',
          transitionType: text(itemRaw.transition_type) || 'Custom',
          inOffsetFrames: inOffset.success ? Math.max(0, timeFrames(inOffset.data, fps)) : 0,
          outOffsetFrames: outOffset.success ? Math.max(0, timeFrames(outOffset.data, fps)) : 0,
          ...importDecorations(itemRaw, fps, TRANSITION_FIELDS),
        });
        itemIds.push(itemId);
        return;
      }

      if (schema.startsWith('Gap.')) {
        if (!range) {
          unsupported.push({ path: itemPath, schema, reason: 'Gap has no source range' });
          return;
        }
        gaps.push({
          id: itemId,
          type: 'gap',
          trackId,
          durationFrames: Math.max(1, frames(range.duration.value, range.duration.rate, fps)),
          ...importDecorations(itemRaw, fps, ITEM_FIELDS),
        });
        itemIds.push(itemId);
        return;
      }

      if (!schema.startsWith('Clip.')) {
        unsupported.push({ path: itemPath, schema, reason: 'V1 supports Clip, Gap, and Transition items only' });
        return;
      }

      const itemMeta = videogitMetadata(item.metadata);
      const decoration = importDecorations(itemRaw, fps, ITEM_FIELDS);
      if (itemMeta.kind === 'caption') {
        if (!range) {
          unsupported.push({ path: itemPath, schema, reason: 'Caption has no range' });
          return;
        }
        captions.push({
          id: itemId,
          type: 'caption',
          trackId,
          text: typeof itemMeta.text === 'string' ? itemMeta.text.normalize('NFC') : text(item.name),
          range: {
            start: Math.max(0, frames(range.start_time.value, range.start_time.rate, fps)),
            duration: Math.max(1, frames(range.duration.value, range.duration.rate, fps)),
          },
          style: itemMeta.style === 'title' || itemMeta.style === 'subtitle' ? itemMeta.style : 'default',
          ...decoration,
        });
        itemIds.push(itemId);
        return;
      }

      if (!range) {
        unsupported.push({ path: itemPath, schema, reason: 'Clip has no source range' });
        return;
      }
      const references = Object.keys(item.media_references ?? {});
      if (references.length > 1) {
        const activeKey = item.active_media_reference_key ?? 'DEFAULT_MEDIA';
        references.filter((key) => key !== activeKey).forEach((key) => unsupported.push({
          path: `${itemPath}.media_references.${key}`,
          schema: schemaName(item.media_references?.[key], 'MediaReference.1'),
          reason: 'V1 preserves only the active media reference',
        }));
      }
      const media = mediaReference(item);
      const targetUrl = media?.target_url ?? `missing://${item.name ?? itemId}`;
      const fingerprint = typeof itemMeta.assetFingerprint === 'string' && /^[a-f0-9]{64}$/u.test(itemMeta.assetFingerprint)
        ? itemMeta.assetFingerprint
        : digestText(targetUrl.normalize('NFC'));
      if (!targetUrl.startsWith('missing://') && !targetUrl.startsWith('videogit://')) {
        mediaLinks[fingerprint] = targetUrl;
      }
      const mediaRange = media?.available_range;
      if (mediaRange && (mediaRange.start_time.rate === 0 || mediaRange.duration.rate === 0)) {
        const activeKey = item.active_media_reference_key ?? 'DEFAULT_MEDIA';
        const referencePath = item.media_reference
          ? `${itemPath}.media_reference`
          : `${itemPath}.media_references.${activeKey}`;
        unsupported.push({
          path: `${referencePath}.available_range`,
          schema: schemaName(mediaRange, 'TimeRange.1'),
          reason: ZERO_RATE_MEDIA_REASON,
        });
      }
      const duration = Math.max(
        frames(range.start_time.value + range.duration.value, range.duration.rate, fps),
        mediaRange
          ? mediaTimeFrames(mediaRange.start_time, range.start_time.rate, fps)
            + mediaTimeFrames(mediaRange.duration, range.duration.rate, fps)
          : 1,
      );
      // A media reference names the file; the URL basename is only a fallback.
      const assetName = text(media?.name as string | undefined) || basename(targetUrl).normalize('NFC');
      // A title or other generator has no file by nature. Recording that keeps
      // it from being reported as footage that has gone missing.
      const generated = !media?.target_url;
      let asset = assetsByFingerprint.get(fingerprint);
      if (!asset) {
        asset = {
          id: typeof itemMeta.assetId === 'string' && z.string().uuid().safeParse(itemMeta.assetId).success
            ? itemMeta.assetId
            : deterministicUuid(`asset:${fingerprint}`),
          name: assetName || 'external-media',
          fingerprint,
          durationFrames: Math.max(1, duration),
          extras: {
            ...extrasOf(media as Json | undefined, MEDIA_FIELDS),
            ...(generated ? { generator: true } : {}),
          },
        };
        assetsByFingerprint.set(fingerprint, asset);
      } else if (duration > asset.durationFrames) {
        asset.durationFrames = duration;
      }
      const resolvedAsset = asset;
      clips.push({
        id: itemId,
        type: 'clip',
        trackId,
        name: text(item.name) || resolvedAsset.name,
        assetId: resolvedAsset.id,
        sourceRange: {
          start: Math.max(0, frames(range.start_time.value, range.start_time.rate, fps)),
          duration: Math.max(1, frames(range.duration.value, range.duration.rate, fps)),
        },
        gainDb: typeof itemMeta.gainDb === 'number' ? itemMeta.gainDb : 0,
        preset: itemMeta.preset === 'warm' || itemMeta.preset === 'cool' || itemMeta.preset === 'mono' ? itemMeta.preset : 'none',
        color: typeof itemRaw.color === 'string' ? itemRaw.color.normalize('NFC') : null,
        ...decoration,
      });
      itemIds.push(itemId);
    });

    tracks.push({
      id: trackId,
      sequenceId,
      name: text(trackInput.name) || `${kind.toUpperCase()} ${trackIndex + 1}`,
      kind,
      itemIds,
      ...importDecorations(trackInput as unknown as Json, fps, TRACK_FIELDS),
    });
  });

  const stackDecoration = importDecorations(stack, fps, STACK_FIELDS);
  const project = validateProject({
    schemaVersion: 1,
    id: projectId,
    name,
    sequences: [{
      id: sequenceId,
      name: typeof sequenceMeta.name === 'string' ? sequenceMeta.name.normalize('NFC') : name,
      fps,
      width: typeof sequenceMeta.width === 'number' && Number.isInteger(sequenceMeta.width) ? sequenceMeta.width : 1920,
      height: typeof sequenceMeta.height === 'number' && Number.isInteger(sequenceMeta.height) ? sequenceMeta.height : 1080,
      trackIds: tracks.map(({ id }) => id),
      globalStartFrame: timeFrames(timeline.global_start_time ?? undefined, fps),
      markers: stackDecoration.markers,
      extras: { ...stackDecoration.extras, ...(stackDecoration.enabled ? {} : { enabled: false }) },
    }],
    tracks,
    assets: [...assetsByFingerprint.values()],
    clips,
    gaps,
    transitions,
    captions,
    extras: extrasOf(raw as Json, TIMELINE_FIELDS),
  });
  return { project, unsupported, mediaLinks };
}

function otioTime(value: number, rate: number) {
  return { OTIO_SCHEMA: 'RationalTime.1', value, rate };
}

function otioRange(start: number, duration: number, rate: number) {
  return {
    OTIO_SCHEMA: 'TimeRange.1',
    start_time: otioTime(start, rate),
    duration: otioTime(duration, rate),
  };
}

function exportMarkers(markers: Marker[], rate: number): Json[] {
  return markers.map((marker) => ({
    OTIO_SCHEMA: 'Marker.2',
    ...marker.extras,
    name: marker.name,
    color: marker.color,
    marked_range: otioRange(marker.start, marker.duration, rate),
    comment: marker.comment,
  }));
}

function exportEffects(effects: Effect[]): Json[] {
  return effects.map((effect) => ({
    OTIO_SCHEMA: effect.schema,
    ...effect.parameters,
    name: effect.name,
  }));
}

/** Rebuild the fields the model does not name, then the ones it does. */
function withExtras(extras: Extras, base: Json): Json {
  const { metadata: foreign, ...rest } = extras;
  const merged: Json = { ...rest, ...base };
  if (foreign && typeof foreign === 'object' && !Array.isArray(foreign)) {
    merged.metadata = { ...(foreign as Json), ...(base.metadata as Json | undefined ?? {}) };
  }
  return merged;
}

export function exportOtio(projectInput: Project, options: OtioExportOptions = {}): string {
  const project = validateProject(projectInput);
  const sequence = project.sequences[0];
  if (!sequence) throw new Error('Project has no sequence');
  const rate = rationalToRate(sequence.fps);
  const clipById = new Map(project.clips.map((clip) => [clip.id, clip]));
  const gapById = new Map(project.gaps.map((gap) => [gap.id, gap]));
  const transitionById = new Map(project.transitions.map((transition) => [transition.id, transition]));
  const captionById = new Map(project.captions.map((caption) => [caption.id, caption]));
  const assetById = new Map(project.assets.map((asset) => [asset.id, asset]));

  const tracks = sequence.trackIds.map((trackId) => {
    const track = project.tracks.find(({ id }) => id === trackId);
    if (!track) throw new Error(`Missing track ${trackId}`);
    const children = track.itemIds.map((itemId): Json => {
      const transition = transitionById.get(itemId);
      if (transition) {
        return withExtras(transition.extras, {
          OTIO_SCHEMA: 'Transition.1',
          name: transition.name,
          transition_type: transition.transitionType,
          in_offset: otioTime(transition.inOffsetFrames, rate),
          out_offset: otioTime(transition.outOffsetFrames, rate),
          markers: exportMarkers(transition.markers, rate),
          effects: exportEffects(transition.effects),
          enabled: transition.enabled,
          metadata: { videogit: { id: transition.id } },
        });
      }
      const gap = gapById.get(itemId);
      if (gap) {
        return withExtras(gap.extras, {
          OTIO_SCHEMA: 'Gap.1',
          name: 'Gap',
          source_range: otioRange(0, gap.durationFrames, rate),
          effects: exportEffects(gap.effects),
          markers: exportMarkers(gap.markers, rate),
          enabled: gap.enabled,
          color: null,
          metadata: { videogit: { id: gap.id } },
        });
      }
      const caption = captionById.get(itemId);
      if (caption) {
        return withExtras(caption.extras, {
          OTIO_SCHEMA: 'Clip.2',
          name: caption.text,
          source_range: otioRange(caption.range.start, caption.range.duration, rate),
          effects: exportEffects(caption.effects),
          markers: exportMarkers(caption.markers, rate),
          enabled: caption.enabled,
          color: null,
          media_references: {
            DEFAULT_MEDIA: {
              OTIO_SCHEMA: 'MissingReference.1',
              name: '',
              available_range: null,
              available_image_bounds: null,
              metadata: {},
            },
          },
          active_media_reference_key: 'DEFAULT_MEDIA',
          metadata: { videogit: { id: caption.id, kind: 'caption', text: caption.text, style: caption.style } },
        });
      }
      const clip = clipById.get(itemId);
      if (!clip) throw new Error(`Missing timeline item ${itemId}`);
      const asset = assetById.get(clip.assetId);
      if (!asset) throw new Error(`Missing asset ${clip.assetId}`);
      const generated = asset.extras.generator === true;
      // Our own marker is not an OTIO field, so it never reaches the file.
      const mediaExtras = { ...asset.extras };
      delete mediaExtras.generator;
      return withExtras(clip.extras, {
        OTIO_SCHEMA: 'Clip.2',
        name: clip.name,
        source_range: otioRange(clip.sourceRange.start, clip.sourceRange.duration, rate),
        effects: exportEffects(clip.effects),
        markers: exportMarkers(clip.markers, rate),
        enabled: clip.enabled,
        color: clip.color,
        media_references: {
          // A generator has no file to point at, so it goes back out as the
          // reference that says so rather than as a URL that resolves nowhere.
          DEFAULT_MEDIA: generated
            ? {
              ...mediaExtras,
              OTIO_SCHEMA: 'MissingReference.1',
              name: asset.name,
              available_range: otioRange(0, asset.durationFrames, rate),
            }
            : {
              ...mediaExtras,
              OTIO_SCHEMA: 'ExternalReference.1',
              name: asset.name,
              target_url: options.mediaLinks?.[asset.fingerprint]
                ?? `videogit://asset/${asset.fingerprint}/${encodeURIComponent(asset.name)}`,
              available_range: otioRange(0, asset.durationFrames, rate),
            },
        },
        active_media_reference_key: 'DEFAULT_MEDIA',
        metadata: {
          videogit: {
            id: clip.id,
            assetId: asset.id,
            assetFingerprint: asset.fingerprint,
            gainDb: clip.gainDb,
            preset: clip.preset,
          },
        },
      });
    });
    return withExtras(track.extras, {
      OTIO_SCHEMA: 'Track.1',
      name: track.name,
      kind: track.kind === 'audio' ? 'Audio' : 'Video',
      children,
      source_range: null,
      effects: exportEffects(track.effects),
      markers: exportMarkers(track.markers, rate),
      enabled: track.enabled,
      color: null,
      metadata: { videogit: { id: track.id, kind: track.kind } },
    });
  });

  const timeline = withExtras(project.extras, {
    OTIO_SCHEMA: 'Timeline.1',
    name: project.name,
    global_start_time: sequence.globalStartFrame === 0
      ? null
      : otioTime(sequence.globalStartFrame, rate),
    tracks: withExtras(sequence.extras, {
      OTIO_SCHEMA: 'Stack.1',
      name: 'tracks',
      children: tracks,
      source_range: null,
      effects: [],
      markers: exportMarkers(sequence.markers, rate),
      enabled: true,
      metadata: {
        videogit: {
          id: sequence.id,
          name: sequence.name,
          width: sequence.width,
          height: sequence.height,
        },
      },
    }),
    metadata: { videogit: { id: project.id } },
  });

  return `${JSON.stringify(timeline, null, 2)}\n`;
}

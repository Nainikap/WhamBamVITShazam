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
  type Gap,
  type Project,
  type Rational,
  type Track,
} from '../../domain';

const RationalTimeSchema = z.object({ value: z.number(), rate: z.number().positive() }).passthrough();
const TimeRangeSchema = z.object({ start_time: RationalTimeSchema, duration: RationalTimeSchema }).passthrough();
const ItemSchema = z.object({
  OTIO_SCHEMA: z.string(),
  name: z.string().optional(),
  source_range: TimeRangeSchema.optional().nullable(),
  media_reference: z.object({
    target_url: z.string().optional(),
    available_range: TimeRangeSchema.optional().nullable(),
  }).passthrough().optional().nullable(),
  media_references: z.record(z.object({
    target_url: z.string().optional(),
    available_range: TimeRangeSchema.optional().nullable(),
  }).passthrough()).optional(),
  active_media_reference_key: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
}).passthrough();
const TrackInputSchema = z.object({
  OTIO_SCHEMA: z.string(),
  name: z.string().optional(),
  kind: z.string().optional(),
  children: z.array(ItemSchema),
  metadata: z.record(z.unknown()).optional(),
}).passthrough();
const TimelineInputSchema = z.object({
  OTIO_SCHEMA: z.string(),
  name: z.string().optional(),
  tracks: z.object({
    children: z.array(TrackInputSchema),
    metadata: z.record(z.unknown()).optional(),
  }).passthrough(),
  metadata: z.record(z.unknown()).optional(),
}).passthrough();

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

function videogitMetadata(metadata: OtioMetadata | undefined): Record<string, unknown> {
  const value = metadata?.videogit;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function metadataId(metadata: OtioMetadata | undefined, seed: string): string {
  const candidate = videogitMetadata(metadata).id;
  return typeof candidate === 'string' && z.string().uuid().safeParse(candidate).success
    ? candidate
    : deterministicUuid(seed);
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

function reportArray(
  value: unknown,
  path: string,
  reason: string,
  unsupported: UnsupportedContent[],
): void {
  if (!Array.isArray(value)) return;
  value.forEach((entry, index) => unsupported.push({
    path: `${path}[${index}]`,
    schema: schemaName(entry, 'Unknown.1'),
    reason,
  }));
}

function reportDecorations(
  value: Record<string, unknown>,
  path: string,
  unsupported: UnsupportedContent[],
): void {
  reportArray(value.effects, `${path}.effects`, 'V1 does not preserve effects', unsupported);
  reportArray(value.markers, `${path}.markers`, 'V1 does not preserve markers', unsupported);
  if (value.enabled === false) {
    unsupported.push({ path: `${path}.enabled`, schema: schemaName(value, 'Unknown.1'), reason: 'V1 does not preserve disabled state' });
  }
  if (value.color !== undefined && value.color !== null) {
    unsupported.push({ path: `${path}.color`, schema: schemaName(value, 'Unknown.1'), reason: 'V1 does not preserve color labels' });
  }
}

function getRate(timeline: z.infer<typeof TimelineInputSchema>): Rational {
  for (const track of timeline.tracks.children) {
    for (const item of track.children) {
      const rate = item.source_range?.duration.rate ?? item.media_reference?.available_range?.duration.rate;
      if (rate) return rateToRational(rate);
    }
  }
  return { numerator: 24, denominator: 1 };
}

function frames(value: number, fromRate: number, fps: Rational): number {
  return Math.round((value / fromRate) * rationalToRate(fps));
}

export function importOtio(input: string | unknown): OtioImportResult {
  const raw = typeof input === 'string' ? JSON.parse(input) as unknown : input;
  const timeline = TimelineInputSchema.parse(raw);
  if (!timeline.OTIO_SCHEMA.startsWith('Timeline.')) {
    throw new Error(`Expected an OTIO Timeline, received ${timeline.OTIO_SCHEMA}`);
  }

  const name = timeline.name?.normalize('NFC') || 'Imported Timeline';
  const fps = getRate(timeline);
  const projectId = metadataId(timeline.metadata, `otio:${name}:project`);
  const sequenceMeta = videogitMetadata(timeline.tracks.metadata);
  const sequenceId = typeof sequenceMeta.id === 'string' && z.string().uuid().safeParse(sequenceMeta.id).success
    ? sequenceMeta.id
    : deterministicUuid(`${projectId}:sequence`);
  const tracks: Track[] = [];
  const assetsByFingerprint = new Map<string, Asset>();
  const clips: Clip[] = [];
  const gaps: Gap[] = [];
  const captions: Caption[] = [];
  const unsupported: UnsupportedContent[] = [];
  const mediaLinks: Record<string, string> = {};

  reportDecorations(timeline, 'timeline', unsupported);
  reportDecorations(timeline.tracks, 'tracks', unsupported);
  if (timeline.global_start_time !== undefined && timeline.global_start_time !== null) {
    unsupported.push({
      path: 'global_start_time',
      schema: schemaName(timeline.global_start_time, 'RationalTime.1'),
      reason: 'V1 timelines always begin at frame zero',
    });
  }
  if (timeline.tracks.source_range !== undefined && timeline.tracks.source_range !== null) {
    unsupported.push({
      path: 'tracks.source_range',
      schema: schemaName(timeline.tracks.source_range, 'TimeRange.1'),
      reason: 'V1 does not preserve stack source ranges',
    });
  }

  timeline.tracks.children.forEach((trackInput, trackIndex) => {
    const trackPath = `tracks[${trackIndex}]`;
    reportDecorations(trackInput, trackPath, unsupported);
    if (!trackInput.OTIO_SCHEMA.startsWith('Track.')) {
      unsupported.push({ path: trackPath, schema: trackInput.OTIO_SCHEMA, reason: 'Only OTIO Track objects are supported' });
      return;
    }
    if (trackInput.source_range !== undefined && trackInput.source_range !== null) {
      unsupported.push({
        path: `${trackPath}.source_range`,
        schema: schemaName(trackInput.source_range, 'TimeRange.1'),
        reason: 'V1 does not preserve track source ranges',
      });
    }
    const trackMeta = videogitMetadata(trackInput.metadata);
    const declaredKind = trackMeta.kind;
    const inputKind = trackInput.kind?.toLowerCase();
    if (declaredKind !== 'caption' && inputKind !== undefined && inputKind !== 'audio' && inputKind !== 'video') {
      unsupported.push({ path: `${trackPath}.kind`, schema: trackInput.OTIO_SCHEMA, reason: `Unsupported track kind ${trackInput.kind}` });
    }
    const kind: Track['kind'] = declaredKind === 'caption'
      ? 'caption'
      : inputKind === 'audio' ? 'audio' : 'video';
    const trackId = metadataId(trackInput.metadata, `${projectId}:track:${trackIndex}:${kind}`);
    const itemIds: string[] = [];

    trackInput.children.forEach((item, itemIndex) => {
      const itemPath = `${trackPath}.children[${itemIndex}]`;
      reportDecorations(item, itemPath, unsupported);
      const seed = `${trackId}:item:${itemIndex}:${item.name ?? ''}`;
      const itemId = metadataId(item.metadata, seed);
      const schema = item.OTIO_SCHEMA;
      const range = item.source_range;

      if (schema.startsWith('Gap.')) {
        if (!range) {
          unsupported.push({ path: itemPath, schema, reason: 'Gap has no source range' });
          return;
        }
        gaps.push({ id: itemId, type: 'gap', trackId, durationFrames: Math.max(1, frames(range.duration.value, range.duration.rate, fps)) });
        itemIds.push(itemId);
        return;
      }

      if (!schema.startsWith('Clip.')) {
        unsupported.push({ path: itemPath, schema, reason: 'V1 supports Clip and Gap items only' });
        return;
      }

      const itemMeta = videogitMetadata(item.metadata);
      if (itemMeta.kind === 'caption') {
        if (!range) {
          unsupported.push({ path: itemPath, schema, reason: 'Caption has no range' });
          return;
        }
        captions.push({
          id: itemId,
          type: 'caption',
          trackId,
          text: typeof itemMeta.text === 'string' ? itemMeta.text.normalize('NFC') : item.name ?? '',
          range: {
            start: Math.max(0, frames(range.start_time.value, range.start_time.rate, fps)),
            duration: Math.max(1, frames(range.duration.value, range.duration.rate, fps)),
          },
          style: itemMeta.style === 'title' || itemMeta.style === 'subtitle' ? itemMeta.style : 'default',
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
      const duration = Math.max(
        frames(range.start_time.value + range.duration.value, range.duration.rate, fps),
        media?.available_range
          ? frames(
            media.available_range.start_time.value + media.available_range.duration.value,
            media.available_range.duration.rate,
            fps,
          )
          : 1,
      );
      let asset = assetsByFingerprint.get(fingerprint);
      if (!asset) {
        asset = {
          id: typeof itemMeta.assetId === 'string' && z.string().uuid().safeParse(itemMeta.assetId).success
            ? itemMeta.assetId
            : deterministicUuid(`asset:${fingerprint}`),
          name: basename(targetUrl).normalize('NFC'),
          fingerprint,
          durationFrames: Math.max(1, duration),
        };
        assetsByFingerprint.set(fingerprint, asset);
      } else if (duration > asset.durationFrames) {
        asset.durationFrames = duration;
      }
      clips.push({
        id: itemId,
        type: 'clip',
        trackId,
        name: (item.name || asset.name).normalize('NFC'),
        assetId: asset.id,
        sourceRange: {
          start: Math.max(0, frames(range.start_time.value, range.start_time.rate, fps)),
          duration: Math.max(1, frames(range.duration.value, range.duration.rate, fps)),
        },
        gainDb: typeof itemMeta.gainDb === 'number' ? itemMeta.gainDb : 0,
        preset: itemMeta.preset === 'warm' || itemMeta.preset === 'cool' || itemMeta.preset === 'mono' ? itemMeta.preset : 'none',
      });
      itemIds.push(itemId);
    });

    tracks.push({
      id: trackId,
      sequenceId,
      name: (trackInput.name || `${kind.toUpperCase()} ${trackIndex + 1}`).normalize('NFC'),
      kind,
      itemIds,
    });
  });

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
    }],
    tracks,
    assets: [...assetsByFingerprint.values()],
    clips,
    gaps,
    captions,
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

export function exportOtio(projectInput: Project, options: OtioExportOptions = {}): string {
  const project = validateProject(projectInput);
  const sequence = project.sequences[0];
  if (!sequence) throw new Error('Project has no sequence');
  const rate = rationalToRate(sequence.fps);
  const clipById = new Map(project.clips.map((clip) => [clip.id, clip]));
  const gapById = new Map(project.gaps.map((gap) => [gap.id, gap]));
  const captionById = new Map(project.captions.map((caption) => [caption.id, caption]));
  const assetById = new Map(project.assets.map((asset) => [asset.id, asset]));

  const tracks = sequence.trackIds.map((trackId) => {
    const track = project.tracks.find(({ id }) => id === trackId);
    if (!track) throw new Error(`Missing track ${trackId}`);
    const children = track.itemIds.map((itemId) => {
      const gap = gapById.get(itemId);
      if (gap) {
        return {
          OTIO_SCHEMA: 'Gap.1',
          name: 'Gap',
          source_range: otioRange(0, gap.durationFrames, rate),
          effects: [],
          markers: [],
          enabled: true,
          color: null,
          metadata: { videogit: { id: gap.id } },
        };
      }
      const caption = captionById.get(itemId);
      if (caption) {
        return {
          OTIO_SCHEMA: 'Clip.2',
          name: caption.text,
          source_range: otioRange(caption.range.start, caption.range.duration, rate),
          effects: [],
          markers: [],
          enabled: true,
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
        };
      }
      const clip = clipById.get(itemId);
      if (!clip) throw new Error(`Missing timeline item ${itemId}`);
      const asset = assetById.get(clip.assetId);
      if (!asset) throw new Error(`Missing asset ${clip.assetId}`);
      return {
        OTIO_SCHEMA: 'Clip.2',
        name: clip.name,
        source_range: otioRange(clip.sourceRange.start, clip.sourceRange.duration, rate),
        effects: [],
        markers: [],
        enabled: true,
        color: null,
        media_references: {
          DEFAULT_MEDIA: {
            OTIO_SCHEMA: 'ExternalReference.1',
            name: asset.name,
            target_url: options.mediaLinks?.[asset.fingerprint]
              ?? `videogit://asset/${asset.fingerprint}/${encodeURIComponent(asset.name)}`,
            available_range: otioRange(0, asset.durationFrames, rate),
            available_image_bounds: null,
            metadata: {},
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
      };
    });
    return {
      OTIO_SCHEMA: 'Track.1',
      name: track.name,
      kind: track.kind === 'audio' ? 'Audio' : 'Video',
      children,
      source_range: null,
      effects: [],
      markers: [],
      enabled: true,
      color: null,
      metadata: { videogit: { id: track.id, kind: track.kind } },
    };
  });

  return `${JSON.stringify({
    OTIO_SCHEMA: 'Timeline.1',
    name: project.name,
    global_start_time: null,
    tracks: {
      OTIO_SCHEMA: 'Stack.1',
      name: 'tracks',
      children: tracks,
      source_range: null,
      effects: [],
      markers: [],
      enabled: true,
      color: null,
      metadata: {
        videogit: {
          id: sequence.id,
          name: sequence.name,
          width: sequence.width,
          height: sequence.height,
        },
      },
    },
    metadata: { videogit: { id: project.id, schemaVersion: 1 } },
  }, null, 2)}\n`;
}

import { copyFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { exportOtio } from '../adapters/otio';
import {
  decorations,
  deterministicUuid,
  digestText,
  rationalToRate,
  validateProject,
  type Project,
} from '../domain';
import { probeVideo, type VideoFormat } from './media-probe';

interface SqliteRow { [column: string]: unknown }
interface SqliteDatabase {
  prepare(sql: string): { all(...parameters: unknown[]): SqliteRow[] };
  close(): void;
}
type SqliteModule = {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteDatabase;
};

function loadSqlite(): SqliteModule | null {
  try {
    return createRequire(__filename)('node:sqlite') as SqliteModule;
  } catch {
    return null;
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function count(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : 0;
}

export interface GeneratedTimeline {
  name: string;
  project: Project;
  mediaLinks: Record<string, string>;
  missingMedia: string[];
}

interface RawItem {
  name: string;
  start: number;
  duration: number;
  sourceIn: number;
  mediaPath: string;
  trackId: string;
}

/**
 * Rebuild a timeline from Resolve's own project database.
 *
 * Resolve does not record the timeline's frame rate or frame size anywhere the
 * database exposes, so both are read from the media the timeline points at. A
 * timeline whose media cannot be measured is skipped rather than guessed at:
 * an invented frame rate would move every timestamp in it.
 */
export async function readResolveTimelines(databasePath: string): Promise<GeneratedTimeline[]> {
  const sqlite = loadSqlite();
  if (!sqlite) return [];
  const copy = `${databasePath}.snipsnap-build`;
  const formats = new Map<string, VideoFormat | null>();

  try {
    await copyFile(databasePath, copy);
    const database = new sqlite.DatabaseSync(copy, { readOnly: true });
    let timelines: SqliteRow[];
    let containers: SqliteRow[];
    let tracks: SqliteRow[];
    let items: SqliteRow[];
    let projectName = '';
    try {
      timelines = database.prepare('SELECT Name, Sequence FROM Sm2Timeline').all();
      containers = database.prepare('SELECT Sm2SequenceContainer_id, Sm2Sequence_id FROM Sm2SequenceContainer').all();
      tracks = database.prepare(
        'SELECT Sm2TiTrack_id, Type, UserDefinedName, Sm2SequenceContainer_id FROM Sm2TiTrack',
      ).all();
      items = database.prepare(
        'SELECT Name, Start, Duration, "In", MediaFilePath, Sm2TiTrack_id FROM Sm2TiItem',
      ).all();
      projectName = text(database.prepare('SELECT ProjectName FROM SM_Project LIMIT 1').all()[0]?.ProjectName);
    } finally {
      database.close();
    }

    const containerBySequence = new Map(containers.map((row) => [
      text(row.Sm2Sequence_id),
      text(row.Sm2SequenceContainer_id),
    ]));
    const itemsByTrack = new Map<string, RawItem[]>();
    for (const row of items) {
      const trackId = text(row.Sm2TiTrack_id);
      const entry: RawItem = {
        name: text(row.Name),
        start: count(row.Start),
        duration: count(row.Duration),
        sourceIn: count(row.In),
        mediaPath: text(row.MediaFilePath),
        trackId,
      };
      if (entry.duration <= 0 || !entry.mediaPath) continue;
      itemsByTrack.set(trackId, [...itemsByTrack.get(trackId) ?? [], entry]);
    }

    const measure = async (mediaPath: string): Promise<VideoFormat | null> => {
      if (!formats.has(mediaPath)) formats.set(mediaPath, await probeVideo(mediaPath));
      return formats.get(mediaPath) ?? null;
    };

    const results: GeneratedTimeline[] = [];
    for (const timeline of timelines) {
      const name = text(timeline.Name);
      const container = containerBySequence.get(text(timeline.Sequence));
      if (!name || !container) continue;
      const timelineTracks = tracks
        .filter((row) => text(row.Sm2SequenceContainer_id) === container)
        .map((row) => ({
          id: text(row.Sm2TiTrack_id),
          kind: count(row.Type) === 1 ? 'audio' as const : 'video' as const,
          name: text(row.UserDefinedName),
        }))
        .filter((track) => (itemsByTrack.get(track.id) ?? []).length > 0)
        // Video lanes first, then audio, each in the order Resolve named them.
        .sort((left, right) => (left.kind === right.kind ? 0 : left.kind === 'video' ? -1 : 1));
      if (timelineTracks.length === 0) continue;

      const everyItem = timelineTracks.flatMap((track) => itemsByTrack.get(track.id) ?? []);
      const firstVideo = timelineTracks.find((track) => track.kind === 'video');
      const reference = firstVideo ? (itemsByTrack.get(firstVideo.id) ?? [])[0] : everyItem[0];
      const format = reference ? await measure(reference.mediaPath) : null;
      // Without a measurable frame rate every timestamp would be a guess.
      if (!format) continue;

      const fps = rationalToRate(format.fps);
      const origin = Math.min(...everyItem.map((item) => item.start));
      const built = await buildProject({
        projectName: projectName || name,
        timelineName: name,
        format,
        origin,
        tracks: timelineTracks,
        itemsByTrack,
        measure,
        fps,
      });
      if (built) results.push(built);
    }
    return results;
  } catch {
    return [];
  } finally {
    await rm(copy, { force: true });
  }
}

async function buildProject(input: {
  projectName: string;
  timelineName: string;
  format: VideoFormat;
  origin: number;
  tracks: Array<{ id: string; kind: 'video' | 'audio'; name: string }>;
  itemsByTrack: Map<string, RawItem[]>;
  measure(mediaPath: string): Promise<VideoFormat | null>;
  fps: number;
}): Promise<GeneratedTimeline | null> {
  const projectId = deterministicUuid(`resolve-db:${input.projectName}:${input.timelineName}`);
  const sequenceId = deterministicUuid(`${projectId}:sequence`);
  const assets = new Map<string, { id: string; name: string; fingerprint: string; durationFrames: number; extras: object }>();
  const mediaLinks: Record<string, string> = {};
  const missingMedia: string[] = [];
  const clips: unknown[] = [];
  const gaps: unknown[] = [];
  const builtTracks: unknown[] = [];

  for (const [index, track] of input.tracks.entries()) {
    const trackId = deterministicUuid(`${sequenceId}:track:${index}:${track.id}`);
    const ordered = [...input.itemsByTrack.get(track.id) ?? []].sort((left, right) => left.start - right.start);
    const itemIds: string[] = [];
    let cursor = input.origin;

    for (const [position, item] of ordered.entries()) {
      if (item.start > cursor) {
        // Resolve leaves a hole between clips; OTIO spells it as a gap.
        const gapId = deterministicUuid(`${trackId}:gap:${position}`);
        gaps.push({ id: gapId, type: 'gap', trackId, durationFrames: item.start - cursor, ...decorations() });
        itemIds.push(gapId);
        cursor = item.start;
      }
      const url = pathToFileURL(item.mediaPath).href;
      const fingerprint = digestText(url);
      const format = await input.measure(item.mediaPath);
      if (!format) missingMedia.push(item.mediaPath);
      const available = Math.max(format?.frames ?? 0, item.sourceIn + item.duration);
      const existing = assets.get(fingerprint);
      if (existing) existing.durationFrames = Math.max(existing.durationFrames, available);
      else {
        assets.set(fingerprint, {
          id: deterministicUuid(`asset:${fingerprint}`),
          name: path.basename(item.mediaPath),
          fingerprint,
          durationFrames: Math.max(1, available),
          extras: {},
        });
      }
      mediaLinks[fingerprint] = url;

      const clipId = deterministicUuid(`${trackId}:item:${position}:${item.name}`);
      clips.push({
        id: clipId,
        type: 'clip',
        trackId,
        name: item.name || path.basename(item.mediaPath),
        assetId: assets.get(fingerprint)?.id,
        sourceRange: { start: Math.max(0, item.sourceIn), duration: item.duration },
        gainDb: 0,
        preset: 'none',
        color: null,
        ...decorations(),
      });
      itemIds.push(clipId);
      cursor = item.start + item.duration;
    }

    builtTracks.push({
      id: trackId,
      sequenceId,
      name: track.name || `${track.kind === 'audio' ? 'A' : 'V'}${index + 1}`,
      kind: track.kind,
      itemIds,
      ...decorations(),
    });
  }

  try {
    const project = validateProject({
      schemaVersion: 1,
      id: projectId,
      name: input.timelineName,
      sequences: [{
        id: sequenceId,
        name: input.timelineName,
        fps: input.format.fps,
        width: input.format.width,
        height: input.format.height,
        trackIds: builtTracks.map((track) => (track as { id: string }).id),
        globalStartFrame: input.origin,
        markers: [],
        extras: { snipsnap: { generatedFrom: 'resolve-project-database' } },
      }],
      tracks: builtTracks,
      assets: [...assets.values()],
      clips,
      gaps,
      transitions: [],
      captions: [],
      extras: {},
    });
    return { name: input.timelineName, project, mediaLinks, missingMedia };
  } catch {
    return null;
  }
}

/** Write each timeline in a Resolve project database out as an OTIO export. */
export async function writeTimelineExports(databasePath: string, folder: string): Promise<string[]> {
  const timelines = await readResolveTimelines(databasePath);
  const written: string[] = [];
  for (const timeline of timelines) {
    const target = path.join(folder, `${timeline.name.replace(/[/\\:]+/gu, '-')}.otio`);
    await writeFile(target, exportOtio(timeline.project, { mediaLinks: timeline.mediaLinks }), 'utf8');
    written.push(target);
  }
  return written;
}

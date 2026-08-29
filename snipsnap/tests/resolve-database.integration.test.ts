import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { probeVideo, ProjectService, readResolveTimelines, ResolveLibrary } from '../src/application';

function box(type: string, ...parts: Buffer[]): Buffer {
  const payload = Buffer.concat(parts);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(payload.length + header.length, 0);
  header.write(type, 4, 4, 'latin1');
  return Buffer.concat([header, payload]);
}

/** A deterministic MP4 header is enough: probeVideo never reads media samples. */
async function writeSyntheticVideo(file: string): Promise<void> {
  const tkhd = Buffer.alloc(84);
  tkhd.writeUInt32BE(320 * 65_536, 76);
  tkhd.writeUInt32BE(180 * 65_536, 80);
  const mdhd = Buffer.alloc(20);
  mdhd.writeUInt32BE(24, 12);
  mdhd.writeUInt32BE(192, 16);
  const stts = Buffer.alloc(16);
  stts.writeUInt32BE(1, 4);
  stts.writeUInt32BE(192, 8);
  stts.writeUInt32BE(1, 12);
  const trak = box('trak',
    box('tkhd', tkhd),
    box('mdia', box('mdhd', mdhd), box('minf', box('vmhd'), box('stbl', box('stts', stts)))),
  );
  await writeFile(file, Buffer.concat([box('ftyp', Buffer.from('isom')), box('moov', trak)]));
}

/** Build the handful of tables SnipSnap reads out of a Resolve project. */
function writeProjectDatabase(file: string, mediaPath: string): void {
  const { DatabaseSync } = createRequire(__filename)('node:sqlite') as {
    DatabaseSync: new (path: string) => {
      exec(sql: string): void;
      close(): void;
    };
  };
  const database = new DatabaseSync(file);
  database.exec(`
    CREATE TABLE SM_Project (ProjectName TEXT);
    INSERT INTO SM_Project VALUES ('Studio Job');
    CREATE TABLE Sm2Timeline (Name TEXT, Sequence TEXT, ModTimeInSecs INTEGER);
    INSERT INTO Sm2Timeline VALUES ('Hero Cut', 'seq-1', 1);
    CREATE TABLE Sm2SequenceContainer (Sm2SequenceContainer_id TEXT, Sm2Sequence_id TEXT);
    INSERT INTO Sm2SequenceContainer VALUES ('container-1', 'seq-1');
    CREATE TABLE Sm2TiTrack (Sm2TiTrack_id TEXT, Type INTEGER, UserDefinedName TEXT, Sm2SequenceContainer_id TEXT);
    INSERT INTO Sm2TiTrack VALUES ('track-v', 0, 'V1 - Source', 'container-1');
    INSERT INTO Sm2TiTrack VALUES ('track-a', 1, 'A1 - Source', 'container-1');
    CREATE TABLE Sm2TiItem (Name TEXT, Start INTEGER, Duration INTEGER, "In" INTEGER, MediaFilePath TEXT, Sm2TiTrack_id TEXT);
    INSERT INTO Sm2TiItem VALUES ('opening', 216000, 48, 12, '${mediaPath}', 'track-v');
    INSERT INTO Sm2TiItem VALUES ('closing', 216072, 24, 0, '${mediaPath}', 'track-v');
    INSERT INTO Sm2TiItem VALUES ('bed', 216000, 96, 0, '${mediaPath}', 'track-a');
  `);
  database.close();
}

describe('rebuilding a timeline from a Resolve database', () => {
  let root: string;
  let media: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'snipsnap-db-'));
    media = path.join(root, 'source.mp4');
    await writeSyntheticVideo(media);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    delete process.env.SNIPSNAP_RESOLVE_DATABASE;
    delete process.env.SNIPSNAP_RESOLVE_ROOT;
  });

  it('reads frame rate and size from the media, which the database omits', async () => {
    expect(await probeVideo(media)).toMatchObject({
      fps: { numerator: 24, denominator: 1 },
      width: 320,
      height: 180,
      frames: 192,
    });
  });

  it('rebuilds tracks, trims, and the gap between two clips', async () => {
    const file = path.join(root, 'Project.db');
    writeProjectDatabase(file, media);

    const [timeline] = await readResolveTimelines(file);
    expect(timeline?.name).toBe('Hero Cut');
    const project = timeline?.project;
    const sequence = project?.sequences[0];
    expect(sequence).toMatchObject({ fps: { numerator: 24, denominator: 1 }, width: 320, height: 180 });
    // Resolve starts a timeline an hour in; that offset is kept, not flattened.
    expect(sequence?.globalStartFrame).toBe(216000);
    expect(project?.tracks.map(({ name, kind }) => `${name}:${kind}`)).toEqual(['V1 - Source:video', 'A1 - Source:audio']);

    const video = project?.tracks[0];
    const items = video?.itemIds.map((id) => {
      const clip = project?.clips.find((candidate) => candidate.id === id);
      return clip ? `${clip.name}@${clip.sourceRange.start}+${clip.sourceRange.duration}` : 'gap';
    });
    // 216000+48 leaves a 24 frame hole before the clip at 216072.
    expect(items).toEqual(['opening@12+48', 'gap', 'closing@0+24']);
    expect(project?.gaps[0]?.durationFrames).toBe(24);
    expect(timeline?.missingMedia).toEqual([]);
    expect(Object.values(timeline?.mediaLinks ?? {})).toEqual([pathToFileURL(media).href]);
  });

  it('numbers unnamed video and audio tracks independently', async () => {
    const file = path.join(root, 'Project.db');
    writeProjectDatabase(file, media);
    const { DatabaseSync } = createRequire(__filename)('node:sqlite') as {
      DatabaseSync: new (databasePath: string) => { exec(sql: string): void; close(): void };
    };
    const database = new DatabaseSync(file);
    database.exec('UPDATE Sm2TiTrack SET UserDefinedName = NULL');
    database.close();

    const [timeline] = await readResolveTimelines(file);
    expect(timeline?.project.tracks.map(({ name }) => name)).toEqual(['V1', 'A1']);
  });

  it('opens a database-backed project by rebuilding its known timeline', async () => {
    const projects = path.join(root, 'projects');
    const projectFolder = path.join(projects, 'Studio Job');
    await mkdir(projectFolder, { recursive: true });
    writeProjectDatabase(path.join(projectFolder, 'Project.db'), media);
    process.env.SNIPSNAP_RESOLVE_DATABASE = projects;
    process.env.SNIPSNAP_RESOLVE_ROOT = path.join(root, 'generated');

    const service = new ProjectService(path.join(root, 'data'), new ResolveLibrary(async () => []));
    const [overview] = await service.listProjectOverviews();
    expect(overview).toMatchObject({ name: 'Studio Job', kind: 'database', openable: true });
    expect(overview?.resolve).toMatchObject({ timelineName: 'Hero Cut', timelineCount: 1 });

    const status = await service.openResolveProjectById(overview?.id ?? '');
    expect(status.project.name).toBe('Studio Job');
    expect(status.project.sequences[0]?.name).toBe('Hero Cut');
    expect(status.project.clips).toHaveLength(3);
    expect(status.history).toHaveLength(1);

    const restarted = new ProjectService(path.join(root, 'data'), new ResolveLibrary(async () => []));
    expect(await restarted.listProjects()).toEqual([{ id: overview?.id, name: 'Studio Job' }]);
  });

  it('skips a timeline whose media cannot be measured rather than guessing its rate', async () => {
    const file = path.join(root, 'Project.db');
    writeProjectDatabase(file, path.join(root, 'not-here.mp4'));
    expect(await readResolveTimelines(file)).toEqual([]);
  });

  it('ignores a file that is not a Resolve database', async () => {
    const file = path.join(root, 'Project.db');
    await writeFile(file, 'not a database');
    expect(await readResolveTimelines(file)).toEqual([]);
  });
});

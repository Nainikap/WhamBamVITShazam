import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { probeVideo, readResolveTimelines } from '../src/application';
import { spawnSync } from 'node:child_process';

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

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
    CREATE TABLE Sm2Timeline (Name TEXT, Sequence TEXT);
    INSERT INTO Sm2Timeline VALUES ('Hero Cut', 'seq-1');
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

describe.runIf(hasFfmpeg)('rebuilding a timeline from a Resolve database', () => {
  let root: string;
  let media: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'snipsnap-db-'));
    media = path.join(root, 'source.mp4');
    spawnSync('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=24:duration=8',
      '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', media,
    ], { stdio: 'ignore' });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
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
    expect(Object.values(timeline?.mediaLinks ?? {})).toEqual([`file://${media}`]);
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

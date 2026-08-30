import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exportKdenliveOtio, KdenliveInterchangeReportSchema } from '../src/adapters/kdenlive';
import { ProjectService } from '../src/application';
import { createDemoProject } from '../src/domain/fixture';

function stripSnipSnapIds(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(stripSnipSnapIds);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  const metadata = record.metadata;
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    delete (metadata as Record<string, unknown>).videogit;
  }
  Object.values(record).forEach(stripSnipSnapIds);
}

function kdenliveExport(name: string): Record<string, unknown> {
  const value = JSON.parse(exportKdenliveOtio(createDemoProject(name)).contents) as Record<string, unknown>;
  stripSnipSnapIds(value);
  return value;
}

describe('Kdenlive project workflow', () => {
  let root: string;
  let sourcePath: string;
  let service: ProjectService;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'snipsnap-kdenlive-integration-'));
    sourcePath = path.join(root, 'editor-export.otio');
    await writeFile(sourcePath, `${JSON.stringify(kdenliveExport('Kdenlive Cut'), null, 2)}\n`);
    process.env.SNIPSNAP_RESOLVE_DATABASE = path.join(root, 'no-resolve-database');
    service = new ProjectService(path.join(root, 'data'));
  });

  afterEach(async () => {
    delete process.env.SNIPSNAP_RESOLVE_DATABASE;
    await rm(root, { recursive: true, force: true });
  });

  it('imports, lists, reopens, and watches a Kdenlive OTIO source', async () => {
    const imported = await service.importKdenliveSource(sourcePath);
    const projectId = imported.status.project.id;
    expect(imported.status.source).toMatchObject({
      connected: true,
      mode: 'kdenlive',
      filePath: sourcePath,
      state: 'watching',
    });
    expect(await service.listProjectOverviews()).toEqual([
      expect.objectContaining({
        id: projectId,
        editor: 'kdenlive',
        kind: 'kdenlive',
        sourcePath,
      }),
    ]);
    expect((await service.openProjectById(projectId)).headCommit).toBe(imported.status.headCommit);

    const rewritten = kdenliveExport('Kdenlive Cut');
    const tracks = (rewritten.tracks as { children: Array<{ children: Array<Record<string, unknown>> }> }).children;
    const clip = tracks[0]?.children[0];
    if (!clip) throw new Error('Kdenlive fixture clip is missing');
    const range = clip.source_range as { duration: { value: number } };
    range.duration.value = 120;
    await writeFile(sourcePath, `${JSON.stringify(rewritten, null, 2)}\n`);

    const scanned = await service.scanOtioSource(projectId);
    expect(scanned.changed).toBe(true);
    expect(scanned.status.source.pending?.changes.map(({ operation, entityType }) => `${operation}:${entityType}`))
      .toContain('modify:clip');
    expect(scanned.status.source.pending?.changes.some(({ operation }) => operation === 'add' || operation === 'delete'))
      .toBe(false);
  });

  it('imports Kdenlive audio references whose available range has rate zero', async () => {
    const exported = kdenliveExport('Kdenlive Zero-Rate Audio');
    const tracks = (exported.tracks as {
      children: Array<{ children: Array<Record<string, unknown>> }>;
    }).children;
    const clip = tracks
      .flatMap(({ children }) => children)
      .find(({ OTIO_SCHEMA }) => OTIO_SCHEMA === 'Clip.2');
    if (!clip) throw new Error('Kdenlive fixture clip is missing');
    const references = clip.media_references as {
      DEFAULT_MEDIA: { available_range: { start_time: { rate: number }; duration: { rate: number } } };
    };
    references.DEFAULT_MEDIA.available_range.start_time.rate = 0;
    references.DEFAULT_MEDIA.available_range.duration.rate = 0;
    await writeFile(sourcePath, `${JSON.stringify(exported, null, 2)}\n`);

    const imported = await service.importKdenliveSource(sourcePath);

    expect(imported.status.project.assets[0]?.durationFrames).toBeGreaterThan(0);
    expect(imported.report.losses).toEqual(expect.arrayContaining([
      expect.objectContaining({ feature: 'source-ranges', support: 'best-effort', count: 1 }),
    ]));
    expect(imported.report.losses.some(({ feature }) => feature === 'unsupported-otio')).toBe(false);
  });

  it('discovers valid OTIO files in a persisted Kdenlive folder and skips bad files', async () => {
    const watchedRoot = path.join(root, 'watched-kdenlive');
    const nestedRoot = path.join(watchedRoot, 'nested');
    const validPath = path.join(nestedRoot, 'Project One.otio');
    const invalidPath = path.join(watchedRoot, 'broken.otio');
    await mkdir(nestedRoot, { recursive: true });
    const unnamed = kdenliveExport('Kdenlive Cut');
    unnamed.name = '';
    await Promise.all([
      writeFile(validPath, `${JSON.stringify(unnamed, null, 2)}\n`),
      writeFile(invalidPath, '{ not valid OTIO'),
    ]);

    const first = await service.addKdenliveRoot(watchedRoot);

    expect(first).toMatchObject({ discovered: 2 });
    expect(first.roots).toContain(watchedRoot);
    expect(first.tracked).toEqual([
      expect.objectContaining({ sourcePath: validPath }),
    ]);
    expect(first.failures).toEqual([
      expect.objectContaining({ sourcePath: invalidPath }),
    ]);
    const overview = (await service.listProjectOverviews())
      .find(({ sourcePath: candidate }) => candidate === validPath);
    expect(overview).toMatchObject({ name: 'Project One', editor: 'kdenlive', sourceState: 'watching' });

    const restarted = new ProjectService(path.join(root, 'data'));
    const second = await restarted.refreshKdenliveRoots();
    expect(second.roots).toEqual([watchedRoot]);
    expect(second.tracked).toEqual([
      expect.objectContaining({ sourcePath: validPath }),
    ]);
  });

  it('writes immutable OTIO and a validated machine-readable fidelity report', async () => {
    const imported = await service.importKdenliveSource(sourcePath);
    const handoff = await service.prepareKdenliveHandoff(
      imported.status.project.id,
      imported.status.headCommit,
    );
    expect(handoff.commitId).toBe(imported.status.headCommit);
    expect(JSON.parse(await readFile(handoff.filePath, 'utf8'))).toMatchObject({
      OTIO_SCHEMA: 'Timeline.1',
      name: 'Kdenlive Cut',
    });
    expect(KdenliveInterchangeReportSchema.parse(
      JSON.parse(await readFile(handoff.reportPath, 'utf8')),
    )).toEqual(handoff.report);
  });
});

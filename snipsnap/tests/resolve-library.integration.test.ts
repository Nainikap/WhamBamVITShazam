import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectService, ResolveLibrary, resolveProjectId } from '../src/application';
import { exportOtio } from '../src/adapters/otio';
import { createDemoProject } from '../src/domain';

describe('Resolve library', () => {
  let root: string;
  let library: string;
  let service: ProjectService;

  async function exportResolveProject(name: string, timelineName = name): Promise<{ drp: string; otio: string }> {
    const folder = path.join(library, name);
    await mkdir(folder, { recursive: true });
    const drp = path.join(folder, `${name}.drp`);
    const otio = path.join(folder, `${timelineName}.otio`);
    // A .drp is an opaque Resolve archive; only its presence and size matter here.
    await writeFile(drp, 'DaVinci Resolve project archive');
    await writeFile(otio, exportOtio(createDemoProject(name)));
    return { drp, otio };
  }

  async function writeManifest(entries: Array<{ name: string; drp: string; otio: string; timeline: string }>) {
    await writeFile(path.join(library, 'manifest.json'), JSON.stringify({
      version: 1,
      generatedAt: new Date().toISOString(),
      projects: entries.map((entry) => ({
        name: entry.name,
        drp: entry.drp,
        folder: path.dirname(entry.drp),
        currentTimeline: entry.timeline,
        timelines: [{ name: entry.timeline, otio: entry.otio, isCurrent: true }],
        settings: { fps: 24, width: 1920, height: 1080 },
        exportedAt: new Date().toISOString(),
      })),
    }));
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'snipsnap-resolve-'));
    process.env.SNIPSNAP_RESOLVE_DATABASE = path.join(root, 'no-resolve-database');
    library = path.join(root, 'library');
    await mkdir(library, { recursive: true });
    service = new ProjectService(path.join(root, 'data'), new ResolveLibrary([library]));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('lists every Resolve project it finds, flagging the ones with no timeline export', async () => {
    const complete = await exportResolveProject('Launch Promo');
    const orphanFolder = path.join(library, 'No Timeline');
    await mkdir(orphanFolder, { recursive: true });
    await writeFile(path.join(orphanFolder, 'No Timeline.drp'), 'archive without a timeline');
    // An .otio with no project file beside it is not a Resolve project.
    const timelineOnly = path.join(library, 'No Project');
    await mkdir(timelineOnly, { recursive: true });
    await writeFile(path.join(timelineOnly, 'stray.otio'), exportOtio(createDemoProject('Stray')));

    const discovered = await service.discoverResolveProjects();
    expect(discovered.map(({ name }) => name).sort()).toEqual(['Launch Promo', 'No Timeline']);
    const ready = discovered.find(({ name }) => name === 'Launch Promo');
    expect(ready?.drpPath).toBe(complete.drp);
    expect(ready?.activeTimeline?.otioPath).toBe(complete.otio);
    expect(discovered.find(({ name }) => name === 'No Timeline')?.activeTimeline).toBeNull();

    const overviews = await service.listProjectOverviews();
    expect(overviews.map(({ name, openable }) => `${name}:${openable}`).sort())
      .toEqual(['Launch Promo:true', 'No Timeline:false']);
  });

  it('refuses to open a project that has no timeline export yet', async () => {
    const folder = path.join(library, 'Awaiting Export');
    await mkdir(folder, { recursive: true });
    const drp = path.join(folder, 'Awaiting Export.drp');
    await writeFile(drp, 'archive without a timeline');

    await expect(service.openResolveProjectById(resolveProjectId(drp)))
      .rejects.toThrow(/no timeline export yet/u);
  });

  it('watches the folder around a project file chosen by hand', async () => {
    const elsewhere = path.join(root, 'elsewhere');
    await mkdir(elsewhere, { recursive: true });
    const drp = path.join(elsewhere, 'Picked By Hand.drp');
    await writeFile(drp, 'DaVinci Resolve project archive');
    await writeFile(path.join(elsewhere, 'Picked By Hand.otio'), exportOtio(createDemoProject('Picked By Hand')));

    const service2 = new ProjectService(path.join(root, 'data2'), new ResolveLibrary(async () => []));
    expect(await service2.discoverResolveProjects()).toEqual([]);

    const withFolder = new ProjectService(path.join(root, 'data2'));
    await withFolder.addResolveProjectFile(drp);
    const roots = await withFolder.resolveRoots();
    expect(roots).toContain(elsewhere);
  });

  it('drops a project again once its Resolve files are gone', async () => {
    const exported = await exportResolveProject('Temporary Cut');
    await service.openResolveProjectById(resolveProjectId(exported.drp));
    expect(await service.listProjectOverviews()).toHaveLength(1);

    await rm(exported.drp);
    expect(await service.listProjectOverviews()).toEqual([]);
    await expect(service.openResolveProjectById(resolveProjectId(exported.drp)))
      .rejects.toThrow(/no longer on disk/u);
  });

  it('prefers manifest timeline names over the file name', async () => {
    const exported = await exportResolveProject('Brand Film', 'brand-film-v3');
    await writeManifest([{
      name: 'Brand Film',
      drp: exported.drp,
      otio: exported.otio,
      timeline: 'Brand Film — Director Cut',
    }]);

    const [discovered] = await service.discoverResolveProjects();
    expect(discovered?.name).toBe('Brand Film');
    expect(discovered?.activeTimeline?.name).toBe('Brand Film — Director Cut');
    expect(discovered?.discoveredVia).toBe('manifest');
  });

  it('imports the timeline on first open and re-uses the same repository after that', async () => {
    const exported = await exportResolveProject('Documentary');
    const projectId = resolveProjectId(exported.drp);

    const first = await service.openResolveProjectById(projectId);
    expect(first.history).toHaveLength(1);
    expect(first.project.name).toBe('Documentary');
    expect(first.source.filePath).toBe(exported.otio);
    expect(first.unstaged).toEqual([]);

    const again = await service.openResolveProjectById(projectId);
    expect(again.headCommit).toBe(first.headCommit);
    expect(again.history).toHaveLength(1);

    const overviews = await service.listProjectOverviews();
    expect(overviews[0]).toMatchObject({
      linked: true,
      name: 'Documentary',
      commitCount: 1,
      resolve: { drpPath: exported.drp, otioPath: exported.otio },
    });
  });

  it('reports a project Resolve re-exported as pending changes on open', async () => {
    const exported = await exportResolveProject('Recut');
    const projectId = resolveProjectId(exported.drp);
    await service.openResolveProjectById(projectId);

    const edited = createDemoProject('Recut');
    const clip = edited.clips[0];
    if (!clip) throw new Error('Fixture clip missing');
    clip.sourceRange = { start: 0, duration: 96 };
    clip.markers = [{ name: 'Tighter', color: 'RED', start: 1, duration: 0, comment: '', extras: {} }];
    await writeFile(exported.otio, exportOtio(edited));

    const reopened = await service.openResolveProjectById(projectId);
    expect(reopened.source.state).toBe('changes-ready');
    const messages = reopened.source.pending?.changes.map(({ message }) => message) ?? [];
    expect(messages).toEqual(expect.arrayContaining([
      expect.stringContaining('Trimmed end of clip Intro by 48 frames'),
      expect.stringContaining('added 1 markers'),
    ]));
  });

  it('lists an unopened project without pretending it has history', async () => {
    await exportResolveProject('Never Opened');
    const [overview] = await service.listProjectOverviews();

    expect(overview).toMatchObject({ linked: false, commitCount: 0, name: 'Never Opened' });
    expect(overview?.headCommit).toBe('');
  });

  it('carries the Resolve folder on a project that has no .drp of its own', async () => {
    // A database project is identified by its folder, not by a project file.
    const database = path.join(root, 'database');
    const folder = path.join(database, 'Studio Job');
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, 'Project.db'), 'SQLite format 3\u0000');
    await writeFile(path.join(folder, 'Hero Cut.otio'), exportOtio(createDemoProject('Hero Cut')));
    process.env.SNIPSNAP_RESOLVE_DATABASE = database;

    const [reference] = await service.discoverResolveProjects();
    expect(reference).toMatchObject({ kind: 'database', name: 'Studio Job', drpPath: '' });

    const status = await service.openResolveProjectById(reference?.id ?? '');
    expect(status.resolve).toMatchObject({
      drpPath: '',
      folder,
      timelineName: 'Hero Cut',
      projectName: 'Studio Job',
    });
    const [overview] = await service.listProjectOverviews();
    expect(overview).toMatchObject({ linked: true, openable: true, kind: 'database' });
  });
});

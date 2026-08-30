import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectService, ResolveLibrary, resolveProjectId } from '../../src/application';
import { runGit } from '../../src/git';
import { layoutGraph } from '../../src/renderer/commit-graph-layout';
import { packagedElectronArgs } from './electron-args';

const RATE = 30;
const FRAMES = 300;
const time = (value: number) => ({ OTIO_SCHEMA: 'RationalTime.1', value, rate: RATE });
const range = (start: number, duration: number) => ({
  OTIO_SCHEMA: 'TimeRange.1', start_time: time(start), duration: time(duration),
});
const clip = (media: string, start: number, duration: number) => ({
  OTIO_SCHEMA: 'Clip.2',
  name: 'Interview take 3.mp4',
  source_range: range(start, duration),
  media_reference: {
    OTIO_SCHEMA: 'ExternalReference.1',
    name: 'Interview take 3.mp4',
    target_url: `file://${media}`,
    available_range: range(0, FRAMES),
  },
  metadata: {},
});
const timeline = (media: string, start: number, duration: number) => JSON.stringify({
  OTIO_SCHEMA: 'Timeline.1',
  name: 'Launch Promo',
  global_start_time: time(0),
  tracks: {
    OTIO_SCHEMA: 'Stack.1',
    name: 'tracks',
    children: [{ OTIO_SCHEMA: 'Track.1', name: 'V1', kind: 'Video', children: [clip(media, start, duration)], metadata: {} }],
    metadata: {},
  },
  metadata: {},
});

function contributorTimeline(input: {
  media: string;
  music: string;
  duration?: number;
  look?: 'none' | 'warm' | 'cool' | 'mono';
  subtitles?: boolean;
  musicBed?: boolean;
}): string {
  const duration = input.duration ?? FRAMES;
  const video = clip(input.media, 0, duration);
  video.metadata = { videogit: { gainDb: 0, preset: input.look ?? 'none' } };
  const tracks: Array<Record<string, unknown>> = [{
    OTIO_SCHEMA: 'Track.1', name: 'V1', kind: 'Video', children: [video], metadata: {},
  }];
  if (input.subtitles) {
    tracks.push({
      OTIO_SCHEMA: 'Track.1',
      name: 'Subtitles',
      kind: 'Video',
      children: [
        { OTIO_SCHEMA: 'Gap.1', name: 'Gap', source_range: range(0, 60), metadata: {} },
        {
          OTIO_SCHEMA: 'Clip.2',
          name: 'Meet the makers',
          source_range: range(0, 90),
          media_reference: { OTIO_SCHEMA: 'MissingReference.1', name: 'Meet the makers', available_range: null },
          metadata: { Resolve_OTIO: { 'Effect Name': 'Text+' } },
        },
        { OTIO_SCHEMA: 'Gap.1', name: 'Gap', source_range: range(0, FRAMES - 150), metadata: {} },
      ],
      metadata: {},
    });
  }
  if (input.musicBed) {
    tracks.push({
      OTIO_SCHEMA: 'Track.1',
      name: 'Music',
      kind: 'Audio',
      children: [{
        OTIO_SCHEMA: 'Clip.2',
        name: 'Campaign music.wav',
        source_range: range(0, FRAMES),
        media_reference: {
          OTIO_SCHEMA: 'ExternalReference.1',
          name: 'Campaign music.wav',
          target_url: `file://${input.music}`,
          available_range: range(0, FRAMES),
        },
        metadata: { videogit: { gainDb: -12, preset: 'none' } },
      }],
      metadata: {},
    });
  }
  return JSON.stringify({
    OTIO_SCHEMA: 'Timeline.1',
    name: 'Launch Promo',
    global_start_time: time(0),
    tracks: { OTIO_SCHEMA: 'Stack.1', name: 'tracks', children: tracks, metadata: {} },
    metadata: {},
  });
}

function packagedAppPath(): string {
  const packageRoot = path.resolve('out', `SnipSnap-${process.platform}-${process.arch}`);
  return process.platform === 'darwin'
    ? path.join(packageRoot, 'SnipSnap.app', 'Contents', 'Resources', 'app.asar')
    : path.join(packageRoot, 'resources', 'app.asar');
}

interface MergeFixture {
  workspace: string;
  dataRoot: string;
  resolveRoot: string;
  otio: string;
  media: string;
  music: string;
  projectId: string;
  service: ProjectService;
}

async function prepareFixture(prefix: string): Promise<MergeFixture> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), prefix));
  const dataRoot = path.join(workspace, 'data');
  const resolveRoot = path.join(workspace, 'resolve');
  const folder = path.join(resolveRoot, 'Launch Promo');
  await mkdir(dataRoot, { recursive: true });
  await mkdir(folder, { recursive: true });
  const media = path.join(folder, 'interview.mp4');
  const music = path.join(folder, 'campaign-music.wav');
  await writeFile(media, 'synthetic offline media for timeline tests');
  await writeFile(music, 'synthetic offline music for timeline tests');
  const drp = path.join(folder, 'Launch Promo.drp');
  const otio = path.join(folder, 'Launch Promo.otio');
  await writeFile(drp, 'DaVinci Resolve project archive');
  await writeFile(otio, timeline(media, 0, FRAMES));
  const service = new ProjectService(dataRoot, new ResolveLibrary([resolveRoot]));
  const projectId = resolveProjectId(drp);
  await service.openResolveProjectById(projectId);
  return { workspace, dataRoot, resolveRoot, otio, media, music, projectId, service };
}

async function launchFixture(fixture: MergeFixture): Promise<{ application: ElectronApplication; page: Page }> {
  const application = await electron.launch({
    args: packagedElectronArgs(packagedAppPath()),
    env: {
      ...process.env,
      SNIPSNAP_DATA_ROOT: fixture.dataRoot,
      SNIPSNAP_RESOLVE_ROOT: fixture.resolveRoot,
      SNIPSNAP_RESOLVE_DATABASE: path.join(fixture.workspace, 'no-database'),
    },
  });
  const page = await application.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Open Launch Promo' }).click();
  await expect(page.getByLabel('Commit history')).toBeVisible({ timeout: 30_000 });
  return { application, page };
}

async function saveResolveChange(
  fixture: MergeFixture,
  start: number,
  duration: number,
  message: string,
) {
  await writeFile(fixture.otio, timeline(fixture.media, start, duration));
  const scanned = await fixture.service.scanOtioSource(fixture.projectId);
  const pending = scanned.status.source.pending;
  if (!pending) throw new Error(`No change detected for ${message}`);
  let status = await fixture.service.applyPendingSync(fixture.projectId, pending.digest, scanned.status.workspaceVersion);
  status = await fixture.service.stage(fixture.projectId, status.unstaged.map(({ id }) => id), status.indexDigest);
  return fixture.service.commit(fixture.projectId, message, status.headCommit, status.indexDigest);
}

async function saveResolveDocument(fixture: MergeFixture, document: string, message: string) {
  await writeFile(fixture.otio, document);
  const scanned = await fixture.service.scanOtioSource(fixture.projectId);
  const pending = scanned.status.source.pending;
  if (!pending) throw new Error(`No change detected for ${message}`);
  let status = await fixture.service.applyPendingSync(fixture.projectId, pending.digest, scanned.status.workspaceVersion);
  status = await fixture.service.stage(fixture.projectId, status.unstaged.map(({ id }) => id), status.indexDigest);
  return fixture.service.commit(fixture.projectId, message, status.headCommit, status.indexDigest);
}

test('two branches trimming the same clip stop for a decision', async () => {
  test.setTimeout(300_000);
  const fixture = await prepareFixture('snipsnap-merge-');
  let application: ElectronApplication | undefined;
  try {
    await fixture.service.createBranch(fixture.projectId, 'tighter-cut');
    await fixture.service.checkout(fixture.projectId, 'tighter-cut', false);
    await saveResolveChange(fixture, 30, 150, 'Tighten to the middle');
    await fixture.service.checkout(fixture.projectId, 'main', true);
    const target = await saveResolveChange(fixture, 0, 240, 'Trim the tail only');

    const launched = await launchFixture(fixture);
    application = launched.application;
    const page = launched.page;
    const history = page.getByLabel('Commit history');
    const graph = page.getByRole('list', { name: 'Commit graph' });
    await expect(history.getByRole('button', { name: 'View commit Tighten to the middle' })).toBeVisible();
    await expect(history.getByRole('button', { name: 'View commit Trim the tail only' })).toBeVisible();
    await expect(graph.getByText('tighter-cut', { exact: true })).toBeVisible();
    await expect(graph.getByText('main', { exact: true })).toBeVisible();

    await page.getByLabel('Merge source branch').click();
    await page.getByRole('option', { name: /tighter-cut/u }).click();
    await page.getByRole('button', { name: /Merge into main/u }).click();
    let dialog = page.getByRole('dialog', { name: /tighter-cut/u });
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await expect(dialog.getByText(/conflict left/u)).toBeVisible();
    await expect(dialog.getByText(/Timestamps disagree/u)).toBeVisible();
    await expect(dialog.getByText('Both branches retimed this video item, so its in and out points disagree.')).toBeVisible();

    await dialog.getByRole('button', { name: 'Abort merge' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText('Merge aborted. The branch was not moved.')).toBeVisible();
    expect((await fixture.service.status(fixture.projectId)).headCommit).toBe(target.headCommit);

    await page.getByRole('button', { name: /Merge into main/u }).click();
    dialog = page.getByRole('dialog', { name: /tighter-cut/u });
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await dialog.getByRole('button', { name: 'Accept incoming' }).first().click();
    await expect(dialog.getByText(/Every conflict is resolved/u)).toBeVisible({ timeout: 15_000 });
    await dialog.getByRole('button', { name: 'Complete merge' }).click();
    await expect(page.getByText('Two-parent merge commit created.')).toBeVisible({ timeout: 30_000 });
    const mergeRow = history.getByRole('button', { name: 'View commit Merge tighter-cut into main' });
    await expect(mergeRow).toBeVisible();
    await mergeRow.click();
    await expect(page.getByRole('button', { name: '1', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '2', exact: true })).toBeVisible();
    const completed = await fixture.service.status(fixture.projectId);
    expect(completed.history.find(({ id }) => id === completed.headCommit)?.parents).toHaveLength(2);
    expect(completed.project.clips[0]?.sourceRange).toEqual({ start: 30, duration: 150 });
  } finally {
    if (application) await application.close();
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

test('describes a conflicting visual treatment and applies the selected branch exactly', async () => {
  test.setTimeout(300_000);
  const fixture = await prepareFixture('snipsnap-look-conflict-');
  let application: ElectronApplication | undefined;
  try {
    await fixture.service.createBranch(fixture.projectId, 'alternate-look');
    await fixture.service.checkout(fixture.projectId, 'alternate-look', false);
    await saveResolveDocument(fixture, contributorTimeline({
      media: fixture.media,
      music: fixture.music,
      look: 'mono',
    }), 'Use monochrome treatment');
    await fixture.service.checkout(fixture.projectId, 'main', true);
    await saveResolveDocument(fixture, contributorTimeline({
      media: fixture.media,
      music: fixture.music,
      look: 'warm',
    }), 'Use warm treatment');

    const launched = await launchFixture(fixture);
    application = launched.application;
    const page = launched.page;
    await page.getByLabel('Merge source branch').click();
    await page.getByRole('option', { name: /alternate-look/u }).click();
    await page.getByRole('button', { name: /Merge into main/u }).click();
    const dialog = page.getByRole('dialog', { name: /alternate-look/u });
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    const card = dialog.locator('article').filter({ hasText: 'Different look' });
    await expect(card.getByText(/Different look/u)).toBeVisible();
    await expect(card.getByText('Both branches graded this clip differently.')).toBeVisible();
    await expect(card.getByText('none', { exact: true })).toBeVisible();
    await expect(card.getByText('warm', { exact: true })).toBeVisible();
    await expect(card.getByText('mono', { exact: true })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Accept both' })).toBeDisabled();
    await card.getByRole('button', { name: 'Accept incoming' }).click();
    await expect(dialog.getByText(/Every conflict is resolved/u)).toBeVisible();
    await dialog.getByRole('button', { name: 'Complete merge' }).click();
    await expect(page.getByText('Two-parent merge commit created.')).toBeVisible({ timeout: 30_000 });
    const completed = await fixture.service.status(fixture.projectId);
    expect(completed.project.clips[0]?.preset).toBe('mono');
    expect(completed.history.find(({ id }) => id === completed.headCommit)?.parents).toHaveLength(2);
  } finally {
    if (application) await application.close();
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

test('divergent branch commits stay visible and independent fields merge cleanly', async () => {
  test.setTimeout(300_000);
  const fixture = await prepareFixture('snipsnap-clean-merge-');
  let application: ElectronApplication | undefined;
  try {
    const initial = await fixture.service.status(fixture.projectId);
    const clipId = initial.project.clips[0]?.id;
    if (!clipId) throw new Error('Fixture clip missing');
    await fixture.service.createBranch(fixture.projectId, 'look-fix');
    await fixture.service.checkout(fixture.projectId, 'look-fix', false);
    let status = await fixture.service.status(fixture.projectId);
    status = await fixture.service.edit(
      fixture.projectId,
      { type: 'setClipPreset', clipId, preset: 'warm' },
      status.workspaceVersion,
    );
    status = await fixture.service.stage(fixture.projectId, status.unstaged.map(({ id }) => id), status.indexDigest);
    await fixture.service.commit(fixture.projectId, 'Warm the interview look', status.headCommit, status.indexDigest);

    await fixture.service.checkout(fixture.projectId, 'main', false);
    status = await fixture.service.status(fixture.projectId);
    status = await fixture.service.edit(
      fixture.projectId,
      { type: 'setClipGain', clipId, gainDb: -3 },
      status.workspaceVersion,
    );
    status = await fixture.service.stage(fixture.projectId, status.unstaged.map(({ id }) => id), status.indexDigest);
    await fixture.service.commit(fixture.projectId, 'Lower the interview gain', status.headCommit, status.indexDigest);

    const launched = await launchFixture(fixture);
    application = launched.application;
    const page = launched.page;
    const history = page.getByLabel('Commit history');
    const graph = page.getByRole('list', { name: 'Commit graph' });
    await expect(history.getByRole('button', { name: 'View commit Warm the interview look' })).toBeVisible();
    await expect(history.getByRole('button', { name: 'View commit Lower the interview gain' })).toBeVisible();
    await expect(graph.getByText('look-fix', { exact: true })).toBeVisible();
    await expect(graph.getByText('main', { exact: true })).toBeVisible();
    await expect(graph.locator('.vg-cube')).toHaveCount(0);

    await graph.getByRole('button', { name: 'View commit Warm the interview look' }).click();
    await expect(page.getByRole('heading', { name: 'Warm the interview look' })).toBeVisible();
    await graph.getByRole('button', { name: 'View commit Lower the interview gain' }).click();
    await expect(page.getByRole('heading', { name: 'Lower the interview gain' })).toBeVisible();

    await expect(page.getByText(/change detected in Resolve/u)).toBeVisible();
    await page.getByLabel('Switch branch').click();
    page.once('dialog', async (dialog) => {
      expect(dialog.message()).toContain('Switching to look-fix discards');
      await dialog.accept();
    });
    await page.getByRole('option', { name: /look-fix/u }).click();
    await expect(page.getByLabel('Switch branch')).toContainText('look-fix');
    await expect(page.getByRole('heading', { name: 'Warm the interview look' })).toBeVisible();
    await page.getByLabel('Switch branch').click();
    page.once('dialog', async (dialog) => {
      expect(dialog.message()).toContain('Switching to main discards');
      await dialog.accept();
    });
    await page.getByRole('option', { name: /^main/u }).click();
    await expect(page.getByLabel('Switch branch')).toContainText('main');
    await expect(page.getByRole('heading', { name: 'Lower the interview gain' })).toBeVisible();

    await page.getByLabel('Merge source branch').click();
    await page.getByRole('option', { name: /look-fix/u }).click();
    await page.getByRole('button', { name: /Merge into main/u }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByText('Merged look-fix into main with a two-parent commit.')).toBeVisible({ timeout: 30_000 });
    await expect(history.getByRole('button', { name: 'View commit Merge look-fix into main' })).toBeVisible();
    const completed = await fixture.service.status(fixture.projectId);
    const merge = completed.history.find(({ id }) => id === completed.headCommit);
    expect(merge?.parents).toHaveLength(2);
    expect(completed.project.clips[0]).toMatchObject({ preset: 'warm', gainDb: -3 });
  } finally {
    if (application) await application.close();
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

test('integrates look, subtitle, and music branches without losing any contributor', async () => {
  test.setTimeout(300_000);
  const fixture = await prepareFixture('snipsnap-three-contributors-');
  let application: ElectronApplication | undefined;
  try {
    for (const branch of ['colour-treatment', 'subtitles', 'music-bed']) {
      await fixture.service.createBranch(fixture.projectId, branch);
    }

    await fixture.service.checkout(fixture.projectId, 'colour-treatment', false);
    const colour = await saveResolveDocument(fixture, contributorTimeline({
      media: fixture.media,
      music: fixture.music,
      look: 'warm',
    }), 'Warm the campaign look');

    await fixture.service.checkout(fixture.projectId, 'subtitles', true);
    const subtitles = await saveResolveDocument(fixture, contributorTimeline({
      media: fixture.media,
      music: fixture.music,
      subtitles: true,
    }), 'Add campaign subtitles');

    await fixture.service.checkout(fixture.projectId, 'music-bed', true);
    const music = await saveResolveDocument(fixture, contributorTimeline({
      media: fixture.media,
      music: fixture.music,
      musicBed: true,
    }), 'Add campaign music');

    await fixture.service.checkout(fixture.projectId, 'main', true);
    const main = await saveResolveDocument(fixture, contributorTimeline({
      media: fixture.media,
      music: fixture.music,
      duration: 270,
    }), 'Lock the base cut');

    const launched = await launchFixture(fixture);
    application = launched.application;
    const page = launched.page;
    const history = page.getByLabel('Commit history');
    const graph = page.getByRole('list', { name: 'Commit graph' });
    for (const message of ['Warm the campaign look', 'Add campaign subtitles', 'Add campaign music', 'Lock the base cut']) {
      await expect(history.getByRole('button', { name: `View commit ${message}` })).toHaveCount(1);
    }
    for (const branch of ['colour-treatment', 'subtitles', 'music-bed', 'main']) {
      await expect(graph.getByText(branch, { exact: true })).toHaveCount(1);
    }

    await history.getByRole('button', { name: 'View commit Add campaign subtitles' }).click();
    await expect(page.getByRole('heading', { name: 'Add campaign subtitles' })).toBeVisible();
    let preview = page.getByRole('region', { name: 'Timeline tracks' });
    await expect(preview.getByText('Subtitles', { exact: true })).toBeVisible();
    await expect(preview.getByText('Meet the makers', { exact: true })).toBeVisible();
    await expect(preview.getByText('Music', { exact: true })).toHaveCount(0);

    await history.getByRole('button', { name: 'View commit Add campaign music' }).click();
    await expect(page.getByRole('heading', { name: 'Add campaign music' })).toBeVisible();
    preview = page.getByRole('region', { name: 'Timeline tracks' });
    await expect(preview.getByText('Music', { exact: true })).toBeVisible();
    await expect(preview.getByText('Campaign music.wav', { exact: true })).toBeVisible();
    await expect(preview.getByText('Subtitles', { exact: true })).toHaveCount(0);

    await history.getByRole('button', { name: 'View commit Lock the base cut' }).click();
    await expect(page.getByRole('heading', { name: 'Lock the base cut' })).toBeVisible();

    const mergeBranch = async (branch: string) => {
      await page.getByLabel('Merge source branch').click();
      await page.getByRole('option', { name: new RegExp(branch, 'u') }).click();
      await page.getByRole('button', { name: /Merge into main/u }).click();
    };

    await mergeBranch('colour-treatment');
    await expect(page.getByText('Merged colour-treatment into main with a two-parent commit.')).toBeVisible({ timeout: 30_000 });
    await mergeBranch('subtitles');
    await expect(page.getByText('Merged subtitles into main with a two-parent commit.')).toBeVisible({ timeout: 30_000 });
    await mergeBranch('music-bed');
    const dialog = page.getByRole('dialog', { name: /music-bed/u });
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await expect(dialog.getByText('1 conflict left. main is untouched until you complete the merge.')).toBeVisible();
    await expect(dialog.getByText(/Different running order/u)).toBeVisible();
    await expect(dialog.getByText(/Both branches rearranged this timeline lane/u)).toBeVisible();
    await expect(dialog.getByText(/Combined timeline is invalid/u)).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Accept both' }).first().click();
    await expect(dialog.getByText(/Every conflict is resolved/u)).toBeVisible();
    await dialog.getByRole('button', { name: 'Complete merge' }).click();
    await expect(page.getByText('Two-parent merge commit created.')).toBeVisible({ timeout: 30_000 });

    const completed = await fixture.service.status(fixture.projectId);
    expect(completed.project.clips.find(({ name }) => name === 'Interview take 3.mp4')).toMatchObject({
      preset: 'warm',
      sourceRange: { start: 0, duration: 270 },
    });
    expect(completed.project.clips.some(({ name }) => name === 'Meet the makers')).toBe(true);
    expect(completed.project.clips.some(({ name }) => name === 'Campaign music.wav')).toBe(true);
    expect(completed.project.tracks.map(({ name }) => name)).toEqual(['V1', 'Subtitles', 'Music']);
    const finalCommit = completed.history.find(({ id }) => id === completed.headCommit);
    expect(finalCommit?.parents).toHaveLength(2);
    await expect(graph.getByRole('listitem')).toHaveCount(8);
    // Every parent link renders as one segment per row it crosses, so the lane
    // artwork stays continuous through the per-row gutter cells.
    const { edges: graphEdges } = layoutGraph(completed.history);
    const expectedSegments = graphEdges.reduce((sum, edge) => sum + (edge.to.row - edge.from.row + 1), 0);
    await expect(graph.locator('svg path')).toHaveCount(expectedSegments);
    await expect(graph.getByText('merge', { exact: true })).toHaveCount(3);
    for (const contributor of [colour.headCommit, subtitles.headCommit, music.headCommit, main.headCommit]) {
      expect(completed.history.some(({ id }) => id === contributor)).toBe(true);
      await expect(runGit(
        path.join(fixture.dataRoot, 'projects', fixture.projectId, 'repo'),
        ['merge-base', '--is-ancestor', contributor, completed.headCommit],
      )).resolves.toBeDefined();
    }

    const finalRow = history.getByRole('button', { name: 'View commit Merge music-bed into main' });
    await finalRow.click();
    await expect(page.getByRole('button', { name: '1', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '2', exact: true })).toBeVisible();
    const tracks = page.getByRole('region', { name: 'Timeline tracks' });
    await expect(tracks.getByText('Subtitles', { exact: true })).toBeVisible();
    await expect(tracks.getByText('Music', { exact: true })).toBeVisible();
    await expect(tracks.getByText('Meet the makers', { exact: true })).toBeVisible();
    await expect(tracks.getByText('Campaign music.wav', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'See diff' }).click();
    const comparison = page.getByRole('region', { name: 'Commit comparison' });
    await expect(comparison.getByText('Campaign music.wav').first()).toBeVisible();
    await expect(comparison.getByText(/added/u).first()).toBeVisible();
  } finally {
    if (application) await application.close();
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

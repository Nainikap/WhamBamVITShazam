import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectService, ResolveLibrary, resolveProjectId } from '../../src/application';

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
  await writeFile(media, 'synthetic offline media for timeline tests');
  const drp = path.join(folder, 'Launch Promo.drp');
  const otio = path.join(folder, 'Launch Promo.otio');
  await writeFile(drp, 'DaVinci Resolve project archive');
  await writeFile(otio, timeline(media, 0, FRAMES));
  const service = new ProjectService(dataRoot, new ResolveLibrary([resolveRoot]));
  const projectId = resolveProjectId(drp);
  await service.openResolveProjectById(projectId);
  return { workspace, dataRoot, resolveRoot, otio, media, projectId, service };
}

async function launchFixture(fixture: MergeFixture): Promise<{ application: ElectronApplication; page: Page }> {
  const application = await electron.launch({
    args: [packagedAppPath()],
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

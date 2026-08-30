import { _electron as electron, expect, test } from '@playwright/test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectService, ResolveLibrary, resolveProjectId } from '../../src/application';
import { packagedElectronArgs } from './electron-args';

const RATE = 30;
const FRAMES = 300;
const TITLE_START = 90;
const TITLE_FRAMES = 90;

const time = (value: number) => ({ OTIO_SCHEMA: 'RationalTime.1', value, rate: RATE });
const range = (start: number, duration: number) => ({
  OTIO_SCHEMA: 'TimeRange.1', start_time: time(start), duration: time(duration),
});

function source(media: string) {
  return {
    OTIO_SCHEMA: 'Clip.2',
    name: 'Interview take 3.mp4',
    source_range: range(0, FRAMES),
    media_reference: {
      OTIO_SCHEMA: 'ExternalReference.1',
      name: 'Interview take 3.mp4',
      target_url: `file://${media}`,
      available_range: range(0, FRAMES),
    },
    metadata: {},
  };
}

const title = {
  OTIO_SCHEMA: 'Clip.2',
  name: 'RAVI KISHAN GOAT',
  source_range: range(0, TITLE_FRAMES),
  media_reference: { OTIO_SCHEMA: 'MissingReference.1', name: 'RAVI KISHAN GOAT', available_range: null },
  metadata: { Resolve_OTIO: { 'Effect Name': 'Text+' } },
};

const gap = (duration: number) => ({ OTIO_SCHEMA: 'Gap.1', name: 'Gap', source_range: range(0, duration), metadata: {} });
const track = (name: string, children: unknown[]) => ({ OTIO_SCHEMA: 'Track.1', name, kind: 'Video', children, metadata: {} });
const timeline = (children: unknown[]) => JSON.stringify({
  OTIO_SCHEMA: 'Timeline.1',
  name: 'Launch Promo',
  global_start_time: time(0),
  tracks: { OTIO_SCHEMA: 'Stack.1', name: 'tracks', children, metadata: {} },
  metadata: {},
});

function packagedAppPath(): string {
  const packageRoot = path.resolve('out', `SnipSnap-${process.platform}-${process.arch}`);
  return process.platform === 'darwin'
    ? path.join(packageRoot, 'SnipSnap.app', 'Contents', 'Resources', 'app.asar')
    : path.join(packageRoot, 'resources', 'app.asar');
}

test('a title over part of the timeline shows up as a commit', async () => {
  test.setTimeout(300_000);
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'snipsnap-title-'));
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
  await writeFile(otio, timeline([track('V1', [source(media)])]));

  const service = new ProjectService(dataRoot, new ResolveLibrary([resolveRoot]));
  const projectId = resolveProjectId(drp);
  await service.openResolveProjectById(projectId);

  // The editor adds a Text+ over the middle of the clip and saves again.
  await writeFile(otio, timeline([
    track('V1', [source(media)]),
    track('V2', [gap(TITLE_START), title, gap(FRAMES - TITLE_START - TITLE_FRAMES)]),
  ]));
  const scanned = await service.scanOtioSource(projectId);
  const pending = scanned.status.source.pending;
  if (!pending) throw new Error('The title was not detected as a Resolve change');
  console.log('DETECTED:', pending.changes.map(({ message }) => message).join(' | '));

  let status = await service.applyPendingSync(projectId, pending.digest, scanned.status.workspaceVersion);
  status = await service.stage(projectId, status.unstaged.map(({ id }) => id), status.indexDigest);
  await service.commit(projectId, 'Add the GOAT title over the middle', status.headCommit, status.indexDigest);

  const application = await electron.launch({
    args: packagedElectronArgs(packagedAppPath()),
    env: {
      ...process.env,
      SNIPSNAP_DATA_ROOT: dataRoot,
      SNIPSNAP_RESOLVE_ROOT: resolveRoot,
      SNIPSNAP_RESOLVE_DATABASE: path.join(workspace, 'no-database'),
    },
  });
  const page = await application.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Open Launch Promo' }).click();
  await expect(page.getByLabel('Commit history')).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(2000);

  await page.getByRole('button', { name: 'View commit Add the GOAT title over the middle' }).click();
  const commitChanges = page.getByRole('region', { name: 'Changes in commit Add the GOAT title over the middle' });
  await expect(commitChanges).toBeVisible();
  await expect(commitChanges.getByRole('button', { name: 'View diff Added track V2 with 3 timeline items' })).toBeVisible();
  await commitChanges.getByRole('button', { name: 'View all changes in commit Add the GOAT title over the middle' }).click();
  const comparison = page.getByRole('region', { name: 'Commit comparison' });
  await expect(comparison).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(2500);
  await expect(comparison.getByText('RAVI KISHAN GOAT').first()).toBeVisible();
  await expect(comparison.getByText(/\+\d+f added/u)).toBeVisible();

  // The title occupies only its slice of the new lane, not the whole width.
  const titleChip = comparison.locator('span[title*="RAVI KISHAN GOAT"]').first();
  const lane = titleChip.locator('xpath=..');
  const chipBox = await titleChip.boundingBox();
  const laneBox = await lane.boundingBox();
  if (!chipBox || !laneBox) throw new Error('The title chip is not on a lane');
  const share = chipBox.width / laneBox.width;
  console.log('TITLE SHARE OF LANE:', share.toFixed(3), 'expected', (TITLE_FRAMES / FRAMES).toFixed(3));
  expect(share).toBeGreaterThan(0.2);
  expect(share).toBeLessThan(0.45);
  console.log('COMMIT SIDEBAR:', (await commitChanges.allInnerTexts()).join(' ~ ').replace(/\n/gu, ' ').slice(0, 260));
  await application.close();
  await rm(workspace, { recursive: true, force: true });
});

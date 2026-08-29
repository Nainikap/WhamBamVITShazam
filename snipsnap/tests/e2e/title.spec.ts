import { _electron as electron, expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectService, ResolveLibrary, resolveProjectId } from '../../src/application';

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

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

test('a title over part of the timeline shows up as a commit', async () => {
  test.skip(!hasFfmpeg, 'needs ffmpeg to render the clip the title sits over');
  test.setTimeout(300_000);
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'snipsnap-title-'));
  const dataRoot = path.join(workspace, 'data');
  const resolveRoot = path.join(workspace, 'resolve');
  const folder = path.join(resolveRoot, 'Launch Promo');
  await mkdir(dataRoot, { recursive: true });
  await mkdir(folder, { recursive: true });

  const media = path.join(folder, 'interview.mp4');
  spawnSync('ffmpeg', [
    '-y', '-f', 'lavfi', '-i', `testsrc=size=480x270:rate=${RATE}:duration=10`,
    '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', media,
  ], { stdio: 'ignore' });

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
  await service.commit(projectId, 'Add the GOAT title over the middle', status.headCommit);

  const application = await electron.launch({
    args: [path.resolve('out', 'SnipSnap-darwin-arm64', 'SnipSnap.app', 'Contents', 'Resources', 'app.asar')],
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
  await page.getByRole('button', { name: 'Open Launch Promo' }).click();
  await expect(page.getByLabel('Commit history')).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(2000);

  await page.getByRole('button', { name: 'See diff' }).click();
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
  console.log('WHAT CHANGED:', (await comparison.getByRole('listitem').allInnerTexts()).join(' ~ ').replace(/\n/gu, ' ').slice(0, 260));
  await application.close();
});

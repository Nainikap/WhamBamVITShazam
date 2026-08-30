import { _electron as electron, expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
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

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

test('two branches trimming the same clip stop for a decision', async () => {
  test.skip(!hasFfmpeg, 'needs ffmpeg to render the clip both branches trim');
  test.setTimeout(300_000);
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'snipsnap-merge-'));
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
  await writeFile(otio, timeline(media, 0, FRAMES));

  const service = new ProjectService(dataRoot, new ResolveLibrary([resolveRoot]));
  const projectId = resolveProjectId(drp);
  await service.openResolveProjectById(projectId);

  const saveAndCommit = async (start: number, duration: number, message: string) => {
    await writeFile(otio, timeline(media, start, duration));
    const scanned = await service.scanOtioSource(projectId);
    const pending = scanned.status.source.pending;
    if (!pending) throw new Error(`No change detected for ${message}`);
    let status = await service.applyPendingSync(projectId, pending.digest, scanned.status.workspaceVersion);
    status = await service.stage(projectId, status.unstaged.map(({ id }) => id), status.indexDigest);
    return service.commit(projectId, message, status.headCommit);
  };

  await service.createBranch(projectId, 'tighter-cut');
  await service.checkout(projectId, 'tighter-cut', false);
  await saveAndCommit(30, 150, 'Tighten to the middle');
  await service.checkout(projectId, 'main', true);
  await saveAndCommit(0, 240, 'Trim the tail only');

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

  await page.getByLabel('Merge source branch').click();
  await page.getByRole('option', { name: /tighter-cut/u }).click();
  await page.getByRole('button', { name: /Merge into main/u }).click();

  const dialog = page.getByRole('dialog', { name: /tighter-cut/u });
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1500);
  console.log('CONFLICT:', (await dialog.innerText()).replace(/\n/gu, ' | ').slice(0, 320));
  await page.screenshot({ path: path.resolve(__dirname, '../../../.screens/merge-dialog.png') });

  await dialog.getByRole('button', { name: 'Accept both' }).first().click();
  await expect(dialog.getByText(/Every conflict is resolved/u)).toBeVisible({ timeout: 15_000 });
  await dialog.getByRole('button', { name: 'Complete merge' }).click();
  await expect(page.getByText(/Two-parent merge commit created/u)).toBeVisible({ timeout: 30_000 });
  await application.close();
});

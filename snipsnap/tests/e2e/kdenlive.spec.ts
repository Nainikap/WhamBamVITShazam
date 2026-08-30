import { _electron as electron, expect, test } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { KdenliveInterchangeReportSchema } from '../../src/adapters/kdenlive';
import { ProjectService } from '../../src/application';
import { KDENLIVE_NATIVE_FIXTURE } from '../fixtures/kdenlive-native';
import { packagedElectronArgs } from './electron-args';

function packagedAppPath(): string {
  const packageRoot = path.resolve('out', `SnipSnap-${process.platform}-${process.arch}`);
  return process.platform === 'darwin'
    ? path.join(packageRoot, 'SnipSnap.app', 'Contents', 'Resources', 'app.asar')
    : path.join(packageRoot, 'resources', 'app.asar');
}

test('tracks native Kdenlive saves and prepares an immutable handoff', async () => {
  test.setTimeout(180_000);
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'snipsnap-kdenlive-e2e-'));
  const dataRoot = path.join(workspace, 'data');
  const resolveRoot = path.join(workspace, 'empty-resolve');
  const sourcePath = path.join(workspace, 'Kdenlive Cut.kdenlive');
  const generatedOtioPath = path.join(workspace, 'Kdenlive Cut.otio');
  await mkdir(dataRoot, { recursive: true });
  await mkdir(resolveRoot, { recursive: true });

  await writeFile(sourcePath, KDENLIVE_NATIVE_FIXTURE);
  const service = new ProjectService(dataRoot);
  const imported = await service.importKdenliveSource(sourcePath);
  const projectId = imported.status.project.id;

  const application = await electron.launch({
    args: packagedElectronArgs(packagedAppPath()),
    env: {
      ...process.env,
      SNIPSNAP_DATA_ROOT: dataRoot,
      SNIPSNAP_RESOLVE_ROOT: resolveRoot,
      SNIPSNAP_RESOLVE_DATABASE: path.join(resolveRoot, 'no-database'),
      SNIPSNAP_KDENLIVE_BINARY: process.platform === 'win32' ? 'where.exe' : '/usr/bin/true',
    },
  });

  try {
    const page = await application.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('button', { name: 'Open Kdenlive Cut' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open Kdenlive Cut' })
      .getByText('Kdenlive project')).toBeVisible();
    await page.getByRole('button', { name: 'Open Kdenlive Cut' }).click();
    await expect(page.getByText(/Kdenlive · Kdenlive Cut\.kdenlive/u)).toBeVisible();

    await page.getByRole('button', { name: 'Prepare for Kdenlive' }).click();
    const notice = page.getByRole('status');
    await expect(notice).toContainText(/File > OpenTimelineIO Import/u);
    await expect(notice).toHaveCSS('position', 'fixed');
    const noticeBox = await notice.boundingBox();
    const viewport = page.viewportSize();
    expect(noticeBox?.height).toBeLessThan(150);
    expect((noticeBox?.y ?? 0) + (noticeBox?.height ?? 0)).toBeGreaterThan((viewport?.height ?? 0) - 64);
    const handoffRoot = path.join(dataRoot, 'projects', projectId, 'kdenlive-handoffs');
    const reportPath = path.join(handoffRoot, `${imported.status.headCommit}.report.json`);
    expect(KdenliveInterchangeReportSchema.parse(JSON.parse(await readFile(reportPath, 'utf8'))).editor)
      .toBe('kdenlive');

    await writeFile(sourcePath, KDENLIVE_NATIVE_FIXTURE.replace(
      '  <playlist id="video-playlist">\n    <blank length="00:00:01.000"/>',
      '  <playlist id="video-playlist">',
    ));
    await expect(page.getByRole('button', { name: 'Stage', exact: true }).first()).toBeVisible({ timeout: 15_000 });
    const changes = page.getByLabel('Working changes');
    await expect(changes.getByText('Moved clip shot.mp4 25 frames earlier')).toBeVisible();
    await expect(changes.getByRole('button', { name: 'Stage', exact: true })).toHaveCount(1);
    await expect(page.getByText(/Last Ctrl\+S received/u)).toBeVisible();
    const generated = JSON.parse(await readFile(generatedOtioPath, 'utf8')) as {
      tracks: { children: Array<{ children: Array<{ OTIO_SCHEMA: string; source_range?: { duration: { value: number } } }> }> };
    };
    const videoClip = generated.tracks.children[0]?.children.find(({ OTIO_SCHEMA }) => OTIO_SCHEMA === 'Clip.2');
    expect(videoClip?.source_range?.duration.value).toBe(50);
  } finally {
    await application.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

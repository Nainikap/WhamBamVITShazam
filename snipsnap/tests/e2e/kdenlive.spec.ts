import { _electron as electron, expect, test } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { exportKdenliveOtio, KdenliveInterchangeReportSchema } from '../../src/adapters/kdenlive';
import { ProjectService } from '../../src/application';
import { createDemoProject } from '../../src/domain/fixture';
import { packagedElectronArgs } from './electron-args';

function packagedAppPath(): string {
  const packageRoot = path.resolve('out', `SnipSnap-${process.platform}-${process.arch}`);
  return process.platform === 'darwin'
    ? path.join(packageRoot, 'SnipSnap.app', 'Contents', 'Resources', 'app.asar')
    : path.join(packageRoot, 'resources', 'app.asar');
}

test('imports Kdenlive OTIO, watches edits, and prepares an immutable handoff', async () => {
  test.setTimeout(180_000);
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'snipsnap-kdenlive-e2e-'));
  const dataRoot = path.join(workspace, 'data');
  const resolveRoot = path.join(workspace, 'empty-resolve');
  const sourcePath = path.join(workspace, 'kdenlive-export.otio');
  await mkdir(dataRoot, { recursive: true });
  await mkdir(resolveRoot, { recursive: true });

  const project = createDemoProject('Kdenlive Cut');
  await writeFile(sourcePath, exportKdenliveOtio(project).contents);
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
    await expect(page.getByText('Kdenlive OTIO')).toBeVisible();
    await page.getByRole('button', { name: 'Open Kdenlive Cut' }).click();
    await expect(page.getByText(/Kdenlive · kdenlive-export\.otio/u)).toBeVisible();

    await page.getByRole('button', { name: 'Prepare for Kdenlive' }).click();
    await expect(page.getByRole('status')).toContainText(/File > OpenTimelineIO Import/u);
    const handoffRoot = path.join(dataRoot, 'projects', projectId, 'kdenlive-handoffs');
    const reportPath = path.join(handoffRoot, `${imported.status.headCommit}.report.json`);
    expect(KdenliveInterchangeReportSchema.parse(JSON.parse(await readFile(reportPath, 'utf8'))).editor)
      .toBe('kdenlive');

    const edited = structuredClone(project);
    const clip = edited.clips[0];
    if (!clip) throw new Error('Kdenlive fixture clip is missing');
    clip.sourceRange.duration -= 12;
    await writeFile(sourcePath, exportKdenliveOtio(edited).contents);
    await expect(page.getByText(/change detected in Kdenlive/u)).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Apply to working timeline' }).click();
    await expect(page.getByRole('button', { name: 'Stage', exact: true }).first()).toBeVisible();
  } finally {
    await application.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

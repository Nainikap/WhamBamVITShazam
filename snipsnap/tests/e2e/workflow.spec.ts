import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectService } from '../../src/application';

let application: ElectronApplication | undefined;
let page: Page;
let dataRoot: string;
let sourcePath: string;
let sourceDocument: {
  tracks: { children: Array<{ children: Array<{ name?: string; source_range?: { duration: { value: number } } }> }> };
};

test.beforeEach(async () => {
  dataRoot = await mkdtemp(path.join(os.tmpdir(), 'snipsnap-e2e-'));
  sourcePath = path.join(dataRoot, 'resolve-export.otio');
  const fixture = await readFile(path.join(__dirname, '..', 'fixtures', 'resolve-basic.otio'), 'utf8');
  sourceDocument = JSON.parse(fixture) as typeof sourceDocument;
  await writeFile(sourcePath, fixture);
  await new ProjectService(dataRoot).importOtio(fixture, sourcePath);
  application = await electron.launch({
    args: [path.resolve('out', 'SnipSnap-win32-x64', 'resources', 'app.asar')],
    env: { ...process.env, SNIPSNAP_DATA_ROOT: dataRoot },
  });
  page = await application.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByRole('heading', { name: 'Resolve Basic Cut' })).toBeVisible();
});

test.afterEach(async () => {
  if (application) await application.close();
  application = undefined;
  await rm(dataRoot, { recursive: true, force: true });
});

async function exportResolveTrim(frames: number): Promise<void> {
  const opening = sourceDocument.tracks.children[0]?.children.find(({ name }) => name === 'Opening');
  if (!opening?.source_range) throw new Error('Fixture opening range missing');
  opening.source_range.duration.value = frames;
  await writeFile(sourcePath, JSON.stringify(sourceDocument));
}

async function applyStageAndCommit(message: string): Promise<void> {
  await expect(page.getByText(/Resolve change detected/u)).toBeVisible();
  await page.getByRole('button', { name: 'Apply to WORKING' }).click();
  await page.getByRole('button', { name: 'Stage' }).first().click();
  await page.getByLabel('Commit message').fill(message);
  await page.getByRole('button', { name: 'Commit', exact: true }).click();
  await expect(page.getByRole('button', { name: `View commit ${message}` })).toBeVisible();
}

test('detects a Resolve export, stages its semantic diff, and previews the real commit', async () => {
  await expect(page.getByText('watching', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Commit video preview' })).toBeVisible();
  await expect(page.getByText('Opening · media offline')).toBeVisible();

  await exportResolveTrim(90);
  await applyStageAndCommit('Tighten the opening');

  await page.getByRole('button', { name: 'View commit Tighten the opening' }).click();
  await expect(page.getByText('Compared with', { exact: false })).toBeVisible();
  await expect(page.getByText('Trimmed clip Opening')).toBeVisible();
  await expect(page.getByText(/COMMIT [a-f0-9]{8}/u)).toBeVisible();
});

test('creates a branch from an old commit, switches branches, and restores history safely', async () => {
  await exportResolveTrim(88);
  await applyStageAndCommit('Shorten opening for main');

  await page.getByRole('button', { name: 'View commit Import Resolve OTIO' }).click();
  await expect(page.getByText('Initial timeline snapshot')).toBeVisible();
  await page.getByLabel('Branch from selected commit').fill('alternate-cut');
  await page.getByRole('button', { name: 'Create branch here' }).click();
  await expect(page.getByText(/Created and switched to alternate-cut/u)).toBeVisible();
  await expect(page.getByText('alternate-cut', { exact: true }).first()).toBeVisible();

  await page.getByRole('button', { name: 'Switch to branch main' }).click();
  await expect(page.getByText('Switched to main.')).toBeVisible();
  await page.getByRole('button', { name: 'View commit Import Resolve OTIO' }).click();
  await page.getByRole('button', { name: 'Restore to WORKING' }).click();
  await expect(page.getByText(/Restored [a-f0-9]{8} into WORKING/u)).toBeVisible();
  await expect(page.getByText('Trimmed clip Opening')).toBeVisible();
});

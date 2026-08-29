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

function packagedAppPath(): string {
  const packageRoot = path.resolve('out', `SnipSnap-${process.platform}-${process.arch}`);
  return process.platform === 'darwin'
    ? path.join(packageRoot, 'SnipSnap.app', 'Contents', 'Resources', 'app.asar')
    : path.join(packageRoot, 'resources', 'app.asar');
}

test.beforeEach(async () => {
  dataRoot = await mkdtemp(path.join(os.tmpdir(), 'snipsnap-e2e-'));
  sourcePath = path.join(dataRoot, 'resolve-export.otio');
  const fixture = await readFile(path.join(__dirname, '..', 'fixtures', 'resolve-basic.otio'), 'utf8');
  sourceDocument = JSON.parse(fixture) as typeof sourceDocument;
  await writeFile(sourcePath, fixture);
  await new ProjectService(dataRoot).importOtio(fixture, sourcePath);
  application = await electron.launch({
    args: [packagedAppPath()],
    env: { ...process.env, SNIPSNAP_DATA_ROOT: dataRoot },
  });
  page = await application.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByRole('heading', { name: 'Video projects' })).toBeVisible();
});

test.afterEach(async () => {
  if (application) await application.close();
  application = undefined;
  await rm(dataRoot, { recursive: true, force: true });
});

async function openProject(): Promise<void> {
  await page.getByRole('button', { name: 'Open Resolve Basic Cut' }).click();
  await expect(page.getByLabel('Commit history')).toBeVisible();
}

async function exportResolveTrim(frames: number): Promise<void> {
  const opening = sourceDocument.tracks.children[0]?.children.find(({ name }) => name === 'Opening');
  if (!opening?.source_range) throw new Error('Fixture opening range missing');
  opening.source_range.duration.value = frames;
  await writeFile(sourcePath, JSON.stringify(sourceDocument));
}

async function applyStageAndCommit(message: string): Promise<void> {
  await expect(page.getByText(/change(s)? detected in Resolve/u)).toBeVisible();
  await page.getByRole('button', { name: 'Apply to working timeline' }).click();
  await page.getByRole('button', { name: 'Stage', exact: true }).first().click();
  await page.getByLabel('Commit message').fill(message);
  await page.getByRole('button', { name: 'Commit', exact: true }).click();
  await expect(page.getByRole('button', { name: `View commit ${message}` })).toBeVisible();
}

test('opens the latest project from the dashboard and previews the real commit', async () => {
  await expect(page.getByText('Continue where you left off', { exact: false })).toBeVisible();
  await openProject();

  await expect(page.locator('.path-text')).toContainText(dataRoot);
  await expect(page.getByText('watching', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Commit video preview' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Timeline tracks' })).toBeVisible();
  await expect(page.getByText('Opening · media offline').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Commit', exact: true })).toBeDisabled();

  await exportResolveTrim(90);
  await applyStageAndCommit('Tighten the opening');
  await expect(page.getByRole('button', { name: 'Commit', exact: true })).toBeDisabled();
});

test('splits the window into two commits and highlights the changed timestamp', async () => {
  await openProject();
  await exportResolveTrim(90);
  await applyStageAndCommit('Tighten the opening');

  await page.getByRole('button', { name: 'See diff' }).click();
  const comparison = page.getByRole('region', { name: 'Commit comparison' });
  await expect(comparison).toBeVisible();
  await expect(page.getByRole('region', { name: 'Base commit video preview' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Compared commit video preview' })).toBeVisible();
  await expect(comparison.locator('.diff-chip.diff-retimed')).toHaveCount(2);
  await expect(comparison.getByText('2 retimed')).toBeVisible();
  await expect(comparison.getByText('in/out point')).toBeVisible();

  await page.getByRole('button', { name: 'Close comparison' }).click();
  await expect(page.getByRole('region', { name: 'Timeline tracks' })).toBeVisible();
});

test('creates a branch from an old commit, switches branches, and restores history safely', async () => {
  await openProject();
  await exportResolveTrim(88);
  await applyStageAndCommit('Shorten opening for main');

  await page.getByRole('button', { name: 'View commit Import Resolve OTIO' }).click();
  await page.getByLabel('Branch from selected commit').fill('alternate-cut');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByText(/Created and switched to alternate-cut/u)).toBeVisible();
  await expect(page.getByLabel('Switch branch')).toHaveValue('alternate-cut');

  await page.getByLabel('Switch branch').selectOption('main');
  await expect(page.getByText('Switched to main.')).toBeVisible();
  await page.getByRole('button', { name: 'View commit Import Resolve OTIO' }).click();
  await page.getByRole('button', { name: 'Restore to working' }).click();
  await expect(page.getByText(/Restored [a-f0-9]{8} into the working timeline/u)).toBeVisible();
  await expect(page.getByText('Trimmed clip Opening')).toBeVisible();
});

test('returns to the dashboard with the project listed as most recently worked on', async () => {
  await openProject();
  await exportResolveTrim(84);
  await applyStageAndCommit('Trim for the dashboard');

  await page.getByRole('button', { name: 'Dashboard', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Video projects' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open Resolve Basic Cut' })).toContainText('Trim for the dashboard');
  await expect(page.locator('.state-pill.state-clean').first()).toBeVisible();
});

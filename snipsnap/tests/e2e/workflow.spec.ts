import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let application: ElectronApplication;
let page: Page;
let dataRoot: string;

test.beforeEach(async () => {
  dataRoot = await mkdtemp(path.join(os.tmpdir(), 'snipsnap-e2e-'));
  application = await electron.launch({
    args: [path.resolve('.')],
    env: { ...process.env, SNIPSNAP_DATA_ROOT: dataRoot },
  });
  page = await application.firstWindow();
  await page.waitForLoadState('domcontentloaded');
});

test.afterEach(async () => {
  await application.close();
  await rm(dataRoot, { recursive: true, force: true });
});

async function createDemo(): Promise<void> {
  await page.getByRole('button', { name: 'Create demo repository' }).click();
  await expect(page.getByText('WORKING TIMELINE')).toBeVisible();
  await expect(page.getByText('Create demo timeline')).toBeVisible();
}

async function stageAndCommit(message: string): Promise<void> {
  await page.getByRole('button', { name: 'Stage' }).first().click();
  await expect(page.getByText('Stage a complete semantic decision.')).toBeVisible();
  await page.getByLabel('Commit message').fill(message);
  await page.getByRole('button', { name: 'Commit', exact: true }).click();
  await expect(page.getByText(message)).toBeVisible();
}

async function createBranch(name: string): Promise<void> {
  await page.getByLabel('New branch').fill(name);
  await page.getByRole('button', { name: 'Create branch' }).click();
  await expect(page.getByRole('button', { name: new RegExp(name, 'u') })).toBeVisible();
}

test('edit, semantic stage, commit, branch, and clean merge', async () => {
  await createDemo();
  await createBranch('caption-copy');

  await page.getByRole('button', { name: 'none' }).first().click();
  await expect(page.getByText('Changed clip Intro: preset')).toBeVisible();
  await stageAndCommit('Warm the opening');

  await page.getByRole('button', { name: /caption-copy/u }).click();
  await expect(page.getByText(/Checked out caption-copy/u)).toBeVisible();
  await page.getByRole('button', { name: 'Ship the story, not the files.' }).click();
  await expect(page.getByText(/Changed caption text/u)).toBeVisible();
  await stageAndCommit('Rewrite caption');

  await page.getByRole('button', { name: /main/u }).click();
  await page.getByLabel('Compare branch').selectOption('caption-copy');
  await page.getByRole('button', { name: 'Compare', exact: true }).click();
  await expect(page.getByText(/Changed caption text/u)).toBeVisible();
  await page.getByRole('button', { name: /Merge into main/u }).click();
  await expect(page.getByText('Merge result: merged.')).toBeVisible();
  await expect(page.getByText('2 parents')).toBeVisible();
});

test('conflict resolver blocks completion until an explicit choice', async () => {
  await createDemo();
  await createBranch('alternate-trim');

  await page.getByLabel('Trim Intro').click();
  await stageAndCommit('Main trim');

  await page.getByRole('button', { name: /alternate-trim/u }).click();
  await expect(page.getByText(/Checked out alternate-trim/u)).toBeVisible();
  await page.getByLabel('Trim Intro').click();
  await expect(page.getByText('1–144f')).toBeVisible();
  await page.getByLabel('Trim Intro').click();
  await expect(page.getByText('2–144f')).toBeVisible();
  await stageAndCommit('Alternate trim');

  await page.getByRole('button', { name: /main/u }).click();
  await expect(page.getByText(/Checked out main/u)).toBeVisible();
  await page.getByLabel('Compare branch').selectOption('alternate-trim');
  await page.getByRole('button', { name: /Merge into main/u }).click();
  const resolver = page.getByRole('dialog', { name: 'Merge conflicts' });
  await expect(resolver).toBeVisible();
  await expect(resolver.getByRole('button', { name: 'Complete merge' })).toBeDisabled();
  await resolver.getByRole('button', { name: 'Theirs' }).click();
  await expect(resolver.getByRole('button', { name: 'Complete merge' })).toBeEnabled();
  await resolver.getByRole('button', { name: 'Complete merge' }).click();
  await expect(page.getByText('Two-parent merge commit created.')).toBeVisible();
});

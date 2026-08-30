import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let application: ElectronApplication | undefined;
let peerApplication: ElectronApplication | undefined;
let page: Page;
let dataRoot: string;
let resolveRoot: string;
let otioPath: string;
let sourceDocument: {
  tracks: {
    children: Array<{
      children: Array<{
        name?: string;
        source_range?: { duration: { value: number } };
        media_reference?: { target_url?: string };
      }>;
    }>;
  };
};

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

/** A short, deterministic clip so preview and scrubbing run against real media. */
function renderTestMedia(target: string): boolean {
  const result = spawnSync('ffmpeg', [
    '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=24:duration=20',
    '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', target,
  ], { stdio: 'ignore' });
  return result.status === 0;
}

function packagedAppPath(): string {
  const packageRoot = path.resolve('out', `SnipSnap-${process.platform}-${process.arch}`);
  return process.platform === 'darwin'
    ? path.join(packageRoot, 'SnipSnap.app', 'Contents', 'Resources', 'app.asar')
    : path.join(packageRoot, 'resources', 'app.asar');
}

/** Stand in for what SnipSnapSync.py writes: a .drp beside its .otio timeline. */
async function seedResolveExport(): Promise<void> {
  const folder = path.join(resolveRoot, 'Resolve Basic Cut');
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, 'Resolve Basic Cut.drp'), 'DaVinci Resolve project archive');
  otioPath = path.join(folder, 'Resolve Basic Cut.otio');
  const fixture = await readFile(path.join(__dirname, '..', 'fixtures', 'resolve-basic.otio'), 'utf8');
  sourceDocument = JSON.parse(fixture) as typeof sourceDocument;
  if (hasFfmpeg) {
    const media = path.join(folder, 'opening.mp4');
    if (renderTestMedia(media)) {
      const opening = sourceDocument.tracks.children[0]?.children.find(({ name }) => name === 'Opening');
      if (opening?.media_reference) opening.media_reference.target_url = `file://${media}`;
    }
  }
  await writeFile(otioPath, JSON.stringify(sourceDocument));
}

test.beforeEach(async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'snipsnap-e2e-'));
  dataRoot = path.join(workspace, 'data');
  resolveRoot = path.join(workspace, 'resolve');
  await mkdir(dataRoot, { recursive: true });
  await mkdir(resolveRoot, { recursive: true });
  await seedResolveExport();
  application = await electron.launch({
    args: [packagedAppPath()],
    env: {
      ...process.env,
      SNIPSNAP_DATA_ROOT: dataRoot,
      SNIPSNAP_RESOLVE_ROOT: resolveRoot,
      // Keep the machine's own Resolve database out of the fixture.
      SNIPSNAP_RESOLVE_DATABASE: path.join(resolveRoot, 'no-database'),
    },
  });
  page = await application.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByRole('heading', { name: 'Video projects' })).toBeVisible();
});

test.afterEach(async () => {
  if (peerApplication) await peerApplication.close();
  peerApplication = undefined;
  if (application) await application.close();
  application = undefined;
  await rm(path.dirname(dataRoot), { recursive: true, force: true });
});

async function openProject(): Promise<void> {
  await page.getByRole('button', { name: 'Open Resolve Basic Cut' }).click();
  await expect(page.getByLabel('Commit history')).toBeVisible();
}

async function exportResolveTrim(frames: number): Promise<void> {
  const opening = sourceDocument.tracks.children[0]?.children.find(({ name }) => name === 'Opening');
  if (!opening?.source_range) throw new Error('Fixture opening range missing');
  opening.source_range.duration.value = frames;
  await writeFile(otioPath, JSON.stringify(sourceDocument));
}

async function applyStageAndCommit(message: string): Promise<void> {
  await expect(page.getByText(/change(s)? detected in Resolve/u)).toBeVisible();
  await page.getByRole('button', { name: 'Apply to working timeline' }).click();
  await page.getByRole('button', { name: 'Stage', exact: true }).first().click();
  await page.getByLabel('Commit message').fill(message);
  await page.getByRole('button', { name: 'Commit', exact: true }).click();
  await expect(page.getByRole('button', { name: `View commit ${message}` })).toBeVisible();
}

test('lists the Resolve export and imports it on first open', async () => {
  await expect(page.getByText('New from Resolve')).toBeVisible();
  await openProject();

  // The path shown is the Resolve project file, not SnipSnap's own storage.
  await expect(page.locator('.path-text')).toHaveText(path.join(resolveRoot, 'Resolve Basic Cut', 'Resolve Basic Cut.drp'));
  await expect(page.getByRole('region', { name: 'Commit video preview' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Timeline tracks' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'View commit Import Resolve Basic Cut from Resolve' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Commit', exact: true })).toBeDisabled();
});

test('hides a project whose Resolve files have gone', async () => {
  await rm(path.join(resolveRoot, 'Resolve Basic Cut', 'Resolve Basic Cut.drp'));
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByRole('heading', { name: 'No Resolve projects found yet' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open Resolve Basic Cut' })).toHaveCount(0);
});

test('picks up a re-export, stages its semantic diff, and commits it', async () => {
  await openProject();
  await exportResolveTrim(90);
  await applyStageAndCommit('Tighten the opening');
  await expect(page.getByRole('button', { name: 'Commit', exact: true })).toBeDisabled();
});

test('splits the window into two commits and shows the frames the trim removed', async () => {
  await openProject();
  await exportResolveTrim(90);
  await applyStageAndCommit('Tighten the opening');

  await page.getByRole('button', { name: 'See diff' }).click();
  const comparison = page.getByRole('region', { name: 'Commit comparison' });
  await expect(comparison).toBeVisible();
  await expect(page.getByRole('region', { name: 'Base commit video preview' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Compared commit video preview' })).toBeVisible();

  // Six frames left the cut, so the lane shows a red slice, not a whole yellow clip.
  await expect(comparison.locator('.diff-part.part-removed')).toHaveCount(1);
  await expect(comparison.getByText('−6f cut')).toBeVisible();
  await expect(comparison.getByText(/6 frames .* cut/u)).toBeVisible();

  await page.getByRole('button', { name: 'Close comparison' }).click();
  await expect(page.getByRole('region', { name: 'Timeline tracks' })).toBeVisible();
});

test('creates a branch from an old commit, switches branches, and restores history safely', async () => {
  await openProject();
  await exportResolveTrim(88);
  await applyStageAndCommit('Shorten opening for main');

  await page.getByRole('button', { name: 'View commit Import Resolve Basic Cut from Resolve' }).click();
  await page.getByLabel('Branch from selected commit').fill('alternate-cut');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByText(/Created and switched to alternate-cut/u)).toBeVisible();
  await expect(page.getByLabel('Switch branch')).toHaveValue('alternate-cut');

  await page.getByLabel('Switch branch').selectOption('main');
  await expect(page.getByText('Switched to main.')).toBeVisible();
  await page.getByRole('button', { name: 'View commit Import Resolve Basic Cut from Resolve' }).click();
  await page.getByRole('button', { name: 'Restore to working' }).click();
  await expect(page.getByText(/Restored [a-f0-9]{8} into the working timeline/u)).toBeVisible();
  await expect(page.getByLabel('Working changes').getByText('Trimmed clip Opening')).toBeVisible();
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

test('hosts a project and lets a second app join and push a branch', async () => {
  await openProject();
  await page.getByRole('button', { name: 'Host this project' }).click();
  await expect(page.getByText('Hosting', { exact: true })).toBeVisible();
  const inviteCode = await page.getByLabel('Pairing code').inputValue();
  expect(inviteCode.length).toBeGreaterThan(40);

  const peerRoot = path.join(path.dirname(dataRoot), 'peer-data');
  const peerResolveRoot = path.join(path.dirname(dataRoot), 'peer-resolve');
  await mkdir(peerRoot, { recursive: true });
  await mkdir(peerResolveRoot, { recursive: true });
  peerApplication = await electron.launch({
    args: [packagedAppPath()],
    env: {
      ...process.env,
      SNIPSNAP_DATA_ROOT: peerRoot,
      SNIPSNAP_RESOLVE_ROOT: peerResolveRoot,
      SNIPSNAP_RESOLVE_DATABASE: path.join(peerResolveRoot, 'no-database'),
    },
  });
  const peerPage = await peerApplication.firstWindow();
  await peerPage.waitForLoadState('domcontentloaded');
  await peerPage.getByRole('button', { name: 'Join shared project' }).click();
  await peerPage.getByLabel('Pairing code').fill(inviteCode);
  await peerPage.getByRole('button', { name: 'Join and download' }).click();

  await expect(peerPage.getByLabel('Commit history')).toBeVisible();
  await expect(peerPage.getByText('Connected', { exact: true })).toBeVisible();
  await expect(peerPage.getByRole('button', { name: 'View commit Import Resolve Basic Cut from Resolve' })).toBeVisible();

  await peerPage.getByLabel('Branch from selected commit').fill('peer-cut');
  await peerPage.getByRole('button', { name: 'Create', exact: true }).click();
  await peerPage.getByRole('button', { name: 'Push commits' }).click();
  await expect(peerPage.getByText('Pushed peer-cut')).toBeVisible();
  await expect(page.getByLabel('Switch branch').locator('option[value="peer-cut"]')).toHaveCount(1);
});

test('scrubbing the sequence moves the video and playing moves the sequence', async () => {
  test.skip(!hasFfmpeg, 'needs ffmpeg to render a clip to scrub');
  await openProject();
  const lane = page.locator('.lane').first();
  await lane.scrollIntoViewIfNeeded();
  const box = await lane.boundingBox();
  if (!box) throw new Error('Timeline lane is not visible');

  await lane.click({ position: { x: box.width * 0.5, y: box.height / 2 } });
  await expect(page.locator('.timeline-counter')).not.toHaveText(/^00:00:00:00/u);
  const scrubbed = await page.evaluate(() => (document.querySelector('.viewer video') as HTMLVideoElement).currentTime);
  expect(scrubbed).toBeGreaterThan(0);

  await page.getByRole('button', { name: 'Play' }).click();
  await expect.poll(async () => page.evaluate(
    () => (document.querySelector('.viewer video') as HTMLVideoElement).currentTime,
  )).toBeGreaterThan(scrubbed);
  const playhead = await page.locator('.playhead').getAttribute('style');
  expect(playhead).not.toContain('left: 0%');
});

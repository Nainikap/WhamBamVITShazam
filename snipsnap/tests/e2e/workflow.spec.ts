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
let browserRenderedMedia: string | undefined;
let sourceDocument: {
  tracks: {
    children: Array<{
      children: Array<{
        name?: string;
        source_range?: { start_time: { value: number }; duration: { value: number } };
        media_reference?: { target_url?: string };
        metadata?: { videogit?: { gainDb?: number; preset?: 'warm' | 'cool' | 'mono' } };
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
async function seedResolveExport(needsPlayableMedia: boolean): Promise<void> {
  const folder = path.join(resolveRoot, 'Resolve Basic Cut');
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, 'Resolve Basic Cut.drp'), 'DaVinci Resolve project archive');
  otioPath = path.join(folder, 'Resolve Basic Cut.otio');
  const fixture = await readFile(path.join(__dirname, '..', 'fixtures', 'resolve-basic.otio'), 'utf8');
  sourceDocument = JSON.parse(fixture) as typeof sourceDocument;
  if (hasFfmpeg || needsPlayableMedia) {
    const media = path.join(folder, hasFfmpeg ? 'opening.mp4' : 'opening.webm');
    const opening = sourceDocument.tracks.children[0]?.children.find(({ name }) => name === 'Opening');
    const mediaReady = hasFfmpeg ? renderTestMedia(media) : true;
    if (mediaReady && opening?.media_reference) opening.media_reference.target_url = `file://${media}`;
    if (!hasFfmpeg) browserRenderedMedia = media;
  }
  await writeFile(otioPath, JSON.stringify(sourceDocument));
}

async function renderMediaInElectron(target: string): Promise<void> {
  const bytes = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 180;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas is unavailable');
    const stream = canvas.captureStream(12);
    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp8') ? 'video/webm;codecs=vp8' : 'video/webm';
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 120_000 });
    const chunks: Blob[] = [];
    recorder.ondataavailable = ({ data }) => { if (data.size > 0) chunks.push(data); };
    recorder.start(250);
    let frame = 0;
    const draw = window.setInterval(() => {
      context.fillStyle = frame % 2 === 0 ? '#2457ff' : '#22c55e';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = '#ffffff';
      context.font = '32px sans-serif';
      context.fillText(`SnipSnap ${frame}`, 45, 100);
      frame += 1;
    }, 80);
    await new Promise((resolve) => window.setTimeout(resolve, 6_000));
    window.clearInterval(draw);
    const stopped = new Promise<void>((resolve) => { recorder.onstop = () => resolve(); });
    recorder.stop();
    await stopped;
    stream.getTracks().forEach((track) => track.stop());
    return Array.from(new Uint8Array(await new Blob(chunks, { type: mimeType }).arrayBuffer()));
  });
  await writeFile(target, Buffer.from(bytes));
}

test.beforeEach(async ({ browserName }, testInfo) => {
  void browserName;
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'snipsnap-e2e-'));
  dataRoot = path.join(workspace, 'data');
  resolveRoot = path.join(workspace, 'resolve');
  browserRenderedMedia = undefined;
  await mkdir(dataRoot, { recursive: true });
  await mkdir(resolveRoot, { recursive: true });
  await seedResolveExport(testInfo.title.includes('scrubbing'));
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
  if (browserRenderedMedia) await renderMediaInElectron(browserRenderedMedia);
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

async function exportResolveBladeCut(): Promise<void> {
  const videoTrack = sourceDocument.tracks.children[0];
  const openingIndex = videoTrack?.children.findIndex(({ name }) => name === 'Opening') ?? -1;
  const opening = videoTrack?.children[openingIndex];
  if (!videoTrack || openingIndex < 0 || !opening?.source_range) throw new Error('Fixture opening range missing');
  const secondHalf = structuredClone(opening);
  const firstFrames = Math.floor(opening.source_range.duration.value / 2);
  opening.source_range.duration.value = firstFrames;
  if (!secondHalf.source_range) throw new Error('Fixture split range missing');
  secondHalf.source_range.start_time.value += firstFrames;
  secondHalf.source_range.duration.value -= firstFrames;
  videoTrack.children.splice(openingIndex + 1, 0, secondHalf);
  await writeFile(otioPath, JSON.stringify(sourceDocument));
}

async function exportResolveMultiFieldChange(): Promise<void> {
  const opening = sourceDocument.tracks.children[0]?.children.find(({ name }) => name === 'Opening');
  if (!opening?.source_range) throw new Error('Fixture opening range missing');
  opening.source_range.duration.value = 90;
  opening.metadata = { videogit: { gainDb: -6, preset: 'warm' } };
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

async function applyStageAllAndCommit(message: string): Promise<void> {
  await expect(page.getByText(/change(s)? detected in Resolve/u)).toBeVisible();
  await page.getByRole('button', { name: 'Apply to working timeline' }).click();
  const stageAll = page.getByRole('button', { name: 'Stage all', exact: true });
  await expect(stageAll).toBeEnabled();
  await stageAll.click();
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
  await expect(page.getByRole('list', { name: 'Commit graph' })).toBeVisible();
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
  await expect(page.getByRole('region', { name: 'Changes in commit Tighten the opening' })
    .getByText('Trimmed end of clip Opening by 6 frames')).toBeVisible();

  await page.getByRole('button', { name: 'Close comparison' }).click();
  await expect(page.getByRole('region', { name: 'Timeline tracks' })).toBeVisible();
});

test('shows commit diffs in the left history and focuses each semantic change independently', async () => {
  await openProject();
  await exportResolveMultiFieldChange();
  await applyStageAllAndCommit('Polish the opening');

  await page.getByRole('button', { name: 'View commit Import Resolve Basic Cut from Resolve' }).click();
  await expect(page.getByRole('region', { name: 'Changes in commit Polish the opening' })).toHaveCount(0);
  await page.getByRole('button', { name: 'View commit Polish the opening' }).click();

  const commitChanges = page.getByRole('region', { name: 'Changes in commit Polish the opening' });
  await expect(commitChanges).toBeVisible();
  const wholeCommit = commitChanges.getByRole('button', { name: 'View all changes in commit Polish the opening' });
  const trim = commitChanges.getByRole('button', { name: 'View diff Trimmed end of clip Opening by 6 frames' });
  const level = commitChanges.getByRole('button', { name: 'View diff Changed clip Opening: level' });
  const look = commitChanges.getByRole('button', { name: 'View diff Changed clip Opening: look' });
  await expect(wholeCommit).toContainText('3');
  await expect(trim).toBeVisible();
  await expect(level).toBeVisible();
  await expect(look).toBeVisible();

  await wholeCommit.click();
  const comparison = page.getByRole('region', { name: 'Commit comparison' });
  await expect(comparison.getByText('Whole commit: 3 changes together')).toBeVisible();
  await expect(wholeCommit).toHaveAttribute('aria-pressed', 'true');

  await level.click();
  await expect(comparison.getByText('Focused change: Changed clip Opening: level')).toBeVisible();
  await expect(level).toHaveAttribute('aria-pressed', 'true');
  await expect(wholeCommit).toHaveAttribute('aria-pressed', 'false');
  await expect(comparison.locator('.border-edited')).toHaveCount(1);
  await expect(comparison.locator('.border-retimed')).toHaveCount(0);

  await trim.click();
  await expect(comparison.getByText('Focused change: Trimmed end of clip Opening by 6 frames')).toBeVisible();
  await expect(comparison.locator('.border-retimed')).toHaveCount(1);
  await expect(comparison.locator('.border-edited')).toHaveCount(0);

  await look.click();
  await expect(comparison.getByText('Focused change: Changed clip Opening: look')).toBeVisible();
  await expect(look).toHaveAttribute('aria-pressed', 'true');

  await wholeCommit.click();
  await expect(comparison.getByText('Whole commit: 3 changes together')).toBeVisible();
  await expect(wholeCommit).toHaveAttribute('aria-pressed', 'true');
  await expect(trim).toBeVisible();
  await expect(level).toBeVisible();
  await expect(look).toBeVisible();
});

test('creates a branch from an old commit, switches branches, and restores history safely', async () => {
  await openProject();
  await exportResolveTrim(88);
  await applyStageAndCommit('Shorten opening for main');

  await page.getByRole('button', { name: 'View commit Import Resolve Basic Cut from Resolve' }).click();
  await page.getByLabel('Branch from selected commit').fill('alternate-cut');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByText(/Created and switched to alternate-cut/u)).toBeVisible();
  await expect(page.getByLabel('Switch branch')).toContainText('alternate-cut');

  await page.getByLabel('Switch branch').click();
  await page.getByRole('option', { name: /^main/u }).click();
  await expect(page.getByText('Switched to main.')).toBeVisible();
  await page.getByRole('button', { name: 'View commit Import Resolve Basic Cut from Resolve' }).click();
  await page.getByRole('button', { name: 'Restore to working' }).click();
  await expect(page.getByText(/Restored [a-f0-9]{8} into the working timeline/u)).toBeVisible();
  await expect(page.getByLabel('Working changes').getByText('Extended end of clip Opening by 8 frames')).toBeVisible();
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
  await page.getByLabel('Switch branch').click();
  await expect(page.getByRole('option', { name: /peer-cut/u })).toBeVisible();
});

test('shows one accurately named, atomic unstaged change for a blade cut', async () => {
  await openProject();
  await exportResolveBladeCut();
  await expect(page.getByText(/change detected in Resolve/u)).toBeVisible();
  await page.getByRole('button', { name: 'Apply to working timeline' }).click();
  const changes = page.getByLabel('Working changes');
  await expect(changes.getByText('Split clip Opening into 2 clips', { exact: true })).toBeVisible();
  await expect(changes.getByRole('button', { name: 'Stage', exact: true })).toHaveCount(1);

  await changes.getByRole('button', { name: 'Stage', exact: true }).click();
  await expect(changes.getByRole('button', { name: 'Unstage', exact: true })).toHaveCount(1);
  await changes.getByRole('button', { name: 'Unstage', exact: true }).click();
  await expect(changes.getByRole('button', { name: 'Stage', exact: true })).toHaveCount(1);
  await changes.getByRole('button', { name: 'Stage', exact: true }).click();
  await page.getByLabel('Commit message').fill('Split the opening at its midpoint');
  await page.getByRole('button', { name: 'Commit', exact: true }).click();
  await expect(page.getByRole('button', { name: 'View commit Split the opening at its midpoint' })).toBeVisible();
  await expect(page.getByText('The latest saved Resolve timeline matches this commit.')).toBeVisible();
});

test('scrubbing the sequence moves the video and playing moves the sequence', async () => {
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

// Drive the packaged SnipSnap app to the project editor and screenshot the new
// studio layout, mirroring the e2e fixture setup in tests/e2e/workflow.spec.ts.
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright-core';

const repo = path.resolve(import.meta.dirname, '..', '..');
const shots = path.join(repo, '.screens');

const workspace = await mkdtemp(path.join(os.tmpdir(), 'snipsnap-shot-'));
const dataRoot = path.join(workspace, 'data');
const resolveRoot = path.join(workspace, 'resolve');
await mkdir(dataRoot, { recursive: true });
await mkdir(shots, { recursive: true });

const folder = path.join(resolveRoot, 'Resolve Basic Cut');
await mkdir(folder, { recursive: true });
await writeFile(path.join(folder, 'Resolve Basic Cut.drp'), 'DaVinci Resolve project archive');
const fixture = JSON.parse(await readFile(path.join(repo, 'tests', 'fixtures', 'resolve-basic.otio'), 'utf8'));
const media = path.join(folder, 'opening.mp4');
const rendered = spawnSync('ffmpeg', [
  '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=24:duration=20',
  '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', media,
], { stdio: 'ignore' }).status === 0;
const opening = fixture.tracks.children[0]?.children.find(({ name }) => name === 'Opening');
if (rendered && opening?.media_reference) opening.media_reference.target_url = `file://${media}`;
await writeFile(path.join(folder, 'Resolve Basic Cut.otio'), JSON.stringify(fixture));

const packageRoot = path.resolve(repo, 'out', `SnipSnap-${process.platform}-${process.arch}`);
const appPath = process.platform === 'darwin'
  ? path.join(packageRoot, 'SnipSnap.app', 'Contents', 'Resources', 'app.asar')
  : path.join(packageRoot, 'resources', 'app.asar');

const application = await electron.launch({
  args: [appPath],
  env: {
    ...process.env,
    SNIPSNAP_DATA_ROOT: dataRoot,
    SNIPSNAP_RESOLVE_ROOT: resolveRoot,
    SNIPSNAP_RESOLVE_DATABASE: path.join(resolveRoot, 'no-database'),
  },
});

// Electron's own capture sidesteps the Playwright CDP screenshot path, which
// composites the emulated viewport against the real window and drifts.
async function shoot(name) {
  const data = await application.evaluate(async ({ BrowserWindow }) => {
    const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage();
    return image.toPNG().toString('base64');
  });
  await writeFile(path.join(shots, name), Buffer.from(data, 'base64'));
}

try {
  const page = await application.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  // Size the real window only — CDP viewport emulation makes the Electron
  // compositor paint the page at its screen position, cropping every capture.
  await application.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win?.setPosition(20, 28);
    win?.setContentSize(1400, 820);
  });
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Open Resolve Basic Cut' }).click();
  // The first import keeps the store busy long enough for the cube to fade in.
  await page.waitForTimeout(850);
  if (await page.locator('.vg-cube-veil').count()) await shoot('studio-busy.png');
  await page.getByLabel('Commit history').waitFor({ timeout: 30_000 });
  await page.waitForTimeout(3000); // shader paint + media probe settle
  const rects = () => page.evaluate(() => JSON.stringify({
    topbar: document.querySelector('.vg-topbar')?.getBoundingClientRect(),
    side: document.querySelector('.vg-studio-side')?.getBoundingClientRect(),
    inner: [window.innerWidth, window.innerHeight, window.devicePixelRatio],
  }));
  console.log('clean rects:', await rects());
  const osShot = async (name) => {
    const sourceId = await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].getMediaSourceId());
    spawnSync('screencapture', ['-o', '-x', '-l', sourceId.split(':')[1], path.join(shots, name)], { stdio: 'ignore' });
  };
  await osShot('studio-editor-os.png');
  await shoot('studio-editor.png');

  await page.evaluate(() => {
    const side = document.querySelector('.vg-studio-side');
    if (side) side.scrollTop = side.scrollHeight;
  });
  await page.waitForTimeout(400);
  await shoot('studio-side-bottom.png');
  await page.evaluate(() => {
    const side = document.querySelector('.vg-studio-side');
    if (side) side.scrollTop = 0;
  });

  // Scrub so the frame under the playhead is visible footage, then re-shoot.
  const lane = page.locator('.lane').first();
  const box = await lane.boundingBox();
  if (box) {
    await lane.click({ position: { x: box.width * 0.5, y: box.height / 2 } });
    await page.waitForTimeout(900);
    await shoot('studio-editor-scrubbed.png');
  }

  // Trim the fixture the way the e2e helper does, commit it, and open the diff.
  if (opening?.source_range) {
    opening.source_range.duration.value = 90;
    await writeFile(path.join(folder, 'Resolve Basic Cut.otio'), JSON.stringify(fixture));
    await page.getByText(/change(s)? detected in Resolve/u).waitFor({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Apply to working timeline' }).click();
    await page.getByRole('button', { name: 'Stage', exact: true }).first().click();
    await page.getByLabel('Commit message').fill('Tighten the opening');
    await page.getByRole('button', { name: 'Commit', exact: true }).click();
    await page.getByRole('button', { name: 'View commit Tighten the opening' }).waitFor();
    await page.getByRole('button', { name: 'See diff' }).click();
    await page.getByRole('region', { name: 'Commit comparison' }).waitFor();
    await page.waitForTimeout(2000);
    console.log('page state:', await page.evaluate(() => JSON.stringify({
      sx: window.scrollX,
      sy: window.scrollY,
      iw: window.innerWidth,
      ih: window.innerHeight,
      dpr: window.devicePixelRatio,
      vv: { w: window.visualViewport?.width, h: window.visualViewport?.height, s: window.visualViewport?.scale },
      doc: { w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight },
    })));
    console.log('window bounds:', JSON.stringify(await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((win) => ({ content: win.getContentBounds(), zoom: win.webContents.getZoomFactor() })))));
    console.log('diff rects:', await rects());
    await shoot('studio-diff.png');

    // The sidebar See diff button now toggles: close through it and keep the
    // expanded commit node's inline changes in frame.
    await page.getByRole('button', { name: 'Close diff', exact: true }).click();
    await page.getByRole('region', { name: 'Timeline tracks' }).waitFor();
    await page.waitForTimeout(600);
    await shoot('studio-graph.png');
  }

  console.log('DONE');
} finally {
  await application.close();
  await rm(workspace, { recursive: true, force: true });
}

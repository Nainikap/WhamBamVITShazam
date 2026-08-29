import { _electron as electron, test } from '@playwright/test';
import { cp, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function packagedAppPath(): string {
  const packageRoot = path.resolve('out', `SnipSnap-${process.platform}-${process.arch}`);
  return path.join(packageRoot, 'SnipSnap.app', 'Contents', 'Resources', 'app.asar');
}

const probe = () => {
  const vs = [...document.querySelectorAll('video')] as HTMLVideoElement[];
  return vs.map((v) => ({ paused: v.paused, t: Number(v.currentTime.toFixed(2)), rs: v.readyState, err: v.error?.code ?? null }));
};

test('diagnose interactions', async () => {
  test.setTimeout(120_000);
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'snipsnap-diag-'));
  await cp(path.join(os.homedir(), 'Library/Application Support/SnipSnap/v1-data'), dataRoot, { recursive: true });
  const application = await electron.launch({ args: [packagedAppPath()], env: { ...process.env, SNIPSNAP_DATA_ROOT: dataRoot } });
  const page = await application.firstWindow();
  page.on('console', (m) => { if (m.text().includes('DBG')) console.log('LOG:', m.text()); });
  page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
  await page.waitForLoadState('domcontentloaded');
  await page.setViewportSize({ width: 1500, height: 980 });
  await page.getByRole('button', { name: 'Open Ravi Kishan — First 10 Seconds' }).click();
  await page.waitForTimeout(2000);

  console.log('A. initial video:', JSON.stringify(await page.evaluate(probe)));
  console.log('A. counter:', await page.locator('.timeline-counter').textContent());

  // Seek by clicking the middle of the video lane, WITHOUT playing.
  const lane = page.locator('.lane').first();
  await lane.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  const box = await lane.boundingBox();
  console.log('B. lane box:', JSON.stringify(box), 'viewport:', JSON.stringify(page.viewportSize()));
  await lane.click({ position: { x: (box?.width ?? 100) * 0.5, y: (box?.height ?? 20) / 2 } });
  await page.waitForTimeout(900);
  console.log('B1. after lane click, counter:', await page.locator('.timeline-counter').textContent());

  const ruler = page.locator('.ruler');
  const rbox = await ruler.boundingBox();
  await ruler.click({ position: { x: (rbox?.width ?? 100) * 0.75, y: 10 } });
  await page.waitForTimeout(900);
  console.log('B2. after ruler click, counter:', await page.locator('.timeline-counter').textContent());

  const chip = page.locator('.lane .chip').first();
  const cbox = await chip.boundingBox();
  console.log('B3. chip box:', JSON.stringify(cbox));
  await chip.click({ position: { x: (cbox?.width ?? 100) * 0.25, y: 10 } });
  await page.waitForTimeout(900);
  console.log('B4. after chip click, counter:', await page.locator('.timeline-counter').textContent());
  await page.waitForTimeout(300);
  console.log('B. after clicking lane at 50%:', JSON.stringify(await page.evaluate(probe)));
  console.log('B. counter:', await page.locator('.timeline-counter').textContent());
  console.log('B. playhead left:', await page.locator('.playhead').getAttribute('style'));

  // Now play and check the playhead advances.
  await page.getByRole('button', { name: 'Play' }).click();
  await page.waitForTimeout(2500);
  console.log('C. while playing:', JSON.stringify(await page.evaluate(probe)));
  console.log('C. counter:', await page.locator('.timeline-counter').textContent());
  console.log('C. playhead left:', await page.locator('.playhead').getAttribute('style'));
  await page.getByRole('button', { name: 'Pause' }).click();

  // Diff view with two players.
  await page.getByRole('button', { name: 'See diff' }).click();
  await page.waitForTimeout(2500);
  console.log('D. diff videos:', JSON.stringify(await page.evaluate(probe)));
  const times = await page.locator('.transport span').allTextContents();
  console.log('D. diff transports:', JSON.stringify(times));
  await page.getByRole('button', { name: 'Play' }).first().click();
  await page.waitForTimeout(2500);
  console.log('E. diff after play:', JSON.stringify(await page.evaluate(probe)));
  console.log('E. diff transports:', JSON.stringify(await page.locator('.transport span').allTextContents()));

  await application.close();
});

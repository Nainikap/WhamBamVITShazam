import { _electron as electron, test } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('export button on the real machine', async () => {
  test.setTimeout(180_000);
  const installed = path.join(os.homedir(), 'Library/Containers/com.blackmagic-design.DaVinciResolveLite/Data/Library/Application Support/Fusion/Scripts/Utility/SnipSnapSync.py');
  await rm(installed, { force: true });
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'snipsnap-real-'));
  const application = await electron.launch({
    args: [path.resolve('out', 'SnipSnap-darwin-arm64', 'SnipSnap.app', 'Contents', 'Resources', 'app.asar')],
    env: { ...process.env, SNIPSNAP_DATA_ROOT: dataRoot },
  });
  const page = await application.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(2000);
  await page.getByRole('button', { name: 'Export from Resolve' }).click();
  await page.waitForTimeout(6000);
  console.log('ALERT:', await page.locator('.alert').innerText().catch(() => 'none'));
  console.log('CLASS:', await page.locator('.alert').getAttribute('class').catch(() => 'none'));
  await page.screenshot({ path: path.resolve(__dirname, '../../../.screens/real-export.png') });
  await application.close();
  const { existsSync } = await import('node:fs');
  console.log('SCRIPT INSTALLED BY APP:', existsSync(installed));
});

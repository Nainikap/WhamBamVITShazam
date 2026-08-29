import { _electron as electron, test, expect } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('capture current ui', async () => {
  test.setTimeout(240_000);
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'snipsnap-ui-'));
  const application = await electron.launch({
    args: [path.resolve('out', 'SnipSnap-darwin-arm64', 'SnipSnap.app', 'Contents', 'Resources', 'app.asar')],
    env: { ...process.env, SNIPSNAP_DATA_ROOT: dataRoot },
  });
  const page = await application.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByRole('heading', { name: 'Video projects' })).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(6000);
  await page.screenshot({ path: path.resolve(__dirname, '../../../.screens/ui-dashboard.png') });
  await page.getByRole('button', { name: /^Open / }).first().click();
  await page.waitForTimeout(4000);
  await page.screenshot({ path: path.resolve(__dirname, '../../../.screens/ui-editor.png') });
  await application.close();
});

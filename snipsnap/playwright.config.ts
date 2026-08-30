import { defineConfig } from '@playwright/test';

// Keep packaged Electron windows off the developer's real desktop. Playwright
// can drive a hidden BrowserWindow, so Hyprland never maps the black loading
// surface or the transient host/join states used by the workflow tests.
process.env.SNIPSNAP_E2E_HEADLESS = '1';
if (process.platform === 'linux') {
  process.env.OZONE_PLATFORM = 'x11';
  process.env.ELECTRON_OZONE_PLATFORM_HINT = 'x11';
  delete process.env.WAYLAND_DISPLAY;
}

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: { trace: 'retain-on-failure' },
});

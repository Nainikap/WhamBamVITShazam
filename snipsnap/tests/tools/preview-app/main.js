/*
 * A bare Electron shell that shows the prism preview on a real GPU and saves one
 * frame per stage. Looking at a WebGPU scene is the only way to review it.
 *
 *   node_modules/.bin/electron tests/tools/preview-app <url> <out-dir> [stages]
 */
const { app, BrowserWindow } = require('electron');
const { mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const [, , url, outDir, stageList] = process.argv;
const target = url || 'http://localhost:5199/prism-preview.html';
const out = outDir || path.resolve('.screens/prism');
const stages = (stageList || 'intro,library,project').split(',');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.commandLine.appendSwitch('enable-unsafe-webgpu');

app.whenReady().then(async () => {
  mkdirSync(out, { recursive: true });
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    backgroundColor: '#000000',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });

  window.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) process.stdout.write(`[console ${level}] ${message}\n`);
  });

  const [base, query] = target.split('?');
  const params = new URLSearchParams(query || '');

  for (const stage of stages) {
    params.set('stage', stage);
    await window.loadURL(`${base}?${params.toString()}`);
    await wait(3500);
    const shot = await window.webContents.capturePage();
    writeFileSync(path.join(out, `${stage}.png`), shot.toPNG());
    const info = await window.webContents.executeJavaScript(
      `({ stage: document.querySelector('.vg-shell')?.getAttribute('data-stage'), title: document.querySelector('#videogit-wordmark')?.textContent ?? document.querySelector('h1')?.textContent })`,
    );
    process.stdout.write(`wrote ${stage}.png ${JSON.stringify(info)}\n`);
  }

  app.quit();
});

import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import started from 'electron-squirrel-startup';
import { ProjectService, atomicWriteText } from './application';
import { createDemoProject } from './domain';
import { channels } from './ipc';

if (started) app.quit();

const dataRoot = process.env.SNIPSNAP_DATA_ROOT || path.join(app.getPath('userData'), 'v1-data');
const projects = new ProjectService(dataRoot);

function registerIpc(): void {
  ipcMain.handle(channels.listProjects, () => projects.listProjects());
  ipcMain.handle(channels.createDemo, async () => {
    const name = `Launch Cut ${new Date().toISOString().replace(/[:.]/gu, '-')}`;
    return projects.createProject(createDemoProject(name), 'Create demo timeline');
  });
  ipcMain.handle(channels.importOtio, async () => {
    const selection = await dialog.showOpenDialog({
      title: 'Import DaVinci Resolve OTIO',
      properties: ['openFile'],
      filters: [{ name: 'OpenTimelineIO', extensions: ['otio', 'json'] }],
    });
    const filePath = selection.filePaths[0];
    if (selection.canceled || !filePath) return null;
    const result = await projects.importOtio(await readFile(filePath, 'utf8'));
    return { id: result.id, name: result.name, unsupportedCount: result.unsupported.length };
  });
  ipcMain.handle(channels.status, (_event, projectId) => projects.status(projectId));
  ipcMain.handle(channels.edit, (_event, projectId, command, version) => projects.edit(projectId, command, version));
  ipcMain.handle(channels.stage, (_event, projectId, hunkIds, digest) => projects.stage(projectId, hunkIds, digest));
  ipcMain.handle(channels.unstage, (_event, projectId, hunkIds, digest) => projects.unstage(projectId, hunkIds, digest));
  ipcMain.handle(channels.commit, (_event, projectId, message, head) => projects.commit(projectId, message, head));
  ipcMain.handle(channels.createBranch, (_event, projectId, name) => projects.createBranch(projectId, name));
  ipcMain.handle(channels.checkout, (_event, projectId, branch, discard) => projects.checkout(projectId, branch, discard));
  ipcMain.handle(channels.compare, (_event, projectId, base, head) => projects.compare(projectId, base, head));
  ipcMain.handle(channels.merge, (_event, projectId, target, source) => projects.merge(projectId, target, source));
  ipcMain.handle(channels.resolveConflict, (_event, projectId, sessionId, resolution) => projects.resolveConflict(projectId, sessionId, resolution));
  ipcMain.handle(channels.completeMerge, (_event, projectId, sessionId) => projects.completeMerge(projectId, sessionId));
  ipcMain.handle(channels.abortMerge, (_event, projectId, sessionId) => projects.abortMerge(projectId, sessionId));
  ipcMain.handle(channels.tag, (_event, projectId, name, revision, message) => projects.tag(projectId, name, revision, message));
  ipcMain.handle(channels.exportOtio, async (_event, projectId: string, revision: string) => {
    const exported = await projects.exportOtio(projectId, revision);
    const destination = await dialog.showSaveDialog({
      title: 'Export immutable OTIO snapshot',
      defaultPath: `snipsnap-${exported.commitId.slice(0, 10)}.otio`,
      filters: [{ name: 'OpenTimelineIO', extensions: ['otio'] }],
    });
    if (destination.canceled || !destination.filePath) return { canceled: true };
    await atomicWriteText(destination.filePath, exported.contents);
    return { canceled: false, commitId: exported.commitId };
  });
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1050,
    minHeight: 700,
    backgroundColor: '#090b10',
    title: 'SnipSnap',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) void window.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  else void window.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch((error: unknown) => {
  dialog.showErrorBox('SnipSnap failed to start', error instanceof Error ? error.message : String(error));
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

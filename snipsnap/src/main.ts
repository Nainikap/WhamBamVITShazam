import { app, BrowserWindow, dialog, ipcMain, net, protocol } from 'electron';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import started from 'electron-squirrel-startup';
import { ProjectService, SourceWatchService, atomicWriteText } from './application';
import { createDemoProject } from './domain';
import { channels } from './ipc';

if (started) app.quit();

protocol.registerSchemesAsPrivileged([{
  scheme: 'snipsnap-media',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
}, {
  scheme: 'snipsnap-app',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
}]);

const dataRoot = process.env.SNIPSNAP_DATA_ROOT || path.join(app.getPath('userData'), 'v1-data');
const projects = new ProjectService(dataRoot);
const sourceWatcher = new SourceWatchService(async ({ projectId }) => {
  const result = await projects.scanOtioSource(projectId);
  if (result.changed || result.error) {
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send(channels.sourceChanged, projectId);
  }
});

async function restoreSourceWatchers(): Promise<void> {
  for (const project of await projects.listProjects()) {
    const binding = await projects.sourceBinding(project.id);
    if (binding) sourceWatcher.watch(project.id, binding.path);
  }
}

function registerMediaProtocol(): void {
  protocol.handle('snipsnap-media', async (request) => {
    try {
      const url = new URL(request.url);
      const [projectId, fingerprint] = url.pathname.split('/').filter(Boolean);
      if (url.hostname !== 'asset' || !projectId || !fingerprint) return new Response('Not found', { status: 404 });
      const mediaPath = await projects.resolveMediaFile(projectId, fingerprint);
      return net.fetch(pathToFileURL(mediaPath).href, { headers: request.headers });
    } catch {
      return new Response('Media unavailable', { status: 404 });
    }
  });
}

function rendererContentType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.html') return 'text/html; charset=utf-8';
  if (extension === '.js') return 'text/javascript; charset=utf-8';
  if (extension === '.css') return 'text/css; charset=utf-8';
  if (extension === '.svg') return 'image/svg+xml';
  if (extension === '.png') return 'image/png';
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  return 'application/octet-stream';
}

function registerApplicationProtocol(): void {
  const rendererRoot = path.resolve(app.getAppPath(), '.vite', 'renderer', MAIN_WINDOW_VITE_NAME);
  protocol.handle('snipsnap-app', async (request) => {
    try {
      const url = new URL(request.url);
      if (url.hostname !== 'app') return new Response('Not found', { status: 404 });
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
      if (relative.split('/').includes('..')) return new Response('Not found', { status: 404 });
      const filePath = path.resolve(rendererRoot, ...relative.split('/'));
      if (filePath !== rendererRoot && !filePath.startsWith(`${rendererRoot}${path.sep}`)) {
        return new Response('Not found', { status: 404 });
      }
      const contents = await readFile(filePath);
      return new Response(new Uint8Array(contents), { headers: { 'Content-Type': rendererContentType(filePath) } });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

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
    const result = await projects.importOtio(await readFile(filePath, 'utf8'), filePath);
    sourceWatcher.watch(result.id, filePath);
    return { id: result.id, name: result.name, unsupportedCount: result.unsupported.length };
  });
  ipcMain.handle(channels.status, (_event, projectId) => projects.status(projectId));
  ipcMain.handle(channels.connectOtioSource, async (_event, projectId: string, expectedVersion: number) => {
    const selection = await dialog.showOpenDialog({
      title: 'Connect Resolve OTIO export',
      properties: ['openFile'],
      filters: [{ name: 'OpenTimelineIO', extensions: ['otio', 'json'] }],
    });
    const sourcePath = selection.filePaths[0];
    if (selection.canceled || !sourcePath) return null;
    const result = await projects.connectOtioSource(projectId, sourcePath, expectedVersion);
    sourceWatcher.watch(projectId, sourcePath);
    return result;
  });
  ipcMain.handle(channels.scanOtioSource, (_event, projectId) => projects.scanOtioSource(projectId));
  ipcMain.handle(channels.applyPendingSync, (_event, projectId, digest, version) => projects.applyPendingSync(projectId, digest, version));
  ipcMain.handle(channels.dismissPendingSync, (_event, projectId, digest) => projects.dismissPendingSync(projectId, digest));
  ipcMain.handle(channels.stage, (_event, projectId, hunkIds, digest) => projects.stage(projectId, hunkIds, digest));
  ipcMain.handle(channels.unstage, (_event, projectId, hunkIds, digest) => projects.unstage(projectId, hunkIds, digest));
  ipcMain.handle(channels.commit, (_event, projectId, message, head) => projects.commit(projectId, message, head));
  ipcMain.handle(channels.createBranch, (_event, projectId, name) => projects.createBranch(projectId, name));
  ipcMain.handle(channels.createBranchFromRevision, (_event, projectId, name, revision) => projects.createBranchFromRevision(projectId, name, revision));
  ipcMain.handle(channels.checkout, (_event, projectId, branch, discard) => projects.checkout(projectId, branch, discard));
  ipcMain.handle(channels.restoreRevision, (_event, projectId, revision, version, discard) => projects.restoreRevisionToWorking(projectId, revision, version, discard));
  ipcMain.handle(channels.revisionDetails, (_event, projectId, revision, parentIndex) => projects.revisionDetails(projectId, revision, parentIndex));
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
  ipcMain.handle(channels.relinkMedia, async (_event, projectId: string, fingerprint: string, revision: string) => {
    const selection = await dialog.showOpenDialog({
      title: 'Locate original media',
      properties: ['openFile'],
      filters: [{ name: 'Video and audio', extensions: ['mov', 'mp4', 'mkv', 'mxf', 'avi', 'webm', 'wav', 'mp3', 'm4a'] }],
    });
    const mediaPath = selection.filePaths[0];
    if (selection.canceled || !mediaPath) return null;
    return projects.linkMedia(projectId, fingerprint, mediaPath, revision);
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

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.once('did-finish-load', () => {
    const applicationUrl = window.webContents.getURL();
    window.webContents.on('will-navigate', (event, navigationUrl) => {
      if (navigationUrl !== applicationUrl) event.preventDefault();
    });
  });

  const load = window.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL || 'snipsnap-app://app/index.html');
  void load.catch((error: unknown) => {
    dialog.showErrorBox('SnipSnap renderer failed to load', error instanceof Error ? error.message : String(error));
  });
}

app.whenReady().then(() => {
  registerMediaProtocol();
  registerApplicationProtocol();
  registerIpc();
  void restoreSourceWatchers();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch((error: unknown) => {
  dialog.showErrorBox('SnipSnap failed to start', error instanceof Error ? error.message : String(error));
  app.quit();
});

app.on('window-all-closed', () => {
  sourceWatcher.close();
  if (process.platform !== 'darwin') app.quit();
});

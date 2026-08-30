import { app, BrowserWindow, clipboard, dialog, ipcMain, protocol, shell } from 'electron';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import started from 'electron-squirrel-startup';
import {
  LanCollaborationService,
  ProjectService,
  ResolveBridgeService,
  SourceWatchService,
  atomicWriteText,
  installResolveScript,
  launchKdenlive,
  resolvePythonInvocation,
} from './application';
import { channels } from './ipc';

if (started) app.quit();

const keepE2eWindowHidden = process.env.SNIPSNAP_E2E_HEADLESS === '1';
if (keepE2eWindowHidden && process.platform === 'linux') {
  // Hidden Wayland toplevels cannot own Radix popup surfaces. X11/Xvfb keeps
  // the packaged UI testable without mapping anything into Hyprland.
  app.commandLine.appendSwitch('ozone-platform', 'x11');
  app.commandLine.appendSwitch('disable-gpu');
}
app.commandLine.appendSwitch('enable-unsafe-webgpu');
if (process.platform === 'win32') {
  // Chromium otherwise promotes <video> into an independent DirectComposition
  // surface. The first commit-to-commit seek can initialize that surface as a
  // full-window black overlay before the decoded frame arrives. Keep normal GPU
  // compositing and hardware decode, but composite video with the application.
  app.commandLine.appendSwitch('disable-direct-composition-video-overlays');
}

protocol.registerSchemesAsPrivileged([{
  scheme: 'snipsnap-media',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
}, {
  scheme: 'snipsnap-app',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
}]);

const runFile = promisify(execFile);

const dataRoot = process.env.SNIPSNAP_DATA_ROOT || path.join(app.getPath('userData'), 'v1-data');
const projects = new ProjectService(dataRoot);
function notifySourceChanged(projectId: string): void {
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send(channels.sourceChanged, projectId);
}
function notifyCollaborationChanged(projectId: string): void {
  void collaboration.status(projectId).then((status) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(channels.collaborationChanged, projectId, status);
    }
  });
}
const sourceWatcher = new SourceWatchService(async ({ projectId }) => {
  const result = await projects.scanOtioSource(projectId);
  if (result.changed || result.error) notifySourceChanged(projectId);
});

async function restoreSourceConnections(): Promise<void> {
  for (const project of await projects.listProjects()) {
    const binding = await projects.sourceBinding(project.id);
    if (binding?.mode === 'file' || binding?.mode === 'kdenlive') sourceWatcher.watch(project.id, binding.path);
  }
}

const mediaTypes: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mxf': 'application/mxf',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
};

/**
 * Serve media with byte-range support. Without 206 responses Chromium can play a
 * clip from the start but cannot seek, so every scrub snaps back to frame zero.
 */
async function serveMedia(filePath: string, rangeHeader: string | null): Promise<Response> {
  const { size } = await stat(filePath);
  const headers: Record<string, string> = {
    'Accept-Ranges': 'bytes',
    'Content-Type': mediaTypes[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    'Cache-Control': 'no-store',
  };
  const unsatisfiable = () => new Response(null, {
    status: 416,
    headers: { ...headers, 'Content-Range': `bytes */${size}` },
  });
  const match = /^bytes=(\d*)-(\d*)$/u.exec((rangeHeader ?? '').trim());

  if (!match || size === 0) {
    return new Response(Readable.toWeb(createReadStream(filePath)) as ReadableStream, {
      status: 200,
      headers: { ...headers, 'Content-Length': String(size) },
    });
  }

  const [, startText = '', endText = ''] = match;
  let start: number;
  let end: number;
  if (startText === '') {
    const suffix = Number(endText);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return unsatisfiable();
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(startText);
    if (!Number.isSafeInteger(start) || start >= size) return unsatisfiable();
    end = endText === '' ? size - 1 : Math.min(Number(endText), size - 1);
  }
  if (!Number.isSafeInteger(end) || end < start) return unsatisfiable();

  return new Response(Readable.toWeb(createReadStream(filePath, { start, end })) as ReadableStream, {
    status: 206,
    headers: { ...headers, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${size}` },
  });
}

function registerMediaProtocol(): void {
  protocol.handle('snipsnap-media', async (request) => {
    try {
      const url = new URL(request.url);
      const [projectId, fingerprint] = url.pathname.split('/').filter(Boolean);
      if (url.hostname !== 'asset' || !projectId || !fingerprint) return new Response('Not found', { status: 404 });
      const mediaPath = await projects.resolveMediaFile(projectId, fingerprint);
      return await serveMedia(mediaPath, request.headers.get('Range'));
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
  if (extension === '.woff2') return 'font/woff2';
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

/** The export script ships beside the app, not inside its asar. */
function resolveScriptPath(): string {
  const candidates = [
    path.join(process.resourcesPath ?? '', 'resolve', 'SnipSnapSync.py'),
    path.resolve(app.getAppPath(), '..', 'resolve', 'SnipSnapSync.py'),
    path.resolve(app.getAppPath(), '..', '..', 'resolve', 'SnipSnapSync.py'),
  ];
  return candidates.find((candidate) => candidate && existsSync(candidate)) ?? candidates[0] ?? '';
}

function resolveSaveBridgePath(): string {
  return path.join(path.dirname(resolveScriptPath()), 'SnipSnapSaveBridge.py');
}

const resolveBridge = new ResolveBridgeService(projects, resolveSaveBridgePath(), notifySourceChanged);
const collaboration = new LanCollaborationService(
  dataRoot,
  projects,
  notifyCollaborationChanged,
  notifyCollaborationChanged,
);

function registerIpc(): void {
  ipcMain.handle(channels.listProjects, () => projects.listProjects());
  ipcMain.handle(channels.listOverviews, () => projects.listProjectOverviews());
  ipcMain.handle(channels.openProject, async (_event, projectId: string) => {
    let status = await projects.openProjectById(projectId);
    const binding = await projects.sourceBinding(projectId);
    if (binding?.mode === 'file' || binding?.mode === 'kdenlive') sourceWatcher.watch(projectId, binding.path);
    if (binding?.mode === 'resolve') {
      await resolveBridge.startExclusive(projectId, status.workspaceVersion);
      status = await projects.status(projectId);
    }
    return status;
  });
  ipcMain.handle(channels.resolveRoots, () => projects.resolveRoots());
  ipcMain.handle(channels.importKdenliveOtio, async () => {
    const selection = await dialog.showOpenDialog({
      title: 'Import an OTIO timeline exported by Kdenlive',
      message: 'In Kdenlive use File \u203a OpenTimelineIO Export, then choose that .otio file here.',
      properties: ['openFile'],
      filters: [{ name: 'Kdenlive OpenTimelineIO', extensions: ['otio', 'json'] }],
    });
    const sourcePath = selection.filePaths[0];
    if (selection.canceled || !sourcePath) return null;
    const result = await projects.importKdenliveSource(sourcePath);
    sourceWatcher.watch(result.status.project.id, sourcePath);
    return result;
  });
  ipcMain.handle(channels.openInKdenlive, async (_event, projectId: string, revision: string) => {
    const handoff = await projects.prepareKdenliveHandoff(projectId, revision);
    // Kdenlive has no command-line switch for its OTIO importer. Passing the
    // file positionally is actively wrong: it treats the JSON as a media clip.
    // Prepare a truthful handoff instead and put the exact file one paste away.
    if (process.env.SNIPSNAP_E2E_HEADLESS !== '1') {
      clipboard.writeText(handoff.filePath);
      shell.showItemInFolder(handoff.filePath);
    }
    await launchKdenlive();
    return { ...handoff, requiresManualImport: true as const };
  });
  ipcMain.handle(channels.addResolveProjectFile, async () => {
    const selection = await dialog.showOpenDialog({
      title: 'Choose a DaVinci Resolve project file',
      message: 'Pick a .drp file. SnipSnap watches the folder it sits in.',
      properties: ['openFile'],
      filters: [{ name: 'DaVinci Resolve project', extensions: ['drp'] }],
    });
    const projectFile = selection.filePaths[0];
    if (selection.canceled || !projectFile) return null;
    return projects.addResolveProjectFile(projectFile);
  });
  ipcMain.handle(channels.exportFromResolve, async () => {
    // Resolve does not have to be running for this: a project database on disk
    // holds enough to rebuild its timelines.
    const rebuilt = await projects.rebuildTimelinesFromResolveDatabase();
    if (rebuilt.timelines > 0) {
      return {
        ok: true,
        message: `Rebuilt ${rebuilt.timelines} timeline${rebuilt.timelines === 1 ? '' : 's'} from `
          + `${rebuilt.projects} Resolve project${rebuilt.projects === 1 ? '' : 's'}.`,
      };
    }
    const script = resolveScriptPath();
    let output = '';
    try {
      const python = resolvePythonInvocation();
      const result = await runFile(python.command, [...python.prefix, script, '--all'], {
        timeout: 120_000,
        windowsHide: true,
      });
      output = result.stdout;
      if (!output.includes('Could not reach DaVinci Resolve')) {
        const summary = output.trim().split('\n').filter(Boolean).at(-2) ?? 'Export finished.';
        return { ok: !output.includes('0 project(s)'), message: summary };
      }
    } catch (error) {
      output = error instanceof Error && 'stdout' in error ? String((error as { stdout: unknown }).stdout) : '';
      if (!output.includes('Could not reach DaVinci Resolve')) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    }

    // Resolve will not answer from outside, which the App Store build never
    // does. Put the script where Resolve runs it itself and say so.
    const installed = await installResolveScript(script);
    if (installed.length === 0) {
      return {
        ok: false,
        message: 'DaVinci Resolve is not answering, and its Scripts folder could not be found. '
          + 'Export the timeline from Resolve with File \u203a Export \u203a Timeline, then use Add folder here.',
      };
    }
    return {
      ok: false,
      installed: true,
      message: `Resolve does not accept outside scripting, so SnipSnapSync has been installed into its `
        + `Scripts menu (${installed.length} location${installed.length === 1 ? '' : 's'}). In Resolve choose `
        + 'Workspace \u203a Scripts \u203a SnipSnapSync, then press Refresh here.',
    };
  });
  ipcMain.handle(channels.addResolveFolder, async () => {
    const selection = await dialog.showOpenDialog({
      title: 'Choose a folder holding Resolve project exports',
      message: 'Pick a folder that contains .drp project files exported next to their .otio timelines.',
      properties: ['openDirectory'],
    });
    const folder = selection.filePaths[0];
    if (selection.canceled || !folder) return null;
    return projects.addResolveRoot(folder);
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
    await resolveBridge.stop(projectId);
    const result = await projects.connectOtioSource(projectId, sourcePath, expectedVersion);
    sourceWatcher.watch(projectId, sourcePath);
    return result;
  });
  ipcMain.handle(channels.startResolveBridge, async (_event, projectId: string, expectedVersion: number) => {
    sourceWatcher.unwatch(projectId);
    if (resolveBridge.isRunning(projectId)) await resolveBridge.stop(projectId);
    await resolveBridge.startExclusive(projectId, expectedVersion);
    return projects.status(projectId);
  });
  ipcMain.handle(channels.stopResolveBridge, async (_event, projectId: string) => {
    await resolveBridge.stop(projectId);
    return projects.status(projectId);
  });
  ipcMain.handle(channels.scanOtioSource, (_event, projectId) => projects.scanOtioSource(projectId));
  ipcMain.handle(channels.applyPendingSync, (_event, projectId, digest, version) => projects.applyPendingSync(projectId, digest, version));
  ipcMain.handle(channels.dismissPendingSync, (_event, projectId, digest) => projects.dismissPendingSync(projectId, digest));
  ipcMain.handle(channels.stage, (_event, projectId, hunkIds, digest) => projects.stage(projectId, hunkIds, digest));
  ipcMain.handle(channels.unstage, (_event, projectId, hunkIds, digest) => projects.unstage(projectId, hunkIds, digest));
  ipcMain.handle(channels.commit, (_event, projectId, message, head, indexDigest) => (
    projects.commit(projectId, message, head, indexDigest)
  ));
  ipcMain.handle(channels.createBranch, (_event, projectId, name) => projects.createBranch(projectId, name));
  ipcMain.handle(channels.createBranchFromRevision, (_event, projectId, name, revision) => projects.createBranchFromRevision(projectId, name, revision));
  ipcMain.handle(channels.checkout, (_event, projectId, branch, discard) => projects.checkout(projectId, branch, discard));
  ipcMain.handle(channels.restoreRevision, (_event, projectId, revision, version, discard) => projects.restoreRevisionToWorking(projectId, revision, version, discard));
  ipcMain.handle(channels.revisionDetails, (_event, projectId, revision, parentIndex) => projects.revisionDetails(projectId, revision, parentIndex));
  ipcMain.handle(channels.compare, (_event, projectId, base, head) => projects.compare(projectId, base, head));
  ipcMain.handle(channels.compareTimelines, (_event, projectId, base, head) => projects.compareTimelines(projectId, base, head));
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
  ipcMain.handle(channels.collaborationStartHost, (_event, projectId: string) => collaboration.startHosting(projectId));
  ipcMain.handle(channels.collaborationStopHost, () => collaboration.stopHosting());
  ipcMain.handle(channels.collaborationJoin, (_event, inviteCode: string) => collaboration.join(inviteCode));
  ipcMain.handle(channels.collaborationPull, (_event, projectId: string) => collaboration.pull(projectId));
  ipcMain.handle(channels.collaborationPush, (_event, projectId: string) => collaboration.push(projectId));
  ipcMain.handle(channels.collaborationStatus, (_event, projectId?: string) => collaboration.status(projectId));
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 680,
    minHeight: 520,
    show: false,
    backgroundColor: '#0c0c0e',
    title: 'SnipSnap',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: !keepE2eWindowHidden,
    },
  });

  // Do not expose Chromium's empty native surface while the renderer is
  // loading. On Windows that surface appears as a full black window.
  window.once('ready-to-show', () => {
    if (!keepE2eWindowHidden) window.show();
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
  void restoreSourceConnections();
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
  resolveBridge.close();
  void collaboration.stopHosting();
  if (process.platform !== 'darwin') app.quit();
});

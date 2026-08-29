import { contextBridge, ipcRenderer } from 'electron';
import { channels, type SnipSnapApi } from './ipc';

const api: SnipSnapApi = {
  listProjects: () => ipcRenderer.invoke(channels.listProjects),
  listOverviews: () => ipcRenderer.invoke(channels.listOverviews),
  openProject: (projectId) => ipcRenderer.invoke(channels.openProject, projectId),
  addResolveFolder: () => ipcRenderer.invoke(channels.addResolveFolder),
  addResolveProjectFile: () => ipcRenderer.invoke(channels.addResolveProjectFile),
  exportFromResolve: () => ipcRenderer.invoke(channels.exportFromResolve),
  resolveRoots: () => ipcRenderer.invoke(channels.resolveRoots),
  status: (projectId) => ipcRenderer.invoke(channels.status, projectId),
  connectOtioSource: (projectId, expectedVersion) => ipcRenderer.invoke(channels.connectOtioSource, projectId, expectedVersion),
  scanOtioSource: (projectId) => ipcRenderer.invoke(channels.scanOtioSource, projectId),
  applyPendingSync: (projectId, digest, expectedVersion) => ipcRenderer.invoke(channels.applyPendingSync, projectId, digest, expectedVersion),
  dismissPendingSync: (projectId, digest) => ipcRenderer.invoke(channels.dismissPendingSync, projectId, digest),
  onSourceChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, projectId: string) => listener(projectId);
    ipcRenderer.on(channels.sourceChanged, handler);
    return () => ipcRenderer.removeListener(channels.sourceChanged, handler);
  },
  stage: (projectId, hunkIds, expectedIndexDigest) => ipcRenderer.invoke(channels.stage, projectId, hunkIds, expectedIndexDigest),
  unstage: (projectId, hunkIds, expectedIndexDigest) => ipcRenderer.invoke(channels.unstage, projectId, hunkIds, expectedIndexDigest),
  commit: (projectId, message, expectedHead) => ipcRenderer.invoke(channels.commit, projectId, message, expectedHead),
  createBranch: (projectId, name) => ipcRenderer.invoke(channels.createBranch, projectId, name),
  createBranchFromRevision: (projectId, name, revision) => ipcRenderer.invoke(channels.createBranchFromRevision, projectId, name, revision),
  checkout: (projectId, branch, discardChanges) => ipcRenderer.invoke(channels.checkout, projectId, branch, discardChanges),
  restoreRevision: (projectId, revision, expectedVersion, discardChanges) => ipcRenderer.invoke(channels.restoreRevision, projectId, revision, expectedVersion, discardChanges),
  revisionDetails: (projectId, revision, parentIndex) => ipcRenderer.invoke(channels.revisionDetails, projectId, revision, parentIndex),
  compare: (projectId, base, head) => ipcRenderer.invoke(channels.compare, projectId, base, head),
  compareTimelines: (projectId, base, head) => ipcRenderer.invoke(channels.compareTimelines, projectId, base, head),
  merge: (projectId, target, source) => ipcRenderer.invoke(channels.merge, projectId, target, source),
  resolveConflict: (projectId, sessionId, resolution) => ipcRenderer.invoke(channels.resolveConflict, projectId, sessionId, resolution),
  completeMerge: (projectId, sessionId) => ipcRenderer.invoke(channels.completeMerge, projectId, sessionId),
  abortMerge: (projectId, sessionId) => ipcRenderer.invoke(channels.abortMerge, projectId, sessionId),
  tag: (projectId, name, revision, message) => ipcRenderer.invoke(channels.tag, projectId, name, revision, message),
  exportOtio: (projectId, revision) => ipcRenderer.invoke(channels.exportOtio, projectId, revision),
  relinkMedia: (projectId, fingerprint, revision) => ipcRenderer.invoke(channels.relinkMedia, projectId, fingerprint, revision),
};

contextBridge.exposeInMainWorld('snipsnap', api);

import { contextBridge, ipcRenderer } from 'electron';
import { channels, type SnipSnapApi } from './ipc';

const api: SnipSnapApi = {
  listProjects: () => ipcRenderer.invoke(channels.listProjects),
  createDemo: () => ipcRenderer.invoke(channels.createDemo),
  importOtio: () => ipcRenderer.invoke(channels.importOtio),
  status: (projectId) => ipcRenderer.invoke(channels.status, projectId),
  edit: (projectId, command, expectedVersion) => ipcRenderer.invoke(channels.edit, projectId, command, expectedVersion),
  stage: (projectId, hunkIds, expectedIndexDigest) => ipcRenderer.invoke(channels.stage, projectId, hunkIds, expectedIndexDigest),
  unstage: (projectId, hunkIds, expectedIndexDigest) => ipcRenderer.invoke(channels.unstage, projectId, hunkIds, expectedIndexDigest),
  commit: (projectId, message, expectedHead) => ipcRenderer.invoke(channels.commit, projectId, message, expectedHead),
  createBranch: (projectId, name) => ipcRenderer.invoke(channels.createBranch, projectId, name),
  checkout: (projectId, branch, discardChanges) => ipcRenderer.invoke(channels.checkout, projectId, branch, discardChanges),
  compare: (projectId, base, head) => ipcRenderer.invoke(channels.compare, projectId, base, head),
  merge: (projectId, target, source) => ipcRenderer.invoke(channels.merge, projectId, target, source),
  resolveConflict: (projectId, sessionId, resolution) => ipcRenderer.invoke(channels.resolveConflict, projectId, sessionId, resolution),
  completeMerge: (projectId, sessionId) => ipcRenderer.invoke(channels.completeMerge, projectId, sessionId),
  abortMerge: (projectId, sessionId) => ipcRenderer.invoke(channels.abortMerge, projectId, sessionId),
  tag: (projectId, name, revision, message) => ipcRenderer.invoke(channels.tag, projectId, name, revision, message),
  exportOtio: (projectId, revision) => ipcRenderer.invoke(channels.exportOtio, projectId, revision),
};

contextBridge.exposeInMainWorld('snipsnap', api);

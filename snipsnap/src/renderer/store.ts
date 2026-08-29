import { create } from 'zustand';
import type { MergeSession, ProjectStatus, ProjectSummary, RevisionDetails } from '../application';
import type { SemanticHunk } from '../diff';
import type { ConflictChoice } from '../merge';

interface AppStore {
  projects: ProjectSummary[];
  currentProjectId: string | null;
  status: ProjectStatus | null;
  selectedRevision: RevisionDetails | null;
  comparison: SemanticHunk[];
  mergeSession: MergeSession | null;
  busy: boolean;
  error: string | null;
  notice: string | null;
  selectedCommit: string | null;
  initialize(): Promise<void>;
  listenForSourceChanges(): () => void;
  selectProject(id: string): Promise<void>;
  createDemo(): Promise<void>;
  importOtio(): Promise<void>;
  connectSource(): Promise<void>;
  scanSource(): Promise<void>;
  applySource(): Promise<void>;
  dismissSource(): Promise<void>;
  stage(hunkId: string): Promise<void>;
  unstage(hunkId: string): Promise<void>;
  commit(message: string): Promise<void>;
  loadRevision(revision: string, parentIndex?: number): Promise<void>;
  createBranch(name: string): Promise<void>;
  createBranchFromSelected(name: string): Promise<void>;
  checkout(branch: string, discard: boolean): Promise<void>;
  restoreSelected(discard: boolean): Promise<void>;
  compare(branch: string): Promise<void>;
  merge(source: string): Promise<void>;
  resolve(conflictId: string, choice: ConflictChoice): Promise<void>;
  completeMerge(): Promise<void>;
  abortMerge(): Promise<void>;
  tag(name: string): Promise<void>;
  exportSelected(): Promise<void>;
  relinkMedia(fingerprint: string): Promise<void>;
  clearError(): void;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /u, '') : String(error);
}

export const useAppStore = create<AppStore>((set, get) => {
  async function run(operation: () => Promise<void>): Promise<void> {
    set({ busy: true, error: null, notice: null });
    try {
      await operation();
    } catch (error) {
      set({ error: message(error) });
    } finally {
      set({ busy: false });
    }
  }

  async function refresh(projectId: string, revision?: string): Promise<void> {
    const status = await window.snipsnap.status(projectId);
    const selectedRevision = await window.snipsnap.revisionDetails(projectId, revision ?? status.headCommit);
    set({ status, selectedRevision, currentProjectId: projectId, comparison: [] });
  }

  return {
    projects: [], currentProjectId: null, status: null, selectedRevision: null,
    comparison: [], mergeSession: null, busy: false, error: null, notice: null,
    initialize: () => run(async () => {
      const projects = await window.snipsnap.listProjects();
      set({ projects });
      if (projects[0]) await refresh(projects[0].id);
    }),
    listenForSourceChanges: () => window.snipsnap.onSourceChanged((projectId) => {
      if (get().currentProjectId !== projectId) return;
      void run(async () => {
        const selected = get().selectedRevision?.commit.id;
        await refresh(projectId, selected);
        const pending = get().status?.source.pending;
        set({ notice: pending ? `Resolve exported ${pending.changeCount} timeline change${pending.changeCount === 1 ? '' : 's'}. Review before applying.` : 'Resolve source status updated.' });
      });
    }),
    selectProject: (id) => run(() => refresh(id)),
    createDemo: () => run(async () => {
      const project = await window.snipsnap.createDemo();
      set({ projects: [...get().projects, project] });
      await refresh(project.id);
      set({ notice: 'Demo repository created. Connect a Resolve OTIO export to begin syncing.' });
    }),
    importOtio: () => run(async () => {
      const imported = await window.snipsnap.importOtio();
      if (!imported) return;
      set({ projects: [...get().projects, imported] });
      await refresh(imported.id);
      set({ notice: imported.unsupportedCount
        ? `Imported and connected with ${imported.unsupportedCount} unsupported item${imported.unsupportedCount === 1 ? '' : 's'} reported.`
        : 'Resolve OTIO imported and connected for change detection.' });
    }),
    connectSource: () => run(async () => {
      const { currentProjectId, status } = get();
      if (!currentProjectId || !status) return;
      const result = await window.snipsnap.connectOtioSource(currentProjectId, status.workspaceVersion);
      if (!result) return;
      set({ status: result.status });
      if (result.error) set({ error: result.error });
      else set({ notice: result.changed ? 'Resolve source connected. Review the detected timeline changes.' : 'Resolve source connected and up to date.' });
    }),
    scanSource: () => run(async () => {
      const projectId = get().currentProjectId;
      if (!projectId) return;
      const result = await window.snipsnap.scanOtioSource(projectId);
      set({ status: result.status });
      if (result.error) set({ error: result.error });
      else set({ notice: result.changed ? 'Resolve timeline changes are ready for review.' : 'Resolve export is already up to date.' });
    }),
    applySource: () => run(async () => {
      const { currentProjectId, status } = get();
      const pending = status?.source.pending;
      if (!currentProjectId || !status || !pending) return;
      set({
        status: await window.snipsnap.applyPendingSync(currentProjectId, pending.digest, status.workspaceVersion),
        notice: 'Resolve changes applied to the working timeline. Stage the decisions you want to commit.',
      });
    }),
    dismissSource: () => run(async () => {
      const { currentProjectId, status } = get();
      const pending = status?.source.pending;
      if (!currentProjectId || !pending) return;
      set({ status: await window.snipsnap.dismissPendingSync(currentProjectId, pending.digest), notice: 'This Resolve export was ignored.' });
    }),
    stage: (hunkId) => run(async () => {
      const { currentProjectId, status } = get();
      if (!currentProjectId || !status) return;
      set({ status: await window.snipsnap.stage(currentProjectId, [hunkId], status.indexDigest) });
    }),
    unstage: (hunkId) => run(async () => {
      const { currentProjectId, status } = get();
      if (!currentProjectId || !status) return;
      set({ status: await window.snipsnap.unstage(currentProjectId, [hunkId], status.indexDigest) });
    }),
    commit: (commitMessage) => run(async () => {
      const { currentProjectId, status } = get();
      if (!currentProjectId || !status) return;
      const next = await window.snipsnap.commit(currentProjectId, commitMessage, status.headCommit);
      const selectedRevision = await window.snipsnap.revisionDetails(currentProjectId, next.headCommit);
      set({ status: next, selectedRevision, notice: 'Staged Resolve timeline changes committed.' });
    }),
    loadRevision: (revision, parentIndex = 0) => run(async () => {
      const projectId = get().currentProjectId;
      if (!projectId) return;
      set({ selectedRevision: await window.snipsnap.revisionDetails(projectId, revision, parentIndex) });
    }),
    createBranch: (name) => run(async () => {
      const projectId = get().currentProjectId;
      if (!projectId) return;
      set({ status: await window.snipsnap.createBranch(projectId, name), notice: `Created branch ${name} at HEAD.` });
    }),
    createBranchFromSelected: (name) => run(async () => {
      const { currentProjectId, selectedRevision } = get();
      if (!currentProjectId || !selectedRevision) return;
      const status = await window.snipsnap.createBranchFromRevision(currentProjectId, name, selectedRevision.commit.id);
      const details = await window.snipsnap.revisionDetails(currentProjectId, status.headCommit);
      set({ status, selectedRevision: details, comparison: [], notice: `Created and switched to ${name} from ${details.commit.id.slice(0, 8)}.` });
    }),
    checkout: (branch, discard) => run(async () => {
      const projectId = get().currentProjectId;
      if (!projectId) return;
      const status = await window.snipsnap.checkout(projectId, branch, discard);
      const selectedRevision = await window.snipsnap.revisionDetails(projectId, status.headCommit);
      set({ status, selectedRevision, comparison: [], notice: `Switched to ${branch}.` });
    }),
    restoreSelected: (discard) => run(async () => {
      const { currentProjectId, status, selectedRevision } = get();
      if (!currentProjectId || !status || !selectedRevision) return;
      const next = await window.snipsnap.restoreRevision(
        currentProjectId, selectedRevision.commit.id, status.workspaceVersion, discard,
      );
      set({ status: next, notice: `Restored ${selectedRevision.commit.id.slice(0, 8)} into WORKING. Review and commit the resulting changes.` });
    }),
    compare: (branch) => run(async () => {
      const { currentProjectId, status } = get();
      if (!currentProjectId || !status) return;
      set({ comparison: await window.snipsnap.compare(currentProjectId, `refs/heads/${status.branch}`, `refs/heads/${branch}`) });
    }),
    merge: (source) => run(async () => {
      const { currentProjectId, status } = get();
      if (!currentProjectId || !status) return;
      const outcome = await window.snipsnap.merge(currentProjectId, status.branch, source);
      if (outcome.status === 'conflicts' && outcome.session) {
        set({ mergeSession: outcome.session, notice: 'Merge paused for explicit conflict resolution.' });
      } else {
        await refresh(currentProjectId);
        set({ notice: `Merge result: ${outcome.status}.` });
      }
    }),
    resolve: (conflictId, choice) => run(async () => {
      const { currentProjectId, mergeSession } = get();
      if (!currentProjectId || !mergeSession) return;
      set({ mergeSession: await window.snipsnap.resolveConflict(currentProjectId, mergeSession.id, { conflictId, choice }) });
    }),
    completeMerge: () => run(async () => {
      const { currentProjectId, mergeSession } = get();
      if (!currentProjectId || !mergeSession) return;
      const status = await window.snipsnap.completeMerge(currentProjectId, mergeSession.id);
      const selectedRevision = await window.snipsnap.revisionDetails(currentProjectId, status.headCommit);
      set({ status, selectedRevision, mergeSession: null, notice: 'Two-parent merge commit created.' });
    }),
    abortMerge: () => run(async () => {
      const { currentProjectId, mergeSession } = get();
      if (!currentProjectId || !mergeSession) return;
      await window.snipsnap.abortMerge(currentProjectId, mergeSession.id);
      set({ mergeSession: null, notice: 'Merge aborted; target branch was not changed.' });
    }),
    tag: (name) => run(async () => {
      const { currentProjectId, selectedRevision } = get();
      if (!currentProjectId || !selectedRevision) return;
      await window.snipsnap.tag(currentProjectId, name, selectedRevision.commit.id, `Approved cut ${name}`);
      set({ notice: `Tagged immutable commit ${selectedRevision.commit.id.slice(0, 8)} as ${name}.` });
    }),
    exportSelected: () => run(async () => {
      const { currentProjectId, selectedRevision } = get();
      if (!currentProjectId || !selectedRevision) return;
      const result = await window.snipsnap.exportOtio(currentProjectId, selectedRevision.commit.id);
      if (!result.canceled) set({ notice: `Exported immutable commit ${result.commitId?.slice(0, 10)}.` });
    }),
    relinkMedia: (fingerprint) => run(async () => {
      const { currentProjectId, selectedRevision } = get();
      if (!currentProjectId || !selectedRevision) return;
      const details = await window.snipsnap.relinkMedia(currentProjectId, fingerprint, selectedRevision.commit.id);
      if (details) set({ selectedRevision: details, notice: 'Media relinked for previews across project history.' });
    }),
    clearError: () => set({ error: null }),
  };
});

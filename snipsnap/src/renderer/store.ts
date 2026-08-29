import { create } from 'zustand';
import type { ProjectStatus, ProjectSummary, MergeSession } from '../application';
import type { EditCommand } from '../commands';
import type { SemanticHunk } from '../diff';
import type { ConflictChoice } from '../merge';

interface AppStore {
  projects: ProjectSummary[];
  currentProjectId: string | null;
  status: ProjectStatus | null;
  comparison: SemanticHunk[];
  mergeSession: MergeSession | null;
  busy: boolean;
  error: string | null;
  notice: string | null;
  initialize(): Promise<void>;
  selectProject(id: string): Promise<void>;
  createDemo(): Promise<void>;
  importOtio(): Promise<void>;
  edit(command: EditCommand): Promise<void>;
  stage(hunkId: string): Promise<void>;
  unstage(hunkId: string): Promise<void>;
  commit(message: string): Promise<void>;
  createBranch(name: string): Promise<void>;
  checkout(branch: string, discard: boolean): Promise<void>;
  compare(branch: string): Promise<void>;
  merge(source: string): Promise<void>;
  resolve(conflictId: string, choice: ConflictChoice): Promise<void>;
  completeMerge(): Promise<void>;
  abortMerge(): Promise<void>;
  tag(name: string): Promise<void>;
  exportOtio(): Promise<void>;
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

  async function refresh(projectId: string): Promise<void> {
    set({ status: await window.snipsnap.status(projectId), currentProjectId: projectId, comparison: [] });
  }

  return {
    projects: [], currentProjectId: null, status: null, comparison: [], mergeSession: null,
    busy: false, error: null, notice: null,
    initialize: () => run(async () => {
      const projects = await window.snipsnap.listProjects();
      set({ projects });
      if (projects[0]) await refresh(projects[0].id);
    }),
    selectProject: (id) => run(() => refresh(id)),
    createDemo: () => run(async () => {
      const project = await window.snipsnap.createDemo();
      set({ projects: [...get().projects, project] });
      await refresh(project.id);
      set({ notice: 'Demo repository created with a real initial Git commit.' });
    }),
    importOtio: () => run(async () => {
      const imported = await window.snipsnap.importOtio();
      if (!imported) return;
      set({ projects: [...get().projects, imported] });
      await refresh(imported.id);
      set({ notice: imported.unsupportedCount
        ? `Imported with ${imported.unsupportedCount} explicitly reported unsupported item(s).`
        : 'OTIO imported without unsupported items.' });
    }),
    edit: (command) => run(async () => {
      const { currentProjectId, status } = get();
      if (!currentProjectId || !status) return;
      set({ status: await window.snipsnap.edit(currentProjectId, command, status.workspaceVersion) });
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
      set({ status: await window.snipsnap.commit(currentProjectId, commitMessage, status.headCommit), notice: 'Staged timeline decisions committed.' });
    }),
    createBranch: (name) => run(async () => {
      const id = get().currentProjectId;
      if (!id) return;
      set({ status: await window.snipsnap.createBranch(id, name), notice: `Created branch ${name}.` });
    }),
    checkout: (branch, discard) => run(async () => {
      const id = get().currentProjectId;
      if (!id) return;
      set({ status: await window.snipsnap.checkout(id, branch, discard), comparison: [], notice: `Checked out ${branch}.` });
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
      set({ status: await window.snipsnap.completeMerge(currentProjectId, mergeSession.id), mergeSession: null, notice: 'Two-parent merge commit created.' });
    }),
    abortMerge: () => run(async () => {
      const { currentProjectId, mergeSession } = get();
      if (!currentProjectId || !mergeSession) return;
      await window.snipsnap.abortMerge(currentProjectId, mergeSession.id);
      set({ mergeSession: null, notice: 'Merge aborted; target branch was not changed.' });
    }),
    tag: (name) => run(async () => {
      const { currentProjectId, status } = get();
      if (!currentProjectId || !status) return;
      await window.snipsnap.tag(currentProjectId, name, status.headCommit, `Approved cut ${name}`);
      set({ notice: `Tagged immutable commit ${status.headCommit.slice(0, 8)} as ${name}.` });
    }),
    exportOtio: () => run(async () => {
      const { currentProjectId, status } = get();
      if (!currentProjectId || !status) return;
      const result = await window.snipsnap.exportOtio(currentProjectId, status.headCommit);
      if (!result.canceled) set({ notice: `Exported immutable commit ${result.commitId?.slice(0, 10)}.` });
    }),
    clearError: () => set({ error: null }),
  };
});

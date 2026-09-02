import { create } from 'zustand';
import type {
  CollaborationStatus,
  MergeSession,
  ProjectOverview,
  ProjectStatus,
  RevisionDetails,
  TimelineComparison,
  WorkspaceComparisonScope,
} from '../application';
import type { ConflictChoice } from '../merge';
import { errorMessage } from './error-message';

export type Route = { name: 'dashboard' } | { name: 'editor'; projectId: string };

interface AppStore {
  route: Route;
  overviews: ProjectOverview[];
  filter: string;
  currentProjectId: string | null;
  status: ProjectStatus | null;
  selectedRevision: RevisionDetails | null;
  comparison: TimelineComparison | null;
  diffOpen: boolean;
  mergeSession: MergeSession | null;
  busy: boolean;
  error: string | null;
  notice: string | null;
  collaboration: CollaborationStatus;
  initialize(): Promise<void>;
  listenForSourceChanges(): () => void;
  listenForCollaborationChanges(): () => void;
  setFilter(value: string): void;
  openProject(id: string): Promise<void>;
  goToDashboard(): Promise<void>;
  addResolveFolder(): Promise<void>;
  addResolveProjectFile(): Promise<void>;
  importKdenlive(): Promise<void>;
  addKdenliveFolder(): Promise<void>;
  exportFromResolve(): Promise<void>;
  refreshLibrary(): Promise<void>;
  connectSource(): Promise<void>;
  connectKdenliveSource(): Promise<void>;
  startResolveSync(): Promise<void>;
  stopResolveSync(): Promise<void>;
  scanSource(): Promise<void>;
  applySource(): Promise<void>;
  dismissSource(): Promise<void>;
  stage(hunkIds: string[]): Promise<void>;
  unstage(hunkIds: string[]): Promise<void>;
  commit(message: string): Promise<void>;
  loadRevision(revision: string, parentIndex?: number): Promise<void>;
  createBranchFromSelected(name: string): Promise<void>;
  checkout(branch: string, discard: boolean): Promise<void>;
  replaceLocalProjectWithSelected(): Promise<void>;
  openDiff(base: string, head: string): Promise<void>;
  openWorkspaceDiff(scope: WorkspaceComparisonScope): Promise<void>;
  closeDiff(): void;
  merge(source: string): Promise<void>;
  resolve(conflictId: string, choice: ConflictChoice): Promise<void>;
  completeMerge(): Promise<void>;
  abortMerge(): Promise<void>;
  tag(name: string): Promise<void>;
  exportRevision(revision: string): Promise<void>;
  openRevisionInKdenlive(revision: string): Promise<void>;
  relinkMedia(fingerprint: string): Promise<void>;
  startHosting(): Promise<void>;
  stopHosting(): Promise<void>;
  joinProject(inviteCode: string): Promise<void>;
  pullProject(): Promise<void>;
  pushProject(): Promise<void>;
  clearError(): void;
  clearNotice(): void;
}

export const useAppStore = create<AppStore>((set, get) => {
  async function run(operation: () => Promise<void>): Promise<void> {
    set({ busy: true, error: null, notice: null });
    try {
      await operation();
    } catch (error) {
      set({ error: errorMessage(error) });
    } finally {
      set({ busy: false });
    }
  }

  async function refresh(projectId: string, revision?: string): Promise<void> {
    const status = await window.snipsnap.status(projectId);
    const selectedRevision = await window.snipsnap.revisionDetails(projectId, revision ?? status.headCommit);
    set({ status, selectedRevision, currentProjectId: projectId });
  }

  /** Keep the open comparison aligned with whatever the repository now contains. */
  async function refreshComparison(projectId: string): Promise<void> {
    const { comparison, diffOpen } = get();
    if (!diffOpen || !comparison) return;
    if (comparison.kind === 'workspace') {
      set({ diffOpen: false, comparison: null });
      return;
    }
    try {
      set({
        comparison: await window.snipsnap.compareTimelines(
          projectId,
          comparison.base.commit.id,
          comparison.head.commit.id,
        ),
      });
    } catch {
      set({ diffOpen: false, comparison: null });
    }
  }

  return {
    route: { name: 'dashboard' },
    overviews: [],
    filter: '',
    currentProjectId: null,
    status: null,
    selectedRevision: null,
    comparison: null,
    diffOpen: false,
    mergeSession: null,
    busy: false,
    error: null,
    notice: null,
    collaboration: { mode: 'none', connected: false },

    initialize: () => run(async () => {
      const [overviews, collaboration] = await Promise.all([
        window.snipsnap.listOverviews(),
        window.snipsnap.collaborationStatus(),
      ]);
      set({ overviews, collaboration });
    }),

    listenForSourceChanges: () => window.snipsnap.onSourceChanged((projectId) => {
      if (get().currentProjectId !== projectId) {
        void run(async () => set({ overviews: await window.snipsnap.listOverviews() }));
        return;
      }
      void run(async () => {
        await refresh(projectId, get().selectedRevision?.commit.id);
        set({
          overviews: await window.snipsnap.listOverviews(),
          ...(get().comparison?.kind === 'workspace' ? { comparison: null, diffOpen: false } : {}),
          // The editor already presents source changes beside the timeline.
          // A second global toast obscures the workspace while editors save.
          notice: null,
        });
      });
    }),

    setFilter: (value) => set({ filter: value }),

    openProject: (id) => run(async () => {
      // Importing from Resolve happens here, so a project opens straight from
      // the dashboard whether or not SnipSnap has seen it before.
      const status = await window.snipsnap.openProject(id);
      const [selectedRevision, collaboration] = await Promise.all([
        window.snipsnap.revisionDetails(id, status.headCommit),
        window.snipsnap.collaborationStatus(id),
      ]);
      set({
        status,
        selectedRevision,
        collaboration,
        currentProjectId: id,
        route: { name: 'editor', projectId: id },
        diffOpen: false,
        comparison: null,
      });
    }),

    goToDashboard: () => run(async () => {
      set({ route: { name: 'dashboard' }, diffOpen: false, comparison: null });
      set({ overviews: await window.snipsnap.listOverviews() });
    }),

    addResolveFolder: () => run(async () => {
      const roots = await window.snipsnap.addResolveFolder();
      if (!roots) return;
      const overviews = await window.snipsnap.listOverviews();
      const resolveCount = overviews.filter(({ editor }) => editor === 'resolve').length;
      set({
        overviews,
        notice: resolveCount
          ? `Watching ${roots.length} folder${roots.length === 1 ? '' : 's'}. Found ${resolveCount} Resolve project${resolveCount === 1 ? '' : 's'}.`
          : 'No .drp file with a matching .otio export was found in that folder.',
      });
    }),

    addResolveProjectFile: () => run(async () => {
      const roots = await window.snipsnap.addResolveProjectFile();
      if (!roots) return;
      const overviews = await window.snipsnap.listOverviews();
      const resolveCount = overviews.filter(({ editor }) => editor === 'resolve').length;
      set({
        overviews,
        notice: resolveCount
          ? `Found ${resolveCount} Resolve project${resolveCount === 1 ? '' : 's'}.`
          : 'That project file has no .otio timeline export beside it yet.',
      });
    }),

    importKdenlive: () => run(async () => {
      const result = await window.snipsnap.importKdenliveOtio();
      if (!result) return;
      const projectId = result.status.project.id;
      const [selectedRevision, overviews, collaboration] = await Promise.all([
        window.snipsnap.revisionDetails(projectId, result.status.headCommit),
        window.snipsnap.listOverviews(),
        window.snipsnap.collaborationStatus(projectId),
      ]);
      const limitationCount = result.report.losses.reduce((count, loss) => count + loss.count, 0);
      set({
        status: result.status,
        selectedRevision,
        overviews,
        collaboration,
        currentProjectId: projectId,
        route: { name: 'editor', projectId },
        diffOpen: false,
        comparison: null,
        notice: limitationCount > 0
          ? `Connected Kdenlive. ${limitationCount} item${limitationCount === 1 ? '' : 's'} need fidelity review.`
          : 'Connected Kdenlive. Ctrl+S saves now update SnipSnap automatically.',
      });
    }),

    addKdenliveFolder: () => run(async () => {
      const result = await window.snipsnap.addKdenliveFolder();
      if (!result) return;
      const overviews = await window.snipsnap.listOverviews();
      const failed = result.failures.length;
      set({
        overviews,
        notice: result.discovered === 0
          ? 'No .kdenlive projects or .otio timelines were found in that folder.'
          : `Tracking ${result.tracked.length} Kdenlive project${result.tracked.length === 1 ? '' : 's'}`
            + `${failed ? `; ${failed} invalid file${failed === 1 ? '' : 's'} skipped` : ''}.`,
      });
    }),

    exportFromResolve: () => run(async () => {
      const result = await window.snipsnap.exportFromResolve();
      const overviews = await window.snipsnap.listOverviews();
      set({ overviews });
      // Installing the script into Resolve is guidance, not a failure.
      if (result.ok || result.installed) set({ notice: result.message });
      else set({ error: result.message });
    }),

    refreshLibrary: () => run(async () => {
      const kdenlive = await window.snipsnap.refreshKdenliveFolders();
      const overviews = await window.snipsnap.listOverviews();
      set({
        overviews,
        notice: kdenlive.failures.length
          ? `${overviews.length} video project${overviews.length === 1 ? '' : 's'} available; `
            + `${kdenlive.failures.length} invalid Kdenlive source${kdenlive.failures.length === 1 ? '' : 's'} skipped.`
          : overviews.length
            ? `${overviews.length} video project${overviews.length === 1 ? '' : 's'} available.`
          : 'No projects found. Connect a Resolve or Kdenlive project first.',
      });
    }),

    connectSource: () => run(async () => {
      const { currentProjectId, status } = get();
      if (!currentProjectId || !status) return;
      const result = await window.snipsnap.connectOtioSource(currentProjectId, status.workspaceVersion);
      if (!result) return;
      set({ status: result.status });
      if (result.error) set({ error: result.error });
      else set({ notice: result.changed ? 'Source connected. Review the detected changes.' : 'Source connected and up to date.' });
    }),

    connectKdenliveSource: () => run(async () => {
      const { currentProjectId, status } = get();
      if (!currentProjectId || !status) return;
      const result = await window.snipsnap.connectKdenliveSource(currentProjectId, status.workspaceVersion);
      if (!result) return;
      set({
        status: result.status,
        ...(get().comparison?.kind === 'workspace' ? { comparison: null, diffOpen: false } : {}),
      });
      if (result.error) set({ error: result.error });
      else set({
        notice: result.changed
          ? 'Kdenlive connected. Its current edits are ready to review.'
          : 'Kdenlive connected. Future Ctrl+S saves will update this project.',
      });
    }),

    startResolveSync: () => run(async () => {
      const { currentProjectId, status } = get();
      if (!currentProjectId || !status) return;
      set({
        status: await window.snipsnap.startResolveBridge(currentProjectId, status.workspaceVersion),
        notice: 'Resolve save sync started. Open Resolve, select the timeline, and save the project.',
      });
    }),

    listenForCollaborationChanges: () => window.snipsnap.onCollaborationChanged((projectId, collaboration) => {
      set({ collaboration });
      // Join, pull, and push refresh their peer state in the invoking action.
      // Only a host receives repository changes initiated by another window.
      if (get().currentProjectId !== projectId || collaboration.mode !== 'hosting') return;
      void window.snipsnap.status(projectId).then(async (latest) => {
        const known = get().status;
        const refs = (value: ProjectStatus) => value.branches.map(({ name, commitId }) => `${name}:${commitId}`).sort().join('|');
        if (!known || (latest.headCommit === known.headCommit && refs(latest) === refs(known))) return;
        const selectedRevision = await window.snipsnap.revisionDetails(
          projectId,
          get().selectedRevision?.commit.id ?? latest.headCommit,
        );
        set({
          status: latest,
          selectedRevision,
          overviews: await window.snipsnap.listOverviews(),
          ...(get().comparison?.kind === 'workspace' ? { comparison: null, diffOpen: false } : {}),
          notice: 'An editor pushed new commits. The project history is up to date.',
        });
      }).catch((error: unknown) => set({ error: errorMessage(error) }));
    }),

    stopResolveSync: () => run(async () => {
      const projectId = get().currentProjectId;
      if (!projectId) return;
      set({
        status: await window.snipsnap.stopResolveBridge(projectId),
        notice: 'Resolve save sync stopped. Your committed and working timeline data is unchanged.',
      });
    }),

    scanSource: () => run(async () => {
      const projectId = get().currentProjectId;
      if (!projectId) return;
      const result = await window.snipsnap.scanOtioSource(projectId);
      set({
        status: result.status,
        ...(result.changed && get().comparison?.kind === 'workspace' ? { comparison: null, diffOpen: false } : {}),
      });
      if (result.error) set({ error: result.error });
      else set({ notice: result.changed ? 'Timeline changes are ready for review.' : 'The export is already up to date.' });
    }),

    applySource: () => run(async () => {
      const { currentProjectId, status } = get();
      const pending = status?.source.pending;
      if (!currentProjectId || !status || !pending) return;
      set({
        status: await window.snipsnap.applyPendingSync(currentProjectId, pending.digest, status.workspaceVersion),
        ...(get().comparison?.kind === 'workspace' ? { comparison: null, diffOpen: false } : {}),
        notice: 'Changes applied to the working timeline. Stage what you want to commit.',
      });
    }),

    dismissSource: () => run(async () => {
      const { currentProjectId, status } = get();
      const pending = status?.source.pending;
      if (!currentProjectId || !pending) return;
      set({
        status: await window.snipsnap.dismissPendingSync(currentProjectId, pending.digest),
        notice: 'This export was ignored.',
      });
    }),

    stage: (hunkIds) => run(async () => {
      const { currentProjectId, status } = get();
      if (!currentProjectId || !status || hunkIds.length === 0) return;
      set({
        status: await window.snipsnap.stage(currentProjectId, hunkIds, status.indexDigest),
        ...(get().comparison?.kind === 'workspace' ? { comparison: null, diffOpen: false } : {}),
      });
    }),

    unstage: (hunkIds) => run(async () => {
      const { currentProjectId, status } = get();
      if (!currentProjectId || !status || hunkIds.length === 0) return;
      set({
        status: await window.snipsnap.unstage(currentProjectId, hunkIds, status.indexDigest),
        ...(get().comparison?.kind === 'workspace' ? { comparison: null, diffOpen: false } : {}),
      });
    }),

    commit: (commitMessage) => run(async () => {
      const { currentProjectId, status } = get();
      if (!currentProjectId || !status) return;
      if (status.staged.length === 0) throw new Error('Nothing is staged, so this commit would repeat the latest version');
      const next = await window.snipsnap.commit(
        currentProjectId,
        commitMessage,
        status.headCommit,
        status.indexDigest,
      );
      const selectedRevision = await window.snipsnap.revisionDetails(currentProjectId, next.headCommit);
      set({ status: next, selectedRevision, notice: `Committed ${next.headCommit.slice(0, 8)}.` });
      await refreshComparison(currentProjectId);
    }),

    loadRevision: (revision, parentIndex = 0) => run(async () => {
      const projectId = get().currentProjectId;
      if (!projectId) return;
      set({
        selectedRevision: await window.snipsnap.revisionDetails(projectId, revision, parentIndex),
        comparison: null,
        diffOpen: false,
      });
    }),

    createBranchFromSelected: (name) => run(async () => {
      const { currentProjectId, selectedRevision } = get();
      if (!currentProjectId || !selectedRevision) return;
      const status = await window.snipsnap.createBranchFromRevision(currentProjectId, name, selectedRevision.commit.id);
      const details = await window.snipsnap.revisionDetails(currentProjectId, status.headCommit);
      set({
        status,
        selectedRevision: details,
        comparison: null,
        diffOpen: false,
        notice: `Created and switched to ${name} at ${details.commit.id.slice(0, 8)}.`,
      });
    }),

    checkout: (branch, discard) => run(async () => {
      const projectId = get().currentProjectId;
      if (!projectId) return;
      const status = await window.snipsnap.checkout(projectId, branch, discard);
      const selectedRevision = await window.snipsnap.revisionDetails(projectId, status.headCommit);
      set({ status, selectedRevision, notice: `Switched to ${branch}.` });
      await refreshComparison(projectId);
    }),

    replaceLocalProjectWithSelected: () => run(async () => {
      const { currentProjectId, status, selectedRevision } = get();
      if (!currentProjectId || !status || !selectedRevision) return;
      set({
        status: await window.snipsnap.restoreRevision(
          currentProjectId,
          selectedRevision.commit.id,
          status.workspaceVersion,
          true,
        ),
        ...(get().comparison?.kind === 'workspace' ? { comparison: null, diffOpen: false } : {}),
        notice: `Replaced the local project with commit ${selectedRevision.commit.id.slice(0, 8)}. Git history and local media were preserved.`,
      });
    }),

    openDiff: (base, head) => run(async () => {
      const projectId = get().currentProjectId;
      if (!projectId) return;
      set({
        comparison: await window.snipsnap.compareTimelines(projectId, base, head),
        diffOpen: true,
      });
    }),

    openWorkspaceDiff: (scope) => run(async () => {
      const { currentProjectId, status } = get();
      if (!currentProjectId || !status) return;
      set({
        comparison: await window.snipsnap.compareWorkspaceTimelines(
          currentProjectId,
          scope,
          status.headCommit,
          status.indexDigest,
          status.workspaceVersion,
        ),
        diffOpen: true,
      });
    }),

    closeDiff: () => set({ diffOpen: false }),

    merge: (source) => run(async () => {
      const { currentProjectId, status } = get();
      if (!currentProjectId || !status) return;
      const outcome = await window.snipsnap.merge(currentProjectId, status.branch, source);
      if (outcome.status === 'conflicts' && outcome.session) {
        set({ mergeSession: outcome.session, notice: 'Merge paused so you can resolve every conflict.' });
        return;
      }
      await refresh(currentProjectId);
      const explanation = {
        upToDate: `${status.branch} already contains ${source}.`,
        fastForwarded: `${status.branch} fast-forwarded to ${source}.`,
        merged: `Merged ${source} into ${status.branch} with a two-parent commit.`,
        conflicts: 'Merge paused.',
      };
      set({ notice: explanation[outcome.status] });
      await refreshComparison(currentProjectId);
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
      await refreshComparison(currentProjectId);
    }),

    abortMerge: () => run(async () => {
      const { currentProjectId, mergeSession } = get();
      if (!currentProjectId || !mergeSession) return;
      await window.snipsnap.abortMerge(currentProjectId, mergeSession.id);
      set({ mergeSession: null, notice: 'Merge aborted. The branch was not moved.' });
    }),

    tag: (name) => run(async () => {
      const { currentProjectId, selectedRevision } = get();
      if (!currentProjectId || !selectedRevision) return;
      await window.snipsnap.tag(currentProjectId, name, selectedRevision.commit.id, `Approved cut ${name}`);
      set({ notice: `Tagged ${selectedRevision.commit.id.slice(0, 8)} as ${name}.` });
    }),

    exportRevision: (revision) => run(async () => {
      const projectId = get().currentProjectId;
      if (!projectId) return;
      const result = await window.snipsnap.exportOtio(projectId, revision);
      if (!result.canceled) set({ notice: `Exported commit ${result.commitId?.slice(0, 10)}.` });
    }),

    openRevisionInKdenlive: (revision) => run(async () => {
      const projectId = get().currentProjectId;
      if (!projectId) return;
      const handoff = await window.snipsnap.openInKdenlive(projectId, revision);
      const limitationCount = handoff.report.losses.reduce((count, loss) => count + loss.count, 0);
      set({
        notice: limitationCount > 0
          ? `Prepared ${handoff.commitId.slice(0, 10)} with ${limitationCount} fidelity warning${limitationCount === 1 ? '' : 's'}. In Kdenlive choose File > OpenTimelineIO Import; the OTIO path is copied.`
          : `Prepared ${handoff.commitId.slice(0, 10)}. In Kdenlive choose File > OpenTimelineIO Import; the OTIO path is copied.`,
      });
    }),

    relinkMedia: (fingerprint) => run(async () => {
      const { currentProjectId, selectedRevision } = get();
      if (!currentProjectId || !selectedRevision) return;
      const details = await window.snipsnap.relinkMedia(currentProjectId, fingerprint, selectedRevision.commit.id);
      if (!details) return;
      set({ selectedRevision: details, notice: 'Media relinked across the whole project history.' });
      await refreshComparison(currentProjectId);
    }),

    startHosting: () => run(async () => {
      const projectId = get().currentProjectId;
      if (!projectId) return;
      const collaboration = await window.snipsnap.collaborationStartHost(projectId);
      set({ collaboration, notice: 'WebRTC sharing is ready. Send the pairing code to every editor on this project.' });
    }),

    stopHosting: () => run(async () => {
      await window.snipsnap.collaborationStopHost();
      set({
        collaboration: { mode: 'none', connected: false },
        notice: 'Stopped hosting the project.',
      });
    }),

    joinProject: (inviteCode) => run(async () => {
      const result = await window.snipsnap.collaborationJoin(inviteCode.trim());
      const projectId = result.status.project.id;
      const [selectedRevision, overviews, collaboration] = await Promise.all([
        window.snipsnap.revisionDetails(projectId, result.status.headCommit),
        window.snipsnap.listOverviews(),
        window.snipsnap.collaborationStatus(projectId),
      ]);
      set({
        status: result.status,
        selectedRevision,
        overviews,
        collaboration,
        currentProjectId: projectId,
        route: { name: 'editor', projectId },
        diffOpen: false,
        comparison: null,
        notice: `Joined ${collaboration.peerName ?? 'shared project'} over WebRTC with ${result.media.completedFiles} local media file${result.media.completedFiles === 1 ? '' : 's'} ready.`,
      });
    }),

    pullProject: () => run(async () => {
      const projectId = get().currentProjectId;
      if (!projectId) return;
      const result = await window.snipsnap.collaborationPull(projectId);
      const [selectedRevision, collaboration] = await Promise.all([
        window.snipsnap.revisionDetails(projectId, result.status.headCommit),
        window.snipsnap.collaborationStatus(projectId),
      ]);
      const updatedBranches = (result.pull?.fastForwarded.length ?? 0) + (result.pull?.added.length ?? 0);
      set({
        status: result.status,
        selectedRevision,
        collaboration,
        overviews: await window.snipsnap.listOverviews(),
        notice: `Pulled the latest project: ${updatedBranches} updated branch${updatedBranches === 1 ? '' : 'es'} and ${result.media.completedFiles} verified local media file${result.media.completedFiles === 1 ? '' : 's'}.`,
      });
      await refreshComparison(projectId);
    }),

    pushProject: () => run(async () => {
      const projectId = get().currentProjectId;
      if (!projectId) return;
      const result = await window.snipsnap.collaborationPush(projectId);
      const collaboration = await window.snipsnap.collaborationStatus(projectId);
      set({
        status: result.status,
        collaboration,
        notice: `Pushed ${result.status.branch} to ${collaboration.peerName ?? 'the host'}.`,
      });
    }),

    clearError: () => set({ error: null }),
    clearNotice: () => set({ notice: null }),
  };
});

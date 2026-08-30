import { create } from 'zustand';
import type {
  CollaborationStatus,
  MergeSession,
  ProjectOverview,
  ProjectStatus,
  RevisionDetails,
  TimelineComparison,
} from '../application';
import type { ConflictChoice } from '../merge';

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
  exportFromResolve(): Promise<void>;
  refreshLibrary(): Promise<void>;
  connectSource(): Promise<void>;
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
  restoreSelected(discard: boolean): Promise<void>;
  openDiff(base: string, head: string): Promise<void>;
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

function message(error: unknown): string {
  return error instanceof Error
    ? error.message.replace(/^Error invoking remote method '[^']+': Error: /u, '')
    : String(error);
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
    set({ status, selectedRevision, currentProjectId: projectId });
  }

  /** Keep the open comparison aligned with whatever the repository now contains. */
  async function refreshComparison(projectId: string): Promise<void> {
    const { comparison, diffOpen } = get();
    if (!diffOpen || !comparison) return;
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
          ? `Imported Kdenlive OTIO. ${limitationCount} item${limitationCount === 1 ? '' : 's'} need fidelity review.`
          : 'Imported Kdenlive OTIO with no known portability warnings.',
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
      const overviews = await window.snipsnap.listOverviews();
      set({
        overviews,
        notice: overviews.length
          ? `${overviews.length} video project${overviews.length === 1 ? '' : 's'} available.`
          : 'No projects found. Export OTIO from Resolve or Kdenlive first.',
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
      void run(async () => {
        await refresh(projectId, get().selectedRevision?.commit.id);
        set({
          overviews: await window.snipsnap.listOverviews(),
          notice: 'A peer pushed new commits. The project history is up to date.',
        });
      });
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
      set({ status: result.status });
      if (result.error) set({ error: result.error });
      else set({ notice: result.changed ? 'Timeline changes are ready for review.' : 'The export is already up to date.' });
    }),

    applySource: () => run(async () => {
      const { currentProjectId, status } = get();
      const pending = status?.source.pending;
      if (!currentProjectId || !status || !pending) return;
      set({
        status: await window.snipsnap.applyPendingSync(currentProjectId, pending.digest, status.workspaceVersion),
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
      set({ status: await window.snipsnap.stage(currentProjectId, hunkIds, status.indexDigest) });
    }),

    unstage: (hunkIds) => run(async () => {
      const { currentProjectId, status } = get();
      if (!currentProjectId || !status || hunkIds.length === 0) return;
      set({ status: await window.snipsnap.unstage(currentProjectId, hunkIds, status.indexDigest) });
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
      set({ status, selectedRevision: details, notice: `Created and switched to ${name} at ${details.commit.id.slice(0, 8)}.` });
    }),

    checkout: (branch, discard) => run(async () => {
      const projectId = get().currentProjectId;
      if (!projectId) return;
      const status = await window.snipsnap.checkout(projectId, branch, discard);
      const selectedRevision = await window.snipsnap.revisionDetails(projectId, status.headCommit);
      set({ status, selectedRevision, notice: `Switched to ${branch}.` });
      await refreshComparison(projectId);
    }),

    restoreSelected: (discard) => run(async () => {
      const { currentProjectId, status, selectedRevision } = get();
      if (!currentProjectId || !status || !selectedRevision) return;
      set({
        status: await window.snipsnap.restoreRevision(
          currentProjectId,
          selectedRevision.commit.id,
          status.workspaceVersion,
          discard,
        ),
        notice: `Restored ${selectedRevision.commit.id.slice(0, 8)} into the working timeline.`,
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
      set({ collaboration, notice: 'Hosting on your local network. Send the pairing code to your collaborator.' });
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
        notice: `Joined ${collaboration.peerName ?? 'shared project'} with ${result.media.completedFiles} media file${result.media.completedFiles === 1 ? '' : 's'} ready.`,
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
        notice: `Pulled ${updatedBranches} updated branch${updatedBranches === 1 ? '' : 'es'} and verified ${result.media.completedFiles} media file${result.media.completedFiles === 1 ? '' : 's'}.`,
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

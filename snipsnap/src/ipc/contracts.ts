import type {
  CollaborationStatus,
  CollaborationSyncResult,
  MergeOutcome,
  MergeSession,
  ProjectOverview,
  ProjectStatus,
  ProjectSummary,
  RevisionDetails,
  SourceScanResult,
  TimelineComparison,
} from '../application';
import type { SemanticHunk } from '../diff';
import type { ConflictResolution } from '../merge';

export const channels = {
  listProjects: 'projects:list',
  listOverviews: 'projects:overviews',
  openProject: 'projects:open',
  addResolveFolder: 'resolve:add-folder',
  addResolveProjectFile: 'resolve:add-project-file',
  exportFromResolve: 'resolve:export',
  resolveRoots: 'resolve:roots',
  status: 'projects:status',
  connectOtioSource: 'source:connect-otio',
  startResolveBridge: 'source:start-resolve-bridge',
  stopResolveBridge: 'source:stop-resolve-bridge',
  scanOtioSource: 'source:scan-otio',
  applyPendingSync: 'source:apply',
  dismissPendingSync: 'source:dismiss',
  sourceChanged: 'source:changed',
  stage: 'projects:stage',
  unstage: 'projects:unstage',
  commit: 'projects:commit',
  createBranch: 'projects:create-branch',
  createBranchFromRevision: 'projects:create-branch-from-revision',
  checkout: 'projects:checkout',
  restoreRevision: 'projects:restore-revision',
  revisionDetails: 'projects:revision-details',
  compare: 'projects:compare',
  compareTimelines: 'projects:compare-timelines',
  merge: 'projects:merge',
  resolveConflict: 'projects:resolve-conflict',
  completeMerge: 'projects:complete-merge',
  abortMerge: 'projects:abort-merge',
  tag: 'projects:tag',
  exportOtio: 'projects:export-otio',
  relinkMedia: 'media:relink',
  collaborationStartHost: 'collaboration:start-host',
  collaborationStopHost: 'collaboration:stop-host',
  collaborationJoin: 'collaboration:join',
  collaborationPull: 'collaboration:pull',
  collaborationPush: 'collaboration:push',
  collaborationStatus: 'collaboration:status',
  collaborationChanged: 'collaboration:changed',
} as const;

export interface SnipSnapApi {
  listProjects(): Promise<ProjectSummary[]>;
  listOverviews(): Promise<ProjectOverview[]>;
  openProject(projectId: string): Promise<ProjectStatus>;
  addResolveFolder(): Promise<string[] | null>;
  addResolveProjectFile(): Promise<string[] | null>;
  exportFromResolve(): Promise<{ ok: boolean; installed?: boolean; message: string }>;
  resolveRoots(): Promise<string[]>;
  status(projectId: string): Promise<ProjectStatus>;
  connectOtioSource(projectId: string, expectedVersion: number): Promise<SourceScanResult | null>;
  startResolveBridge(projectId: string, expectedVersion: number): Promise<ProjectStatus>;
  stopResolveBridge(projectId: string): Promise<ProjectStatus>;
  scanOtioSource(projectId: string): Promise<SourceScanResult>;
  applyPendingSync(projectId: string, digest: string, expectedVersion: number): Promise<ProjectStatus>;
  dismissPendingSync(projectId: string, digest: string): Promise<ProjectStatus>;
  onSourceChanged(listener: (projectId: string) => void): () => void;
  stage(projectId: string, hunkIds: string[], expectedIndexDigest: string): Promise<ProjectStatus>;
  unstage(projectId: string, hunkIds: string[], expectedIndexDigest: string): Promise<ProjectStatus>;
  commit(projectId: string, message: string, expectedHead: string): Promise<ProjectStatus>;
  createBranch(projectId: string, name: string): Promise<ProjectStatus>;
  createBranchFromRevision(projectId: string, name: string, revision: string): Promise<ProjectStatus>;
  checkout(projectId: string, branch: string, discardChanges: boolean): Promise<ProjectStatus>;
  restoreRevision(projectId: string, revision: string, expectedVersion: number, discardChanges: boolean): Promise<ProjectStatus>;
  revisionDetails(projectId: string, revision: string, parentIndex?: number): Promise<RevisionDetails>;
  compare(projectId: string, base: string, head: string): Promise<SemanticHunk[]>;
  compareTimelines(projectId: string, base: string, head: string): Promise<TimelineComparison>;
  merge(projectId: string, target: string, source: string): Promise<MergeOutcome>;
  resolveConflict(projectId: string, sessionId: string, resolution: ConflictResolution): Promise<MergeSession>;
  completeMerge(projectId: string, sessionId: string): Promise<ProjectStatus>;
  abortMerge(projectId: string, sessionId: string): Promise<void>;
  tag(projectId: string, name: string, revision: string, message: string): Promise<void>;
  exportOtio(projectId: string, revision: string): Promise<{ canceled: boolean; commitId?: string }>;
  relinkMedia(projectId: string, fingerprint: string, revision: string): Promise<RevisionDetails | null>;
  collaborationStartHost(projectId: string): Promise<CollaborationStatus>;
  collaborationStopHost(): Promise<void>;
  collaborationJoin(inviteCode: string): Promise<CollaborationSyncResult>;
  collaborationPull(projectId: string): Promise<CollaborationSyncResult>;
  collaborationPush(projectId: string): Promise<CollaborationSyncResult>;
  collaborationStatus(projectId?: string): Promise<CollaborationStatus>;
  onCollaborationChanged(listener: (projectId: string, status: CollaborationStatus) => void): () => void;
}

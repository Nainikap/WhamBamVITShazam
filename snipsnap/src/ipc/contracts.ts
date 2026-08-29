import type {
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
  resolveRoots: 'resolve:roots',
  status: 'projects:status',
  connectOtioSource: 'source:connect-otio',
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
} as const;

export interface SnipSnapApi {
  listProjects(): Promise<ProjectSummary[]>;
  listOverviews(): Promise<ProjectOverview[]>;
  openProject(projectId: string): Promise<ProjectStatus>;
  addResolveFolder(): Promise<string[] | null>;
  resolveRoots(): Promise<string[]>;
  status(projectId: string): Promise<ProjectStatus>;
  connectOtioSource(projectId: string, expectedVersion: number): Promise<SourceScanResult | null>;
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
}

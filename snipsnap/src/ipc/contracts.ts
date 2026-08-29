import type { ProjectStatus, ProjectSummary, MergeOutcome, MergeSession } from '../application';
import type { EditCommand } from '../commands';
import type { SemanticHunk } from '../diff';
import type { ConflictResolution } from '../merge';

export const channels = {
  listProjects: 'projects:list',
  createDemo: 'projects:create-demo',
  importOtio: 'projects:import-otio',
  status: 'projects:status',
  edit: 'projects:edit',
  stage: 'projects:stage',
  unstage: 'projects:unstage',
  commit: 'projects:commit',
  createBranch: 'projects:create-branch',
  checkout: 'projects:checkout',
  compare: 'projects:compare',
  merge: 'projects:merge',
  resolveConflict: 'projects:resolve-conflict',
  completeMerge: 'projects:complete-merge',
  abortMerge: 'projects:abort-merge',
  tag: 'projects:tag',
  exportOtio: 'projects:export-otio',
} as const;

export interface SnipSnapApi {
  listProjects(): Promise<ProjectSummary[]>;
  createDemo(): Promise<ProjectSummary>;
  importOtio(): Promise<(ProjectSummary & { unsupportedCount: number }) | null>;
  status(projectId: string): Promise<ProjectStatus>;
  edit(projectId: string, command: EditCommand, expectedVersion: number): Promise<ProjectStatus>;
  stage(projectId: string, hunkIds: string[], expectedIndexDigest: string): Promise<ProjectStatus>;
  unstage(projectId: string, hunkIds: string[], expectedIndexDigest: string): Promise<ProjectStatus>;
  commit(projectId: string, message: string, expectedHead: string): Promise<ProjectStatus>;
  createBranch(projectId: string, name: string): Promise<ProjectStatus>;
  checkout(projectId: string, branch: string, discardChanges: boolean): Promise<ProjectStatus>;
  compare(projectId: string, base: string, head: string): Promise<SemanticHunk[]>;
  merge(projectId: string, target: string, source: string): Promise<MergeOutcome>;
  resolveConflict(projectId: string, sessionId: string, resolution: ConflictResolution): Promise<MergeSession>;
  completeMerge(projectId: string, sessionId: string): Promise<ProjectStatus>;
  abortMerge(projectId: string, sessionId: string): Promise<void>;
  tag(projectId: string, name: string, revision: string, message: string): Promise<void>;
  exportOtio(projectId: string, revision: string): Promise<{ canceled: boolean; commitId?: string }>;
}

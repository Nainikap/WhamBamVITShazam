import { randomUUID } from 'node:crypto';
import { access, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { exportOtio, importOtio, type UnsupportedContent } from '../adapters/otio';
import { reduceCommand, type EditCommand } from '../commands';
import { applySemanticHunks, semanticDiff, type SemanticHunk } from '../diff';
import { digestText, projectDigest, ProjectSchema, type Project } from '../domain';
import { GitRepository, KeyedMutex, type CommitInfo } from '../git';
import {
  completeMerge,
  mergeThreeWay,
  resolveMerge,
  type ConflictResolution,
  type MergeResult,
} from '../merge';
import {
  buildPreviewPlan,
  buildTimelineDiff,
  type PreviewPlan,
  type PreviewMediaAvailability,
  type TimelineDiff,
} from '../preview';
import { writeTimelineExports } from './resolve-database';
import {
  ResolveLibrary,
  defaultResolveRoots,
  generatedExportFolder,
  type ResolveProjectRef,
} from './resolve-library';
import { atomicWriteJson, readJson } from './storage';
import {
  PendingSyncSchema,
  SourceBindingSchema,
  pendingSync,
  reconcileImportedProject,
  type PendingSync,
  type SourceBinding,
} from './source-sync';

const WorkspaceSchema = z.object({
  version: z.number().int().nonnegative(),
  working: ProjectSchema,
}).strict();

const CommitIdSchema = z.string().regex(/^[a-f0-9]{40,64}$/u);
const MergeRelationSchema = z.object({
  parentId: z.string().uuid(),
  index: z.number().int().safe().nonnegative(),
}).strict();
const MergeConflictSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/u),
  type: z.enum(['same-field', 'delete-modify', 'order', 'validation']),
  entityType: z.enum(['project', 'sequence', 'track', 'asset', 'clip', 'gap', 'transition', 'caption']),
  entityId: z.string().uuid(),
  fieldGroup: z.string().min(1),
  base: z.unknown(),
  ours: z.unknown(),
  theirs: z.unknown(),
  message: z.string().min(1),
  validationErrors: z.array(z.string()).optional(),
  relation: z.object({
    base: MergeRelationSchema.optional(),
    ours: MergeRelationSchema.optional(),
    theirs: MergeRelationSchema.optional(),
  }).strict().optional(),
}).strict();
const MergeResultSchema = z.object({
  provisional: ProjectSchema,
  conflicts: z.array(MergeConflictSchema),
  alternatives: z.object({
    base: ProjectSchema,
    ours: ProjectSchema,
    theirs: ProjectSchema,
  }).strict(),
}).strict();
const MergeSessionSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  targetBranch: z.string().min(1),
  sourceBranch: z.string().min(1),
  baseCommit: CommitIdSchema,
  targetCommit: CommitIdSchema,
  sourceCommit: CommitIdSchema,
  result: MergeResultSchema,
}).strict();

interface Workspace {
  version: number;
  working: Project;
}

export interface MergeSession {
  id: string;
  projectId: string;
  targetBranch: string;
  sourceBranch: string;
  baseCommit: string;
  targetCommit: string;
  sourceCommit: string;
  result: MergeResult;
}

export interface ProjectSummary {
  id: string;
  name: string;
}

/** Where a project came from in DaVinci Resolve. */
export interface ResolveBinding {
  projectName: string;
  drpPath: string;
  otioPath: string;
  timelineName: string;
  timelineCount: number;
  folder: string;
}

const ResolveBindingSchema = z.object({
  projectName: z.string().min(1),
  // Resolve's own database projects do not have a standalone .drp file.
  drpPath: z.string(),
  otioPath: z.string().min(1),
  timelineName: z.string().min(1),
  timelineCount: z.number().int().nonnegative(),
  folder: z.string().min(1),
}).strict();

const ProjectMetadataSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  resolve: ResolveBindingSchema.optional(),
}).strict();

/** Everything the dashboard shows about a video project without opening it. */
export interface ProjectOverview {
  id: string;
  name: string;
  path: string;
  /** Resolve files exist; false until SnipSnap has imported them once. */
  linked: boolean;
  /** False when the project has no timeline export to read yet. */
  openable: boolean;
  kind: 'export' | 'database';
  /** Timeline names Resolve knows about, listed even before any export. */
  knownTimelines: string[];
  resolve: ResolveBinding;
  branch: string;
  headCommit: string;
  headMessage: string;
  headAuthoredAt: string;
  updatedAt: string;
  commitCount: number;
  branchCount: number;
  state: 'clean' | 'staged' | 'uncommitted' | 'resolve-pending';
  changeCount: number;
  fps: number;
  width: number;
  height: number;
  durationFrames: number;
  trackCounts: { video: number; audio: number; caption: number };
  clipCount: number;
  sourceFileName: string | null;
  sourceState: SourceSyncStatus['state'];
  poster: { mediaUrl: string; sourceStart: number; fps: number } | null;
  missingMedia: number;
}

/** Two committed timelines side by side, with the lane-level differences between them. */
export interface TimelineComparison {
  base: { commit: CommitInfo; plan: PreviewPlan };
  head: { commit: CommitInfo; plan: PreviewPlan };
  diff: TimelineDiff;
  hunks: SemanticHunk[];
}

export interface SourceSyncStatus {
  connected: boolean;
  mode?: 'file' | 'resolve';
  fileName?: string;
  filePath?: string;
  state: 'not-connected' | 'starting' | 'waiting-for-resolve' | 'watching' | 'changes-ready' | 'stopped' | 'missing' | 'invalid';
  lastAppliedDigest?: string;
  lastMarker?: string;
  lastSavedAt?: string;
  resolveProjectName?: string;
  resolveTimelineName?: string;
  error?: string;
  pending?: {
    digest: string;
    detectedAt: string;
    changeCount: number;
    unsupportedCount: number;
    changes: SemanticHunk[];
  };
}

export interface SourceScanResult {
  changed: boolean;
  status: ProjectStatus;
  error?: string;
}

export interface RevisionDetails {
  commit: CommitInfo;
  pointedToBy: string[];
  diff: SemanticHunk[];
  comparedParent?: string;
  preview: PreviewPlan;
}

export interface ProjectStatus {
  project: Project;
  /** Where this project's repository and workspace live on disk. */
  path: string;
  /** The Resolve project this timeline came from, when it came from one. */
  resolve?: ResolveBinding;
  workspaceVersion: number;
  branch: string;
  headCommit: string;
  indexDigest: string;
  staged: SemanticHunk[];
  unstaged: SemanticHunk[];
  /** Cumulative semantic changes from immutable HEAD to the latest Resolve save. */
  workingChanges: SemanticHunk[];
  branches: Array<{ name: string; commitId: string }>;
  history: CommitInfo[];
  source: SourceSyncStatus;
}

export interface MergeOutcome {
  status: 'upToDate' | 'fastForwarded' | 'merged' | 'conflicts';
  commitId?: string;
  session?: MergeSession;
}

export class DirtyWorkspaceError extends Error {
  constructor() {
    super('This action would discard a pending Resolve update or staged/working changes');
    this.name = 'DirtyWorkspaceError';
  }
}

export class StaleWorkspaceError extends Error {
  constructor() {
    super('Workspace changed; reload and retry');
    this.name = 'StaleWorkspaceError';
  }
}

export class ProjectService {
  private readonly mutex = new KeyedMutex();

  readonly library: ResolveLibrary;

  constructor(readonly root: string, library?: ResolveLibrary) {
    this.library = library ?? new ResolveLibrary(() => this.resolveRoots());
  }

  private projectRoot(projectId: string): string {
    if (!z.string().uuid().safeParse(projectId).success) throw new Error('Invalid project ID');
    return path.join(this.root, 'projects', projectId);
  }

  private repository(projectId: string): GitRepository {
    return new GitRepository(path.join(this.projectRoot(projectId), 'repo'));
  }

  private workspacePath(projectId: string): string {
    return path.join(this.projectRoot(projectId), 'workspace.json');
  }

  private metadataPath(projectId: string): string {
    return path.join(this.projectRoot(projectId), 'project.json');
  }

  private mediaLinksPath(projectId: string): string {
    return path.join(this.projectRoot(projectId), 'media-links.json');
  }

  private sourceBindingPath(projectId: string): string {
    return path.join(this.projectRoot(projectId), 'source-binding.json');
  }

  private pendingSyncPath(projectId: string): string {
    return path.join(this.projectRoot(projectId), 'pending-sync.json');
  }

  private resolveBridgeStatePath(projectId: string): string {
    return path.join(this.projectRoot(projectId), 'resolve-bridge-state.json');
  }

  resolveBridgeSnapshotPath(projectId: string): string {
    return path.join(this.projectRoot(projectId), 'resolve-bridge', 'latest.otio');
  }

  private sessionPath(projectId: string, sessionId: string): string {
    if (!z.string().uuid().safeParse(sessionId).success) throw new Error('Invalid merge session ID');
    return path.join(this.projectRoot(projectId), 'merge-sessions', `${sessionId}.json`);
  }

  private async readWorkspace(projectId: string): Promise<Workspace> {
    return WorkspaceSchema.parse(await readJson(this.workspacePath(projectId)));
  }

  private async writeWorkspace(projectId: string, workspace: Workspace): Promise<void> {
    await atomicWriteJson(this.workspacePath(projectId), WorkspaceSchema.parse(workspace));
  }

  private async readOptionalJson(filePath: string): Promise<unknown | undefined> {
    try {
      return await readJson(filePath);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
      throw error;
    }
  }

  private async readMediaLinks(projectId: string): Promise<Record<string, string>> {
    const value = await this.readOptionalJson(this.mediaLinksPath(projectId));
    return value === undefined ? {} : z.record(z.string()).parse(value);
  }

  private async writeMediaLinks(projectId: string, links: Record<string, string>): Promise<void> {
    await atomicWriteJson(this.mediaLinksPath(projectId), z.record(z.string()).parse(links));
  }

  async sourceBinding(projectId: string): Promise<SourceBinding | null> {
    const value = await this.readOptionalJson(this.sourceBindingPath(projectId));
    return value === undefined ? null : SourceBindingSchema.parse(value);
  }

  private async readPendingSync(projectId: string): Promise<PendingSync | null> {
    const value = await this.readOptionalJson(this.pendingSyncPath(projectId));
    if (value === undefined) return null;
    const parsed = PendingSyncSchema.parse(value);
    return { ...parsed, project: ProjectSchema.parse(parsed.project) };
  }

  private async sourceStatus(projectId: string, workspace: Workspace): Promise<SourceSyncStatus> {
    const binding = await this.sourceBinding(projectId);
    if (!binding) return { connected: false, state: 'not-connected' };
    if (binding.mode === 'resolve') {
      const runtime = z.object({
        state: z.enum(['starting', 'waiting-for-resolve', 'watching', 'stopped', 'invalid']),
        error: z.string().min(1).max(2000).optional(),
      }).strict().safeParse(await this.readOptionalJson(this.resolveBridgeStatePath(projectId)));
      const status: SourceSyncStatus = {
        connected: true,
        mode: 'resolve',
        fileName: binding.resolveTimelineName ?? 'Active Resolve timeline',
        filePath: binding.path,
        state: runtime.success ? runtime.data.state : 'stopped',
      };
      if (binding.lastAppliedDigest) status.lastAppliedDigest = binding.lastAppliedDigest;
      if (binding.lastMarker) status.lastMarker = binding.lastMarker;
      if (binding.lastSavedAt) status.lastSavedAt = binding.lastSavedAt;
      if (binding.resolveProjectName) status.resolveProjectName = binding.resolveProjectName;
      if (binding.resolveTimelineName) status.resolveTimelineName = binding.resolveTimelineName;
      const error = runtime.success ? runtime.data.error : binding.lastError;
      if (error) status.error = error;
      return status;
    }
    const pending = await this.readPendingSync(projectId);
    let exists = true;
    try {
      await access(binding.path);
    } catch {
      exists = false;
    }
    const status: SourceSyncStatus = {
      connected: true,
      mode: 'file',
      fileName: path.basename(binding.path),
      filePath: binding.path,
      state: exists ? (binding.lastError ? 'invalid' : pending ? 'changes-ready' : 'watching') : 'missing',
    };
    if (binding.lastAppliedDigest) status.lastAppliedDigest = binding.lastAppliedDigest;
    if (binding.lastError) status.error = binding.lastError;
    if (pending) {
      const changes = semanticDiff(workspace.working, pending.project);
      status.pending = {
        digest: pending.digest,
        detectedAt: pending.detectedAt,
        changeCount: changes.length,
        unsupportedCount: pending.unsupported.length,
        changes,
      };
    }
    return status;
  }

  async listProjects(): Promise<ProjectSummary[]> {
    const projectsRoot = path.join(this.root, 'projects');
    await mkdir(projectsRoot, { recursive: true });
    const entries = await readdir(projectsRoot, { withFileTypes: true });
    const results: ProjectSummary[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !z.string().uuid().safeParse(entry.name).success) continue;
      const metadata = ProjectMetadataSchema.parse(await readJson(this.metadataPath(entry.name)));
      results.push({ id: metadata.id, name: metadata.name });
    }
    return results.sort((left, right) => left.name.localeCompare(right.name));
  }

  async createProject(
    project: Project,
    initialMessage = 'Import timeline',
    resolve?: ResolveBinding,
  ): Promise<ProjectSummary> {
    const parsed = ProjectSchema.parse(project);
    return this.mutex.run(parsed.id, async () => {
      const projectRoot = this.projectRoot(parsed.id);
      try {
        await readFile(this.metadataPath(parsed.id), 'utf8');
        throw new Error(`Project ${parsed.id} already exists`);
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          // Expected for a new project.
        } else if (error instanceof Error && error.message.includes('already exists')) {
          throw error;
        } else {
          throw error;
        }
      }
      await mkdir(projectRoot, { recursive: true });
      try {
        const repository = await GitRepository.create(path.join(projectRoot, 'repo'));
        await repository.createInitialCommit(parsed, initialMessage);
        await this.writeWorkspace(parsed.id, { version: 0, working: parsed });
        await atomicWriteJson(this.metadataPath(parsed.id), {
          id: parsed.id,
          name: parsed.name,
          ...(resolve ? { resolve } : {}),
        });
      } catch (error) {
        await rm(projectRoot, { recursive: true, force: true });
        throw error;
      }
      return { id: parsed.id, name: parsed.name };
    });
  }

  async importOtio(contents: string, sourcePath?: string): Promise<ProjectSummary & { unsupported: UnsupportedContent[] }> {
    const imported = importOtio(contents);
    const summary = await this.createProject(imported.project, 'Import Resolve OTIO');
    await this.writeMediaLinks(summary.id, imported.mediaLinks);
    if (sourcePath) {
      const digest = digestText(contents);
      await atomicWriteJson(this.sourceBindingPath(summary.id), {
        format: 'otio', mode: 'file', path: path.resolve(sourcePath), lastSeenDigest: digest, lastAppliedDigest: digest,
      });
    }
    return { ...summary, unsupported: imported.unsupported };
  }

  private async statusUnlocked(projectId: string): Promise<ProjectStatus> {
    const metadata = await this.readMetadata(projectId).catch(() => null);
    const repository = this.repository(projectId);
    const [branch, headCommit, index, workspace, branches, history] = await Promise.all([
      repository.currentBranch(),
      repository.resolve('HEAD'),
      repository.readIndex(),
      this.readWorkspace(projectId),
      repository.branches(),
      repository.history(),
    ]);
    const [head, source] = await Promise.all([
      repository.readSnapshot(headCommit),
      this.sourceStatus(projectId, workspace),
    ]);
    return {
      project: workspace.working,
      path: this.projectRoot(projectId),
      ...(metadata?.resolve ? { resolve: metadata.resolve } : {}),
      workspaceVersion: workspace.version,
      branch,
      headCommit,
      indexDigest: projectDigest(index),
      staged: semanticDiff(head, index),
      unstaged: semanticDiff(index, workspace.working),
      workingChanges: semanticDiff(head, workspace.working),
      branches,
      history,
      source,
    };
  }

  async status(projectId: string): Promise<ProjectStatus> {
    return this.mutex.run(projectId, async () => this.statusUnlocked(projectId));
  }

  private async scanOtioSourceUnlocked(projectId: string): Promise<boolean> {
    const binding = await this.sourceBinding(projectId);
    if (!binding) throw new Error('Connect a Resolve OTIO file before checking for changes');
    if (binding.mode !== 'file') throw new Error('Resolve save sync applies snapshots automatically');
    const contents = await readFile(binding.path, 'utf8');
    const digest = digestText(contents);
    const existingPending = await this.readPendingSync(projectId);
    if (existingPending?.digest === digest) {
      if (binding.lastError) {
        const next = { ...binding };
        delete next.lastError;
        await atomicWriteJson(this.sourceBindingPath(projectId), next);
      }
      return true;
    }
    if (binding.ignoredDigest === digest) {
      if (existingPending) await rm(this.pendingSyncPath(projectId), { force: true });
      const next = { ...binding, lastSeenDigest: digest };
      delete next.lastError;
      await atomicWriteJson(this.sourceBindingPath(projectId), next);
      return false;
    }

    const workspace = await this.readWorkspace(projectId);
    const imported = importOtio(contents);
    const reconciled = reconcileImportedProject(workspace.working, imported.project);
    const nextBinding: SourceBinding = { ...binding, lastSeenDigest: digest };
    delete nextBinding.ignoredDigest;
    delete nextBinding.lastError;
    if (semanticDiff(workspace.working, reconciled).length === 0) {
      nextBinding.lastAppliedDigest = digest;
      await Promise.all([
        atomicWriteJson(this.sourceBindingPath(projectId), nextBinding),
        this.writeMediaLinks(projectId, { ...await this.readMediaLinks(projectId), ...imported.mediaLinks }),
        rm(this.pendingSyncPath(projectId), { force: true }),
      ]);
      return false;
    }

    await Promise.all([
      atomicWriteJson(this.pendingSyncPath(projectId), pendingSync(
        reconciled, imported.mediaLinks, imported.unsupported, digest, workspace.version,
      )),
      atomicWriteJson(this.sourceBindingPath(projectId), nextBinding),
    ]);
    return true;
  }

  async connectOtioSource(projectId: string, sourcePath: string, expectedVersion: number): Promise<SourceScanResult> {
    return this.mutex.run(projectId, async () => {
      const workspace = await this.readWorkspace(projectId);
      if (workspace.version !== expectedVersion) throw new StaleWorkspaceError();
      await atomicWriteJson(this.sourceBindingPath(projectId), {
        format: 'otio', mode: 'file', path: path.resolve(sourcePath),
      });
      await rm(this.pendingSyncPath(projectId), { force: true });
      try {
        const changed = await this.scanOtioSourceUnlocked(projectId);
        return { changed, status: await this.statusUnlocked(projectId) };
      } catch (error) {
        const binding = await this.sourceBinding(projectId);
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (binding) await atomicWriteJson(this.sourceBindingPath(projectId), { ...binding, lastError: errorMessage });
        return {
          changed: false,
          status: await this.statusUnlocked(projectId),
          error: errorMessage,
        };
      }
    });
  }

  async scanOtioSource(projectId: string): Promise<SourceScanResult> {
    return this.mutex.run(projectId, async () => {
      try {
        const changed = await this.scanOtioSourceUnlocked(projectId);
        return { changed, status: await this.statusUnlocked(projectId) };
      } catch (error) {
        const binding = await this.sourceBinding(projectId);
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (binding) await atomicWriteJson(this.sourceBindingPath(projectId), { ...binding, lastError: errorMessage });
        return {
          changed: false,
          status: await this.statusUnlocked(projectId),
          error: errorMessage,
        };
      }
    });
  }

  async applyPendingSync(
    projectId: string,
    digest: string,
    expectedVersion: number,
  ): Promise<ProjectStatus> {
    return this.mutex.run(projectId, async () => {
      const [workspace, pending, binding] = await Promise.all([
        this.readWorkspace(projectId), this.readPendingSync(projectId), this.sourceBinding(projectId),
      ]);
      if (!pending || !binding || pending.digest !== digest) throw new StaleWorkspaceError();
      if (workspace.version !== expectedVersion || pending.baseWorkspaceVersion !== expectedVersion) {
        throw new StaleWorkspaceError();
      }
      await this.writeWorkspace(projectId, { version: workspace.version + 1, working: pending.project });
      await this.writeMediaLinks(projectId, { ...await this.readMediaLinks(projectId), ...pending.mediaLinks });
      await atomicWriteJson(this.sourceBindingPath(projectId), {
        ...binding, lastSeenDigest: digest, lastAppliedDigest: digest,
      });
      await rm(this.pendingSyncPath(projectId), { force: true });
      return this.statusUnlocked(projectId);
    });
  }

  async dismissPendingSync(projectId: string, digest: string): Promise<ProjectStatus> {
    return this.mutex.run(projectId, async () => {
      const [pending, binding] = await Promise.all([this.readPendingSync(projectId), this.sourceBinding(projectId)]);
      if (!pending || !binding || pending.digest !== digest) throw new StaleWorkspaceError();
      await atomicWriteJson(this.sourceBindingPath(projectId), { ...binding, ignoredDigest: digest });
      await rm(this.pendingSyncPath(projectId), { force: true });
      return this.statusUnlocked(projectId);
    });
  }

  /** Switch this repository from manual OTIO watching to the managed Resolve-save bridge. */
  async enableResolveBridge(projectId: string, expectedVersion: number): Promise<string> {
    return this.mutex.run(projectId, async () => {
      const workspace = await this.readWorkspace(projectId);
      if (workspace.version !== expectedVersion) throw new StaleWorkspaceError();
      const snapshotPath = this.resolveBridgeSnapshotPath(projectId);
      await mkdir(path.dirname(snapshotPath), { recursive: true });
      await atomicWriteJson(this.sourceBindingPath(projectId), {
        format: 'otio', mode: 'resolve', path: snapshotPath,
      });
      await rm(this.pendingSyncPath(projectId), { force: true });
      await atomicWriteJson(this.resolveBridgeStatePath(projectId), { state: 'starting' });
      return snapshotPath;
    });
  }

  async updateResolveBridgeState(
    projectId: string,
    state: 'starting' | 'waiting-for-resolve' | 'watching' | 'stopped' | 'invalid',
    error?: string,
  ): Promise<void> {
    await this.mutex.run(projectId, async () => {
      const binding = await this.sourceBinding(projectId);
      if (!binding || binding.mode !== 'resolve') return;
      const value: { state: typeof state; error?: string } = { state };
      if (error) value.error = error.slice(0, 2000);
      await atomicWriteJson(this.resolveBridgeStatePath(projectId), value);
    });
  }

  /**
   * Replace only WORKING with the latest saved Resolve state. HEAD and INDEX
   * stay untouched, so repeated saves never become hidden commits or a queue.
   */
  async applyResolveBridgeSnapshot(
    projectId: string,
    event: {
      path: string;
      marker: string;
      savedAt: string;
      projectName: string;
      timelineName: string;
    },
  ): Promise<boolean> {
    return this.mutex.run(projectId, async () => {
      const binding = await this.sourceBinding(projectId);
      if (!binding || binding.mode !== 'resolve') return false;
      if (path.resolve(event.path) !== path.resolve(binding.path)) {
        throw new Error('Resolve bridge wrote outside its managed snapshot path');
      }
      const contents = await readFile(binding.path, 'utf8');
      const digest = digestText(contents);
      if (binding.lastAppliedDigest === digest) {
        await atomicWriteJson(this.sourceBindingPath(projectId), {
          ...binding,
          lastSeenDigest: digest,
          lastMarker: event.marker,
          lastSavedAt: event.savedAt,
          resolveProjectName: event.projectName,
          resolveTimelineName: event.timelineName,
        });
        await atomicWriteJson(this.resolveBridgeStatePath(projectId), { state: 'watching' });
        return false;
      }

      const workspace = await this.readWorkspace(projectId);
      const imported = importOtio(contents);
      const reconciled = reconcileImportedProject(workspace.working, imported.project);
      const changed = semanticDiff(workspace.working, reconciled).length > 0;
      if (changed) {
        await this.writeWorkspace(projectId, { version: workspace.version + 1, working: reconciled });
      }
      await this.writeMediaLinks(projectId, { ...await this.readMediaLinks(projectId), ...imported.mediaLinks });
      const nextBinding: SourceBinding = {
        ...binding,
        lastSeenDigest: digest,
        lastAppliedDigest: digest,
        lastMarker: event.marker,
        lastSavedAt: event.savedAt,
        resolveProjectName: event.projectName,
        resolveTimelineName: event.timelineName,
      };
      delete nextBinding.lastError;
      await Promise.all([
        atomicWriteJson(this.sourceBindingPath(projectId), nextBinding),
        atomicWriteJson(this.resolveBridgeStatePath(projectId), { state: 'watching' }),
        rm(this.pendingSyncPath(projectId), { force: true }),
      ]);
      return changed;
    });
  }

  async edit(projectId: string, command: EditCommand, expectedVersion: number): Promise<ProjectStatus> {
    return this.mutex.run(projectId, async () => {
      const workspace = await this.readWorkspace(projectId);
      if (workspace.version !== expectedVersion) throw new StaleWorkspaceError();
      await this.writeWorkspace(projectId, {
        version: workspace.version + 1,
        working: reduceCommand(workspace.working, command),
      });
      return this.statusUnlocked(projectId);
    });
  }

  async stage(projectId: string, hunkIds: string[], expectedIndexDigest: string): Promise<ProjectStatus> {
    return this.mutex.run(projectId, async () => {
      const repository = this.repository(projectId);
      const [index, workspace] = await Promise.all([repository.readIndex(), this.readWorkspace(projectId)]);
      const nextIndex = applySemanticHunks(index, workspace.working, hunkIds, expectedIndexDigest);
      await repository.writeIndex(nextIndex);
      return this.statusUnlocked(projectId);
    });
  }

  async unstage(projectId: string, hunkIds: string[], expectedIndexDigest: string): Promise<ProjectStatus> {
    return this.mutex.run(projectId, async () => {
      const repository = this.repository(projectId);
      const [headCommit, index] = await Promise.all([repository.resolve('HEAD'), repository.readIndex()]);
      if (projectDigest(index) !== expectedIndexDigest) throw new StaleWorkspaceError();
      const head = await repository.readSnapshot(headCommit);
      const staged = semanticDiff(head, index);
      const selected = hunkIds.map((id) => {
        const hunk = staged.find((candidate) => candidate.id === id);
        if (!hunk) throw new StaleWorkspaceError();
        return hunk;
      });
      const reverse = semanticDiff(index, head);
      const reverseIds = selected.map((hunk) => {
        const match = reverse.find((candidate) => candidate.entityType === hunk.entityType
          && candidate.entityId === hunk.entityId
          && candidate.fieldGroup === hunk.fieldGroup);
        if (!match) throw new Error(`Cannot reverse hunk ${hunk.id}`);
        return match.id;
      });
      await repository.writeIndex(applySemanticHunks(index, head, reverseIds, projectDigest(index)));
      return this.statusUnlocked(projectId);
    });
  }

  async commit(projectId: string, message: string, expectedHead: string): Promise<ProjectStatus> {
    return this.mutex.run(projectId, async () => {
      if (!message.trim()) throw new Error('Commit message is required');
      const repository = this.repository(projectId);
      const [actualHead, head, index] = await Promise.all([
        repository.resolve('HEAD'),
        repository.readSnapshot('HEAD'),
        repository.readIndex(),
      ]);
      if (actualHead !== expectedHead) throw new StaleWorkspaceError();
      if (semanticDiff(head, index).length === 0) throw new Error('Nothing is staged');
      await repository.commitIndex(message, expectedHead);
      return this.statusUnlocked(projectId);
    });
  }

  async createBranch(projectId: string, name: string, fromRevision = 'HEAD'): Promise<ProjectStatus> {
    return this.mutex.run(projectId, async () => {
      await this.repository(projectId).createBranch(name, fromRevision);
      return this.statusUnlocked(projectId);
    });
  }

  async createBranchFromRevision(projectId: string, name: string, revision: string): Promise<ProjectStatus> {
    return this.mutex.run(projectId, async () => {
      const current = await this.statusUnlocked(projectId);
      if (current.staged.length > 0 || current.unstaged.length > 0 || current.source.pending) throw new DirtyWorkspaceError();
      const repository = this.repository(projectId);
      const commitId = await repository.resolve(revision);
      const snapshot = await repository.readSnapshot(commitId);
      await repository.createBranch(name, commitId);
      await repository.switchBranch(name);
      await repository.writeIndex(snapshot);
      const workspace = await this.readWorkspace(projectId);
      await this.writeWorkspace(projectId, { version: workspace.version + 1, working: snapshot });
      return this.statusUnlocked(projectId);
    });
  }

  async restoreRevisionToWorking(
    projectId: string,
    revision: string,
    expectedVersion: number,
    discardChanges: boolean,
  ): Promise<ProjectStatus> {
    return this.mutex.run(projectId, async () => {
      const current = await this.statusUnlocked(projectId);
      if (current.workspaceVersion !== expectedVersion) throw new StaleWorkspaceError();
      if (!discardChanges && (current.staged.length > 0 || current.unstaged.length > 0 || current.source.pending)) {
        throw new DirtyWorkspaceError();
      }
      if (discardChanges && current.source.pending) await rm(this.pendingSyncPath(projectId), { force: true });
      if (current.staged.length > 0) {
        await this.repository(projectId).writeIndex(await this.repository(projectId).readSnapshot('HEAD'));
      }
      const snapshot = await this.repository(projectId).readSnapshot(await this.repository(projectId).resolve(revision));
      await this.writeWorkspace(projectId, { version: expectedVersion + 1, working: snapshot });
      return this.statusUnlocked(projectId);
    });
  }

  async checkout(projectId: string, branch: string, discardChanges = false): Promise<ProjectStatus> {
    return this.mutex.run(projectId, async () => {
      const repository = this.repository(projectId);
      const current = await this.statusUnlocked(projectId);
      if (!discardChanges && (current.staged.length > 0 || current.unstaged.length > 0 || current.source.pending)) {
        throw new DirtyWorkspaceError();
      }
      if (discardChanges && current.source.pending) await rm(this.pendingSyncPath(projectId), { force: true });
      const target = await repository.resolve(`refs/heads/${branch}`);
      const snapshot = await repository.readSnapshot(target);
      await repository.switchBranch(branch);
      await repository.writeIndex(snapshot);
      const workspace = await this.readWorkspace(projectId);
      await this.writeWorkspace(projectId, { version: workspace.version + 1, working: snapshot });
      return this.statusUnlocked(projectId);
    });
  }

  async compare(projectId: string, baseRevision: string, headRevision: string): Promise<SemanticHunk[]> {
    const repository = this.repository(projectId);
    const [baseCommit, headCommit] = await Promise.all([repository.resolve(baseRevision), repository.resolve(headRevision)]);
    const [base, head] = await Promise.all([repository.readSnapshot(baseCommit), repository.readSnapshot(headCommit)]);
    return semanticDiff(base, head);
  }

  private localMediaPath(target: string): string | null {
    try {
      if (target.startsWith('file:')) return fileURLToPath(target);
    } catch {
      return null;
    }
    return path.isAbsolute(target) ? target : null;
  }

  private async previewAvailability(
    projectId: string,
    project: Project,
  ): Promise<Record<string, PreviewMediaAvailability>> {
    const links = await this.readMediaLinks(projectId);
    const availability: Record<string, PreviewMediaAvailability> = {};
    await Promise.all(project.assets.map(async (asset) => {
      const target = links[asset.fingerprint];
      const localPath = target ? this.localMediaPath(target) : null;
      if (!localPath) {
        availability[asset.fingerprint] = { available: false };
        return;
      }
      try {
        await access(localPath);
        availability[asset.fingerprint] = {
          available: true,
          mediaUrl: `snipsnap-media://asset/${projectId}/${asset.fingerprint}`,
        };
      } catch {
        availability[asset.fingerprint] = { available: false };
      }
    }));
    return availability;
  }

  async revisionDetails(projectId: string, revision: string, parentIndex = 0): Promise<RevisionDetails> {
    const repository = this.repository(projectId);
    const commitId = await repository.resolve(revision);
    const [commit, snapshot, branches] = await Promise.all([
      repository.commitInfo(commitId), repository.readSnapshot(commitId), repository.branches(),
    ]);
    const parent = commit.parents[parentIndex];
    const diff = parent
      ? semanticDiff(await repository.readSnapshot(parent), snapshot)
      : [];
    const availability = await this.previewAvailability(projectId, snapshot);
    const details: RevisionDetails = {
      commit,
      pointedToBy: branches.filter(({ commitId: branchCommit }) => branchCommit === commitId).map(({ name }) => name),
      diff,
      preview: buildPreviewPlan(snapshot, revision, commitId, projectDigest(snapshot), availability),
    };
    if (parent) details.comparedParent = parent;
    return details;
  }

  async linkMedia(projectId: string, fingerprint: string, filePath: string, revision = 'HEAD'): Promise<RevisionDetails> {
    if (!/^[a-f0-9]{64}$/u.test(fingerprint)) throw new Error('Invalid media fingerprint');
    await access(filePath);
    const links = await this.readMediaLinks(projectId);
    links[fingerprint] = pathToFileURL(path.resolve(filePath)).href;
    await this.writeMediaLinks(projectId, links);
    return this.revisionDetails(projectId, revision);
  }

  async resolveMediaFile(projectId: string, fingerprint: string): Promise<string> {
    if (!/^[a-f0-9]{64}$/u.test(fingerprint)) throw new Error('Invalid media fingerprint');
    const target = (await this.readMediaLinks(projectId))[fingerprint];
    const localPath = target ? this.localMediaPath(target) : null;
    if (!localPath) throw new Error('Media is not linked to a local file');
    await access(localPath);
    return localPath;
  }

  private async synchronizeCurrentBranch(projectId: string, branch: string, snapshot: Project): Promise<void> {
    const repository = this.repository(projectId);
    if (await repository.currentBranch() !== branch) return;
    await repository.writeIndex(snapshot);
    const workspace = await this.readWorkspace(projectId);
    await this.writeWorkspace(projectId, { version: workspace.version + 1, working: snapshot });
  }

  async merge(projectId: string, targetBranch: string, sourceBranch: string): Promise<MergeOutcome> {
    return this.mutex.run(projectId, async () => {
      const repository = this.repository(projectId);
      const current = await this.statusUnlocked(projectId);
      if (current.staged.length || current.unstaged.length || current.source.pending) throw new DirtyWorkspaceError();
      const [targetCommit, sourceCommit] = await Promise.all([
        repository.resolve(`refs/heads/${targetBranch}`),
        repository.resolve(`refs/heads/${sourceBranch}`),
      ]);
      if (await repository.isAncestor(sourceCommit, targetCommit)) return { status: 'upToDate', commitId: targetCommit };
      if (await repository.isAncestor(targetCommit, sourceCommit)) {
        await repository.updateRef(`refs/heads/${targetBranch}`, sourceCommit, targetCommit);
        await this.synchronizeCurrentBranch(projectId, targetBranch, await repository.readSnapshot(sourceCommit));
        return { status: 'fastForwarded', commitId: sourceCommit };
      }
      const baseCommit = await repository.mergeBase(targetCommit, sourceCommit);
      const [base, ours, theirs] = await Promise.all([
        repository.readSnapshot(baseCommit),
        repository.readSnapshot(targetCommit),
        repository.readSnapshot(sourceCommit),
      ]);
      const result = mergeThreeWay(base, ours, theirs);
      if (result.conflicts.length === 0) {
        const merged = completeMerge(result);
        const commitId = await repository.commitSnapshot(
          merged,
          `Merge ${sourceBranch} into ${targetBranch}`,
          [targetCommit, sourceCommit],
          targetBranch,
          targetCommit,
        );
        await this.synchronizeCurrentBranch(projectId, targetBranch, merged);
        return { status: 'merged', commitId };
      }
      const session: MergeSession = {
        id: randomUUID(), projectId, targetBranch, sourceBranch, baseCommit, targetCommit, sourceCommit, result,
      };
      await atomicWriteJson(this.sessionPath(projectId, session.id), session);
      return { status: 'conflicts', session };
    });
  }

  private async readSession(projectId: string, sessionId: string): Promise<MergeSession> {
    const value = await readJson(this.sessionPath(projectId, sessionId));
    const session = MergeSessionSchema.parse(value) as MergeSession;
    if (session.id !== sessionId || session.projectId !== projectId) throw new Error('Merge session identity does not match its storage path');
    return session;
  }

  async resolveConflict(projectId: string, sessionId: string, resolution: ConflictResolution): Promise<MergeSession> {
    return this.mutex.run(projectId, async () => {
      const session = await this.readSession(projectId, sessionId);
      session.result = resolveMerge(session.result, [resolution]);
      await atomicWriteJson(this.sessionPath(projectId, sessionId), session);
      return session;
    });
  }

  async completeMerge(projectId: string, sessionId: string): Promise<ProjectStatus> {
    return this.mutex.run(projectId, async () => {
      const session = await this.readSession(projectId, sessionId);
      const repository = this.repository(projectId);
      const merged = completeMerge(session.result);
      await repository.commitSnapshot(
        merged,
        `Merge ${session.sourceBranch} into ${session.targetBranch}`,
        [session.targetCommit, session.sourceCommit],
        session.targetBranch,
        session.targetCommit,
      );
      await this.synchronizeCurrentBranch(projectId, session.targetBranch, merged);
      await rm(this.sessionPath(projectId, sessionId), { force: true });
      return this.statusUnlocked(projectId);
    });
  }

  async abortMerge(projectId: string, sessionId: string): Promise<void> {
    await this.mutex.run(projectId, async () => {
      await this.readSession(projectId, sessionId);
      await rm(this.sessionPath(projectId, sessionId), { force: true });
    });
  }

  async tag(projectId: string, name: string, revision: string, message: string): Promise<void> {
    await this.mutex.run(projectId, async () => this.repository(projectId).createTag(name, revision, message));
  }

  async exportOtio(projectId: string, revision: string): Promise<{ commitId: string; contents: string }> {
    const repository = this.repository(projectId);
    const commitId = await repository.resolve(revision);
    const mediaLinks = await this.readMediaLinks(projectId);
    return { commitId, contents: exportOtio(await repository.readSnapshot(commitId), { mediaLinks }) };
  }

  private resolveRootsPath(): string {
    return path.join(this.root, 'resolve-roots.json');
  }

  /** The default export folder plus any folder the editor pointed us at. */
  async resolveRoots(): Promise<string[]> {
    const value = await this.readOptionalJson(this.resolveRootsPath());
    const extra = value === undefined ? [] : z.array(z.string().min(1)).parse(value);
    return [...new Set([...defaultResolveRoots(), ...extra.map((entry) => path.resolve(entry))])];
  }

  async addResolveRoot(folder: string): Promise<string[]> {
    const value = await this.readOptionalJson(this.resolveRootsPath());
    const extra = value === undefined ? [] : z.array(z.string().min(1)).parse(value);
    const next = [...new Set([...extra.map((entry) => path.resolve(entry)), path.resolve(folder)])];
    await atomicWriteJson(this.resolveRootsPath(), next);
    return this.resolveRoots();
  }

  /** Watch the folder holding a project file the editor picked by hand. */
  async addResolveProjectFile(projectFile: string): Promise<string[]> {
    return this.addResolveRoot(path.dirname(path.resolve(projectFile)));
  }

  /**
   * Rebuild timelines from any Resolve project database that has no export
   * beside it, so a project can be opened without Resolve running.
   */
  async rebuildTimelinesFromResolveDatabase(): Promise<{ projects: number; timelines: number }> {
    let projects = 0;
    let timelines = 0;
    for (const reference of await this.library.discover()) {
      if (reference.kind !== 'database' || reference.activeTimeline) continue;
      const databaseFile = path.join(reference.folder, 'Project.db');
      const folder = generatedExportFolder(reference.folder);
      await mkdir(folder, { recursive: true });
      const written = await writeTimelineExports(databaseFile, folder);
      if (written.length > 0) {
        projects += 1;
        timelines += written.length;
      }
    }
    return { projects, timelines };
  }

  async openResolveProjectById(projectId: string): Promise<ProjectStatus> {
    let reference = (await this.library.discover()).find(({ id }) => id === projectId);
    if (reference && !reference.activeTimeline && reference.kind === 'database') {
      // Nothing exported this project yet, so rebuild it from Resolve's database.
      await this.rebuildTimelinesFromResolveDatabase();
      reference = (await this.library.discover()).find(({ id }) => id === projectId);
    }
    if (!reference) {
      throw new Error('That Resolve project is no longer on disk. Export it again from Resolve.');
    }
    return this.openResolveProject(reference);
  }

  private async readMetadata(projectId: string): Promise<z.infer<typeof ProjectMetadataSchema> | null> {
    const value = await this.readOptionalJson(this.metadataPath(projectId));
    return value === undefined ? null : ProjectMetadataSchema.parse(value);
  }

  private bindingFor(reference: ResolveProjectRef): ResolveBinding {
    const knownTimeline = reference.knownTimelines?.[0];
    return {
      projectName: reference.name,
      drpPath: reference.drpPath,
      otioPath: reference.activeTimeline?.otioPath ?? '',
      timelineName: reference.activeTimeline?.name ?? knownTimeline ?? 'No timeline export',
      timelineCount: Math.max(reference.timelines.length, reference.knownTimelines?.length ?? 0),
      folder: reference.folder,
    };
  }

  /**
   * Open a project discovered from Resolve, importing its timeline the first
   * time and picking up any later export after that.
   */
  async openResolveProject(reference: ResolveProjectRef): Promise<ProjectStatus> {
    if (!reference.activeTimeline) {
      throw new Error(
        `${reference.name} has no timeline export yet. Open it in DaVinci Resolve and run `
        + 'SnipSnapSync, or put an .otio export beside its .drp file.',
      );
    }
    const binding = this.bindingFor(reference);
    const existing = await this.readMetadata(reference.id);
    if (!existing) {
      const contents = await readFile(binding.otioPath, 'utf8');
      const imported = importOtio(contents);
      const project = ProjectSchema.parse({ ...imported.project, id: reference.id, name: reference.name });
      await this.createProject(project, `Import ${binding.timelineName} from Resolve`, binding);
      await this.writeMediaLinks(reference.id, imported.mediaLinks);
      const digest = digestText(contents);
      await atomicWriteJson(this.sourceBindingPath(reference.id), {
        format: 'otio',
        mode: 'file',
        path: binding.otioPath,
        lastSeenDigest: digest,
        lastAppliedDigest: digest,
      });
      return this.status(reference.id);
    }

    if (existing.resolve?.otioPath !== binding.otioPath || existing.name !== reference.name) {
      await atomicWriteJson(this.metadataPath(reference.id), {
        id: reference.id,
        name: reference.name,
        resolve: binding,
      });
    }
    const current = await this.sourceBinding(reference.id);
    if (!current || (current.mode === 'file' && current.path !== binding.otioPath)) {
      await atomicWriteJson(this.sourceBindingPath(reference.id), { format: 'otio', mode: 'file', path: binding.otioPath });
    }
    // Pick up anything Resolve exported since the last time this was opened.
    return current?.mode === 'resolve'
      ? this.status(reference.id)
      : (await this.scanOtioSource(reference.id)).status;
  }

  private unlinkedOverview(reference: ResolveProjectRef): ProjectOverview {
    const binding = this.bindingFor(reference);
    const canRebuild = reference.kind === 'database' && (reference.knownTimelines?.length ?? 0) > 0;
    return {
      id: reference.id,
      name: reference.name,
      path: reference.folder,
      linked: false,
      openable: reference.activeTimeline !== null || canRebuild,
      kind: reference.kind,
      knownTimelines: reference.knownTimelines ?? reference.timelines.map(({ name }) => name),
      resolve: binding,
      branch: 'main',
      headCommit: '',
      headMessage: 'Not versioned yet',
      headAuthoredAt: reference.updatedAt,
      updatedAt: reference.updatedAt,
      commitCount: 0,
      branchCount: 0,
      state: 'clean',
      changeCount: 0,
      fps: reference.settings?.fps ?? 0,
      width: reference.settings?.width ?? 0,
      height: reference.settings?.height ?? 0,
      durationFrames: 0,
      trackCounts: { video: 0, audio: 0, caption: 0 },
      clipCount: 0,
      sourceFileName: path.basename(binding.otioPath),
      sourceState: 'not-connected',
      poster: null,
      missingMedia: 0,
    };
  }

  private async overviewUnlocked(projectId: string): Promise<ProjectOverview> {
    const status = await this.statusUnlocked(projectId);
    const availability = await this.previewAvailability(projectId, status.project);
    const plan = buildPreviewPlan(
      status.project,
      status.branch,
      status.headCommit,
      projectDigest(status.project),
      availability,
    );
    const head = status.history.find(({ id }) => id === status.headCommit);
    let workspaceModifiedAt = head?.authoredAt ?? new Date(0).toISOString();
    try {
      workspaceModifiedAt = (await stat(this.workspacePath(projectId))).mtime.toISOString();
    } catch {
      // A missing workspace file simply leaves the commit time as the last activity.
    }
    const poster = plan.segments.find((segment) => segment.kind === 'clip' && segment.available && segment.mediaUrl);
    const state: ProjectOverview['state'] = status.source.pending ? 'resolve-pending'
      : status.unstaged.length > 0 ? 'uncommitted'
        : status.staged.length > 0 ? 'staged' : 'clean';

    const metadata = await this.readMetadata(projectId);
    const binding = metadata?.resolve ?? {
      projectName: status.project.name,
      drpPath: '',
      otioPath: status.source.filePath ?? '',
      timelineName: status.project.sequences[0]?.name ?? 'Timeline',
      timelineCount: 1,
      folder: this.projectRoot(projectId),
    };
    return {
      id: projectId,
      name: status.project.name,
      path: this.projectRoot(projectId),
      linked: true,
      openable: true,
      kind: binding.drpPath ? 'export' : 'database',
      knownTimelines: [binding.timelineName],
      resolve: binding,
      branch: status.branch,
      headCommit: status.headCommit,
      headMessage: head?.message ?? '',
      headAuthoredAt: head?.authoredAt ?? workspaceModifiedAt,
      updatedAt: [head?.authoredAt, workspaceModifiedAt]
        .filter((value): value is string => Boolean(value))
        .sort()
        .at(-1) ?? workspaceModifiedAt,
      commitCount: status.history.length,
      branchCount: status.branches.length,
      state,
      changeCount: status.staged.length + status.unstaged.length + (status.source.pending?.changeCount ?? 0),
      fps: plan.fps,
      width: plan.width,
      height: plan.height,
      durationFrames: plan.totalFrames,
      trackCounts: {
        video: plan.tracks.filter(({ kind }) => kind === 'video').length,
        audio: plan.tracks.filter(({ kind }) => kind === 'audio').length,
        caption: plan.tracks.filter(({ kind }) => kind === 'caption').length,
      },
      clipCount: status.project.clips.length,
      sourceFileName: status.source.fileName ?? null,
      sourceState: status.source.state,
      poster: poster?.mediaUrl
        ? { mediaUrl: poster.mediaUrl, sourceStart: poster.sourceStart, fps: plan.fps }
        : null,
      missingMedia: plan.missingAssets.length,
    };
  }

  async overview(projectId: string): Promise<ProjectOverview> {
    return this.mutex.run(projectId, async () => this.overviewUnlocked(projectId));
  }

  /**
   * Dashboard listing, most recently worked on first. Only projects whose
   * Resolve project file and timeline export are both present are listed: a
   * project SnipSnap cannot open is not a project it should offer.
   */
  async listProjectOverviews(): Promise<ProjectOverview[]> {
    const references = await this.library.discover();
    const overviews: ProjectOverview[] = [];
    for (const reference of references) {
      const metadata = await this.readMetadata(reference.id).catch(() => null);
      if (!metadata) {
        overviews.push(this.unlinkedOverview(reference));
        continue;
      }
      try {
        const canRebuild = reference.kind === 'database' && (reference.knownTimelines?.length ?? 0) > 0;
        overviews.push({
          ...await this.overview(reference.id),
          name: reference.name,
          linked: true,
          openable: reference.activeTimeline !== null || canRebuild,
          kind: reference.kind,
          resolve: this.bindingFor(reference),
        });
      } catch {
        overviews.push(this.unlinkedOverview(reference));
      }
    }
    return overviews.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async discoverResolveProjects(): Promise<ResolveProjectRef[]> {
    return this.library.discover();
  }

  /** Build the split comparison between two immutable commits. */
  async compareTimelines(projectId: string, baseRevision: string, headRevision: string): Promise<TimelineComparison> {
    const repository = this.repository(projectId);
    const [baseCommit, headCommit] = await Promise.all([
      repository.resolve(baseRevision),
      repository.resolve(headRevision),
    ]);
    const [baseInfo, headInfo, baseSnapshot, headSnapshot] = await Promise.all([
      repository.commitInfo(baseCommit),
      repository.commitInfo(headCommit),
      repository.readSnapshot(baseCommit),
      repository.readSnapshot(headCommit),
    ]);
    const [baseAvailability, headAvailability] = await Promise.all([
      this.previewAvailability(projectId, baseSnapshot),
      this.previewAvailability(projectId, headSnapshot),
    ]);
    const basePlan = buildPreviewPlan(baseSnapshot, baseCommit, baseCommit, projectDigest(baseSnapshot), baseAvailability);
    const headPlan = buildPreviewPlan(headSnapshot, headCommit, headCommit, projectDigest(headSnapshot), headAvailability);
    return {
      base: { commit: baseInfo, plan: basePlan },
      head: { commit: headInfo, plan: headPlan },
      diff: buildTimelineDiff(basePlan, headPlan),
      hunks: semanticDiff(baseSnapshot, headSnapshot),
    };
  }

  async verify(projectId: string): Promise<void> {
    await this.mutex.run(projectId, async () => {
      const repository = this.repository(projectId);
      await repository.fsck();
      const [head, index, workspace] = await Promise.all([
        repository.readSnapshot('HEAD'), repository.readIndex(), this.readWorkspace(projectId),
      ]);
      ProjectSchema.parse(head);
      ProjectSchema.parse(index);
      ProjectSchema.parse(workspace.working);
    });
  }
}

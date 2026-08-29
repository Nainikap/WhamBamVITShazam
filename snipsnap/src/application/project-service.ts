import { randomUUID } from 'node:crypto';
import { access, mkdir, readdir, readFile, rm } from 'node:fs/promises';
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
import { buildPreviewPlan, type PreviewPlan, type PreviewMediaAvailability } from '../preview';
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
  entityType: z.enum(['project', 'sequence', 'track', 'asset', 'clip', 'gap', 'caption']),
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

export interface SourceSyncStatus {
  connected: boolean;
  fileName?: string;
  filePath?: string;
  state: 'not-connected' | 'watching' | 'changes-ready' | 'missing';
  lastAppliedDigest?: string;
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
  workspaceVersion: number;
  branch: string;
  headCommit: string;
  indexDigest: string;
  staged: SemanticHunk[];
  unstaged: SemanticHunk[];
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
    super('Checkout would discard staged or working changes');
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

  constructor(readonly root: string) {}

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
    const pending = await this.readPendingSync(projectId);
    let exists = true;
    try {
      await access(binding.path);
    } catch {
      exists = false;
    }
    const status: SourceSyncStatus = {
      connected: true,
      fileName: path.basename(binding.path),
      filePath: binding.path,
      state: exists ? (pending ? 'changes-ready' : 'watching') : 'missing',
    };
    if (binding.lastAppliedDigest) status.lastAppliedDigest = binding.lastAppliedDigest;
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
      const metadata = z.object({ id: z.string().uuid(), name: z.string() }).parse(await readJson(this.metadataPath(entry.name)));
      results.push(metadata);
    }
    return results.sort((left, right) => left.name.localeCompare(right.name));
  }

  async createProject(project: Project, initialMessage = 'Import timeline'): Promise<ProjectSummary> {
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
        await atomicWriteJson(this.metadataPath(parsed.id), { id: parsed.id, name: parsed.name });
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
        format: 'otio', path: path.resolve(sourcePath), lastSeenDigest: digest, lastAppliedDigest: digest,
      });
    }
    return { ...summary, unsupported: imported.unsupported };
  }

  private async statusUnlocked(projectId: string): Promise<ProjectStatus> {
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
      workspaceVersion: workspace.version,
      branch,
      headCommit,
      indexDigest: projectDigest(index),
      staged: semanticDiff(head, index),
      unstaged: semanticDiff(index, workspace.working),
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
    const contents = await readFile(binding.path, 'utf8');
    const digest = digestText(contents);
    const existingPending = await this.readPendingSync(projectId);
    if (existingPending?.digest === digest) return true;
    if (binding.ignoredDigest === digest || binding.lastAppliedDigest === digest) {
      if (existingPending) await rm(this.pendingSyncPath(projectId), { force: true });
      await atomicWriteJson(this.sourceBindingPath(projectId), { ...binding, lastSeenDigest: digest });
      return false;
    }

    const workspace = await this.readWorkspace(projectId);
    const imported = importOtio(contents);
    const reconciled = reconcileImportedProject(workspace.working, imported.project);
    const nextBinding: SourceBinding = { ...binding, lastSeenDigest: digest };
    delete nextBinding.ignoredDigest;
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
        format: 'otio', path: path.resolve(sourcePath),
      });
      await rm(this.pendingSyncPath(projectId), { force: true });
      try {
        const changed = await this.scanOtioSourceUnlocked(projectId);
        return { changed, status: await this.statusUnlocked(projectId) };
      } catch (error) {
        return {
          changed: false,
          status: await this.statusUnlocked(projectId),
          error: error instanceof Error ? error.message : String(error),
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
        return {
          changed: false,
          status: await this.statusUnlocked(projectId),
          error: error instanceof Error ? error.message : String(error),
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
      if (current.staged.length > 0 || current.unstaged.length > 0) throw new DirtyWorkspaceError();
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
      if (!discardChanges && (current.staged.length > 0 || current.unstaged.length > 0)) {
        throw new DirtyWorkspaceError();
      }
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
      if (!discardChanges && (current.staged.length > 0 || current.unstaged.length > 0)) throw new DirtyWorkspaceError();
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
      if (current.staged.length || current.unstaged.length) throw new DirtyWorkspaceError();
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

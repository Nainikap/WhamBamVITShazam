import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { exportOtio, importOtio, type UnsupportedContent } from '../adapters/otio';
import { reduceCommand, type EditCommand } from '../commands';
import { applySemanticHunks, semanticDiff, type SemanticHunk } from '../diff';
import { projectDigest, ProjectSchema, type Project } from '../domain';
import { GitRepository, KeyedMutex, type CommitInfo } from '../git';
import {
  completeMerge,
  mergeThreeWay,
  resolveMerge,
  type ConflictResolution,
  type MergeResult,
} from '../merge';
import { atomicWriteJson, readJson } from './storage';

const WorkspaceSchema = z.object({
  version: z.number().int().nonnegative(),
  working: ProjectSchema,
}).strict();

interface Workspace {
  version: number;
  working: Project;
}

interface MergeSession {
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

  async importOtio(contents: string): Promise<ProjectSummary & { unsupported: UnsupportedContent[] }> {
    const imported = importOtio(contents);
    const summary = await this.createProject(imported.project, 'Import Resolve OTIO');
    return { ...summary, unsupported: imported.unsupported };
  }

  async status(projectId: string): Promise<ProjectStatus> {
    const repository = this.repository(projectId);
    const [branch, headCommit, index, workspace, branches, history] = await Promise.all([
      repository.currentBranch(),
      repository.resolve('HEAD'),
      repository.readIndex(),
      this.readWorkspace(projectId),
      repository.branches(),
      repository.history(),
    ]);
    const head = await repository.readSnapshot(headCommit);
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
    };
  }

  async edit(projectId: string, command: EditCommand, expectedVersion: number): Promise<ProjectStatus> {
    return this.mutex.run(projectId, async () => {
      const workspace = await this.readWorkspace(projectId);
      if (workspace.version !== expectedVersion) throw new StaleWorkspaceError();
      await this.writeWorkspace(projectId, {
        version: workspace.version + 1,
        working: reduceCommand(workspace.working, command),
      });
      return this.status(projectId);
    });
  }

  async stage(projectId: string, hunkIds: string[], expectedIndexDigest: string): Promise<ProjectStatus> {
    return this.mutex.run(projectId, async () => {
      const repository = this.repository(projectId);
      const [index, workspace] = await Promise.all([repository.readIndex(), this.readWorkspace(projectId)]);
      const nextIndex = applySemanticHunks(index, workspace.working, hunkIds, expectedIndexDigest);
      await repository.writeIndex(nextIndex);
      return this.status(projectId);
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
      return this.status(projectId);
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
      return this.status(projectId);
    });
  }

  async createBranch(projectId: string, name: string, fromRevision = 'HEAD'): Promise<ProjectStatus> {
    return this.mutex.run(projectId, async () => {
      await this.repository(projectId).createBranch(name, fromRevision);
      return this.status(projectId);
    });
  }

  async checkout(projectId: string, branch: string, discardChanges = false): Promise<ProjectStatus> {
    return this.mutex.run(projectId, async () => {
      const repository = this.repository(projectId);
      const current = await this.status(projectId);
      if (!discardChanges && (current.staged.length > 0 || current.unstaged.length > 0)) throw new DirtyWorkspaceError();
      const target = await repository.resolve(`refs/heads/${branch}`);
      const snapshot = await repository.readSnapshot(target);
      await repository.switchBranch(branch);
      await repository.writeIndex(snapshot);
      const workspace = await this.readWorkspace(projectId);
      await this.writeWorkspace(projectId, { version: workspace.version + 1, working: snapshot });
      return this.status(projectId);
    });
  }

  async compare(projectId: string, baseRevision: string, headRevision: string): Promise<SemanticHunk[]> {
    const repository = this.repository(projectId);
    const [baseCommit, headCommit] = await Promise.all([repository.resolve(baseRevision), repository.resolve(headRevision)]);
    const [base, head] = await Promise.all([repository.readSnapshot(baseCommit), repository.readSnapshot(headCommit)]);
    return semanticDiff(base, head);
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
      const current = await this.status(projectId);
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
    const header = z.object({
      id: z.string().uuid(), projectId: z.string().uuid(), targetBranch: z.string(), sourceBranch: z.string(),
      baseCommit: z.string(), targetCommit: z.string(), sourceCommit: z.string(), result: z.unknown(),
    }).parse(value);
    return header as MergeSession;
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
      return this.status(projectId);
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
    return { commitId, contents: exportOtio(await repository.readSnapshot(commitId)) };
  }

  async verify(projectId: string): Promise<void> {
    const repository = this.repository(projectId);
    await repository.fsck();
    const [head, index, workspace] = await Promise.all([
      repository.readSnapshot('HEAD'), repository.readIndex(), this.readWorkspace(projectId),
    ]);
    ProjectSchema.parse(head);
    ProjectSchema.parse(index);
    ProjectSchema.parse(workspace.working);
  }
}

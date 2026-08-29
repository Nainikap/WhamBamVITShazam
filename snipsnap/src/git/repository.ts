import { mkdir } from 'node:fs/promises';
import { canonicalJson, validateProject, type Project } from '../domain';
import { GitError, runGit } from './process';

const ZERO_OID = '0000000000000000000000000000000000000000';
const OID_PATTERN = /^[a-f0-9]{40,64}$/u;
const SAFE_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;

export class StaleRefError extends Error {
  constructor(readonly ref: string) {
    super(`Ref ${ref} moved; reload and retry`);
    this.name = 'StaleRefError';
  }
}

export interface CommitInfo {
  id: string;
  parents: string[];
  author: string;
  authoredAt: string;
  message: string;
}

export interface CommitIdentity {
  name: string;
  email: string;
}

const defaultIdentity: CommitIdentity = {
  name: 'SnipSnap User',
  email: 'local@snipsnap.invalid',
};

function assertBranchName(name: string): void {
  if (!SAFE_REF_PATTERN.test(name)
    || name.startsWith('-')
    || name.includes('..')
    || name.includes('@{')
    || name.endsWith('.')
    || name.endsWith('/')
    || name.includes('//')
    || name.includes('\\')) {
    throw new Error(`Invalid branch name: ${name}`);
  }
}

function assertRevision(revision: string): void {
  if (OID_PATTERN.test(revision)) return;
  if (revision === 'HEAD') return;
  if (revision.startsWith('refs/heads/')) {
    assertBranchName(revision.slice('refs/heads/'.length));
    return;
  }
  if (revision.startsWith('refs/tags/')) {
    assertBranchName(revision.slice('refs/tags/'.length));
    return;
  }
  throw new Error(`Invalid revision: ${revision}`);
}

function refForBranch(branch: string): string {
  assertBranchName(branch);
  return `refs/heads/${branch}`;
}

function identityEnv(identity: CommitIdentity): NodeJS.ProcessEnv {
  return {
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
  };
}

export class GitRepository {
  constructor(readonly path: string) {}

  static async create(path: string): Promise<GitRepository> {
    await mkdir(path, { recursive: true });
    const repository = new GitRepository(path);
    await runGit(path, ['init', '--initial-branch=main']);
    await runGit(path, ['config', 'user.name', defaultIdentity.name]);
    await runGit(path, ['config', 'user.email', defaultIdentity.email]);
    return repository;
  }

  async resolve(revision: string): Promise<string> {
    assertRevision(revision);
    return (await runGit(this.path, ['rev-parse', '--verify', `${revision}^{commit}`])).stdout.trim();
  }

  async currentBranch(): Promise<string> {
    return (await runGit(this.path, ['symbolic-ref', '--short', 'HEAD'])).stdout.trim();
  }

  async readSnapshot(revision: string): Promise<Project> {
    assertRevision(revision);
    const output = await runGit(this.path, ['show', `${revision}:timeline.json`]);
    return validateProject(JSON.parse(output.stdout) as unknown);
  }

  async readIndex(): Promise<Project> {
    const output = await runGit(this.path, ['show', ':timeline.json']);
    return validateProject(JSON.parse(output.stdout) as unknown);
  }

  private async writeBlob(project: Project): Promise<string> {
    return (await runGit(this.path, ['hash-object', '-w', '--stdin'], { input: canonicalJson(project) })).stdout.trim();
  }

  async writeIndex(project: Project): Promise<string> {
    const blob = await this.writeBlob(validateProject(project));
    await runGit(this.path, ['update-index', '--add', '--cacheinfo', `100644,${blob},timeline.json`]);
    return (await runGit(this.path, ['write-tree'])).stdout.trim();
  }

  private async treeFor(project: Project): Promise<string> {
    const blob = await this.writeBlob(validateProject(project));
    return (await runGit(this.path, ['mktree'], { input: `100644 blob ${blob}\ttimeline.json\n` })).stdout.trim();
  }

  private async commitTree(
    tree: string,
    message: string,
    parents: string[],
    identity: CommitIdentity,
  ): Promise<string> {
    const args = ['commit-tree', tree];
    for (const parent of parents) {
      if (!OID_PATTERN.test(parent)) throw new Error(`Invalid parent object ID: ${parent}`);
      args.push('-p', parent);
    }
    args.push('-F', '-');
    return (await runGit(this.path, args, { input: `${message.trim()}\n`, env: identityEnv(identity) })).stdout.trim();
  }

  async createInitialCommit(
    project: Project,
    message: string,
    identity: CommitIdentity = defaultIdentity,
  ): Promise<string> {
    const tree = await this.writeIndex(project);
    const commit = await this.commitTree(tree, message, [], identity);
    await this.updateRef('refs/heads/main', commit, ZERO_OID);
    return commit;
  }

  async commitIndex(
    message: string,
    expectedHead: string,
    identity: CommitIdentity = defaultIdentity,
  ): Promise<string> {
    if (!OID_PATTERN.test(expectedHead)) throw new Error('Invalid expected HEAD');
    const tree = (await runGit(this.path, ['write-tree'])).stdout.trim();
    const commit = await this.commitTree(tree, message, [expectedHead], identity);
    const branch = await this.currentBranch();
    await this.updateRef(refForBranch(branch), commit, expectedHead);
    return commit;
  }

  async commitSnapshot(
    project: Project,
    message: string,
    parents: string[],
    targetBranch: string,
    expectedTarget: string,
    identity: CommitIdentity = defaultIdentity,
  ): Promise<string> {
    const tree = await this.treeFor(project);
    const commit = await this.commitTree(tree, message, parents, identity);
    await this.updateRef(refForBranch(targetBranch), commit, expectedTarget);
    return commit;
  }

  async updateRef(ref: string, next: string, expected: string): Promise<void> {
    if (!ref.startsWith('refs/heads/') && !ref.startsWith('refs/tags/')) throw new Error('Only branch and tag refs may be updated');
    assertRevision(ref);
    if (!OID_PATTERN.test(next) || !(OID_PATTERN.test(expected) || expected === ZERO_OID)) throw new Error('Invalid ref object ID');
    try {
      await runGit(this.path, ['update-ref', ref, next, expected]);
    } catch (error) {
      if (error instanceof GitError && /cannot lock ref|is at .* but expected|reference already exists/u.test(error.stderr)) {
        throw new StaleRefError(ref);
      }
      throw error;
    }
  }

  async createBranch(name: string, fromRevision: string): Promise<void> {
    const ref = refForBranch(name);
    const commit = await this.resolve(fromRevision);
    await this.updateRef(ref, commit, ZERO_OID);
  }

  async switchBranch(name: string): Promise<void> {
    const ref = refForBranch(name);
    await this.resolve(ref);
    await runGit(this.path, ['symbolic-ref', 'HEAD', ref]);
  }

  async branches(): Promise<Array<{ name: string; commitId: string }>> {
    const output = await runGit(this.path, ['for-each-ref', '--format=%(refname:short)%00%(objectname)', 'refs/heads']);
    return output.stdout.trim().split('\n').filter(Boolean).map((line) => {
      const [name, commitId] = line.split('\0');
      if (!name || !commitId) throw new Error('Git returned an invalid branch record');
      return { name, commitId };
    });
  }

  async mergeBase(left: string, right: string): Promise<string> {
    assertRevision(left);
    assertRevision(right);
    return (await runGit(this.path, ['merge-base', left, right])).stdout.trim();
  }

  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    assertRevision(ancestor);
    assertRevision(descendant);
    try {
      await runGit(this.path, ['merge-base', '--is-ancestor', ancestor, descendant]);
      return true;
    } catch (error) {
      if (error instanceof GitError && error.exitCode === 1) return false;
      throw error;
    }
  }

  async history(limit = 100): Promise<CommitInfo[]> {
    const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 500);
    const format = '%H%x00%P%x00%an <%ae>%x00%aI%x00%s%x1e';
    const output = await runGit(this.path, ['log', '--all', `--max-count=${safeLimit}`, `--format=${format}`]);
    return output.stdout.split('\x1e').map((record) => record.trim()).filter(Boolean).map((record) => {
      const [id, parents = '', author = '', authoredAt = '', message = ''] = record.split('\0');
      if (!id) throw new Error('Git returned an invalid history record');
      return { id, parents: parents ? parents.split(' ') : [], author, authoredAt, message };
    });
  }

  async commitInfo(revision: string): Promise<CommitInfo> {
    const commit = await this.resolve(revision);
    const format = '%H%x00%P%x00%an <%ae>%x00%aI%x00%s';
    const output = await runGit(this.path, ['show', '--no-patch', `--format=${format}`, commit]);
    const [id, parents = '', author = '', authoredAt = '', message = ''] = output.stdout.trim().split('\0');
    if (!id || !OID_PATTERN.test(id)) throw new Error('Git returned an invalid commit record');
    return { id, parents: parents ? parents.split(' ') : [], author, authoredAt, message };
  }

  async createTag(name: string, revision: string, message: string, identity: CommitIdentity = defaultIdentity): Promise<void> {
    assertBranchName(name);
    const commit = await this.resolve(revision);
    await runGit(this.path, ['tag', '--annotate', name, commit, '--message', message], { env: identityEnv(identity) });
  }

  async fsck(): Promise<void> {
    await runGit(this.path, ['fsck', '--strict', '--no-dangling']);
  }
}

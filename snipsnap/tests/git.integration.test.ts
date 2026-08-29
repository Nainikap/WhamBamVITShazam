import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { reduceCommand } from '../src/commands';
import { createDemoProject } from '../src/domain';
import { GitRepository, StaleRefError, runGit } from '../src/git';

describe('native Git repository', () => {
  let directory: string;
  let repository: GitRepository;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'snipsnap-git-'));
    repository = await GitRepository.create(directory);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('stores canonical snapshots in real index, tree, commit, and branch objects', async () => {
    const project = createDemoProject();
    const initial = await repository.createInitialCommit(project, 'Import timeline');

    expect(await repository.resolve('HEAD')).toBe(initial);
    expect(await repository.readSnapshot(initial)).toEqual(project);
    expect(await repository.readIndex()).toEqual(project);
    expect((await runGit(directory, ['cat-file', '-t', initial])).stdout.trim()).toBe('commit');
    expect((await runGit(directory, ['ls-tree', '--name-only', initial])).stdout.trim()).toBe('timeline.json');
    await repository.fsck();
  });

  it('creates two-parent commits and discovers their merge base', async () => {
    const base = createDemoProject();
    const initial = await repository.createInitialCommit(base, 'Import timeline');
    await repository.createBranch('feature', initial);
    const first = base.clips[0];
    const caption = base.captions[0];
    if (!first || !caption) throw new Error('Fixture is incomplete');

    const mainState = reduceCommand(base, { type: 'setClipPreset', clipId: first.id, preset: 'warm' });
    await repository.writeIndex(mainState);
    const mainCommit = await repository.commitIndex('Warm treatment', initial);

    await repository.switchBranch('feature');
    await repository.writeIndex(reduceCommand(base, { type: 'updateCaption', captionId: caption.id, text: 'Feature line' }));
    const featureCommit = await repository.commitIndex('Rewrite caption', initial);
    expect(await repository.mergeBase(mainCommit, featureCommit)).toBe(initial);

    const merged = reduceCommand(mainState, { type: 'updateCaption', captionId: caption.id, text: 'Feature line' });
    const mergeCommit = await repository.commitSnapshot(merged, 'Merge feature', [mainCommit, featureCommit], 'main', mainCommit);
    const parents = (await runGit(directory, ['show', '--no-patch', '--format=%P', mergeCommit])).stdout.trim().split(' ');
    expect(parents).toEqual([mainCommit, featureCommit]);
    expect(await repository.readSnapshot(mergeCommit)).toEqual(merged);
  });

  it('rejects stale compare-and-swap ref updates', async () => {
    const project = createDemoProject();
    const initial = await repository.createInitialCommit(project, 'Import timeline');
    const clip = project.clips[0];
    if (!clip) throw new Error('Fixture clip missing');
    await repository.writeIndex(reduceCommand(project, { type: 'setClipGain', clipId: clip.id, gainDb: -3 }));
    const next = await repository.commitIndex('Lower gain', initial);

    await expect(repository.updateRef('refs/heads/main', initial, initial)).rejects.toBeInstanceOf(StaleRefError);
    expect(await repository.resolve('refs/heads/main')).toBe(next);
  });

  it('validates branch names before invoking Git', async () => {
    const initial = await repository.createInitialCommit(createDemoProject(), 'Import timeline');
    await expect(repository.createBranch('--upload-pack=oops', initial)).rejects.toThrow(/Invalid branch name/u);
    await expect(repository.createBranch('../escape', initial)).rejects.toThrow(/Invalid branch name/u);
  });

  it('peels annotated tags to immutable commit IDs and ignores unsafe Git environment overrides', async () => {
    const initial = await repository.createInitialCommit(createDemoProject(), 'Import timeline');
    await repository.createTag('v1.0', initial, 'Approved cut');
    expect((await runGit(directory, ['cat-file', '-t', 'refs/tags/v1.0'])).stdout.trim()).toBe('tag');
    expect(await repository.resolve('refs/tags/v1.0')).toBe(initial);

    const resolvedWithOverride = await runGit(directory, ['rev-parse', '--show-toplevel'], {
      env: { GIT_DIR: path.join(directory, 'missing-repository') },
    });
    expect(path.resolve(resolvedWithOverride.stdout.trim())).toBe(path.resolve(directory));
  });
});

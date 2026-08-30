import { mkdtemp, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { reduceCommand } from '../src/commands';
import {
  createDemoProject,
  decorations,
  deterministicUuid,
  digestText,
  validateProject,
  type Project,
} from '../src/domain';
import { GitRepository, StaleRefError, runGit } from '../src/git';

function createStorageFixture(clipCount = 500): Project {
  const projectId = deterministicUuid('storage-fixture:project');
  const sequenceId = deterministicUuid(`${projectId}:sequence`);
  const trackId = deterministicUuid(`${sequenceId}:video`);
  const assets = Array.from({ length: clipCount }, (_, index) => ({
    id: deterministicUuid(`${projectId}:asset:${index}`),
    name: `camera-${index}-${digestText(`asset-name:${index}`).slice(0, 16)}.mov`,
    fingerprint: digestText(`media-fingerprint:${index}`),
    durationFrames: 2_000,
    extras: {},
  }));
  const clips = assets.map((asset, index) => ({
    id: deterministicUuid(`${trackId}:clip:${index}`),
    type: 'clip' as const,
    trackId,
    name: `Clip ${index} ${digestText(`clip-name:${index}`).slice(0, 16)}`,
    assetId: asset.id,
    sourceRange: { start: index % 300, duration: 120 },
    gainDb: 0,
    preset: 'none' as const,
    color: null,
    ...decorations(),
  }));

  return validateProject({
    schemaVersion: 1,
    id: projectId,
    name: 'Large deterministic storage fixture',
    sequences: [{
      id: sequenceId,
      name: 'Main Timeline',
      fps: { numerator: 24, denominator: 1 },
      width: 3_840,
      height: 2_160,
      trackIds: [trackId],
      globalStartFrame: 0,
      markers: [],
      extras: {},
    }],
    tracks: [{
      id: trackId,
      sequenceId,
      name: 'V1',
      kind: 'video',
      itemIds: clips.map(({ id }) => id),
      ...decorations(),
    }],
    assets,
    clips,
    gaps: [],
    transitions: [],
    captions: [],
    extras: {},
  });
}

async function regularFileBytes(root: string): Promise<number> {
  const entries = await readdir(root, { withFileTypes: true });
  const sizes = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) return regularFileBytes(entryPath);
    if (entry.isFile()) return (await stat(entryPath)).size;
    return 0;
  }));
  return sizes.reduce((total, size) => total + size, 0);
}

async function setHostilePackConfig(directory: string): Promise<void> {
  const settings = [
    ['pack.window', '0'],
    ['pack.depth', '0'],
    ['pack.windowMemory', '1'],
    ['pack.compression', '0'],
    ['core.bigFileThreshold', '1'],
  ] as const;
  for (const [name, value] of settings) {
    await runGit(directory, ['config', name, value]);
  }
}

function deterministicBytes(size: number): Buffer {
  const bytes = Buffer.alloc(size);
  let state = 0x1234_5678;
  for (let index = 0; index < bytes.length; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    bytes[index] = state >>> 24;
  }
  return bytes;
}

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

  it('automatically packs loose objects without trusting ambient Git pack settings', async () => {
    const loosePaths = Array.from({ length: 260 }, (_, index) => path.join(directory, `snapshot-${index}.json`));
    await Promise.all(loosePaths.map((snapshotPath, index) => writeFile(
      snapshotPath,
      JSON.stringify({ revision: index, unchangedTimelineData: 'x'.repeat(4_096) }),
      'utf8',
    )));
    const looseObjectIds = (await runGit(directory, ['hash-object', '-w', '--stdin-paths'], {
      input: `${loosePaths.join('\n')}\n`,
    })).stdout.trim().split('\n');
    await setHostilePackConfig(directory);

    const project = createDemoProject('Automatic storage maintenance');
    const commit = await repository.createInitialCommit(project, 'Import timeline');
    const packFiles = await readdir(path.join(directory, '.git', 'objects', 'pack'));
    const objectCounts = (await runGit(directory, ['count-objects', '--verbose'])).stdout;

    expect(packFiles.some((name) => name.endsWith('.pack'))).toBe(true);
    expect(objectCounts).toMatch(/^count: 1$/mu);
    expect(await repository.readSnapshot(commit)).toEqual(project);
    expect(await repository.readIndex()).toEqual(project);
    expect((await runGit(directory, ['ls-tree', '--name-only', commit])).stdout.trim()).toBe('timeline.json');
    const preservedLooseObject = looseObjectIds[0];
    if (!preservedLooseObject) throw new Error('Expected a loose object ID');
    await runGit(directory, ['cat-file', '-e', preservedLooseObject]);
    await repository.fsck();
  });

  it('automatically packs large loose snapshots before the object-count threshold', async () => {
    const largeSnapshotPath = path.join(directory, 'large-snapshot.json');
    await writeFile(largeSnapshotPath, deterministicBytes(5 * 1_024 * 1_024));
    const largeObject = (await runGit(directory, ['hash-object', '-w', largeSnapshotPath])).stdout.trim();
    const before = (await runGit(directory, ['count-objects', '--verbose'])).stdout;
    expect(before).toMatch(/^count: 1$/mu);
    expect(before).toMatch(/^size: [5-9]\d{3}$/mu);

    const project = createDemoProject('Large snapshot maintenance');
    const commit = await repository.createInitialCommit(project, 'Import timeline');
    const after = (await runGit(directory, ['count-objects', '--verbose'])).stdout;

    expect(after).toMatch(/^count: 1$/mu);
    expect((await readdir(path.join(directory, '.git', 'objects', 'pack')))
      .some((name) => name.endsWith('.pack'))).toBe(true);
    await runGit(directory, ['cat-file', '-e', largeObject]);
    expect(await repository.readSnapshot(commit)).toEqual(project);
    await repository.fsck();
  });

  it('compacts large snapshot history without changing Git or semantic state', async () => {
    const snapshots = new Map<string, Project>();
    let project = createStorageFixture();
    let head = await repository.createInitialCommit(project, 'Import large timeline');
    snapshots.set(head, project);

    for (let revision = 0; revision < 24; revision += 1) {
      const clip = project.clips[revision];
      if (!clip) throw new Error('Storage fixture clip missing');
      project = reduceCommand(project, {
        type: 'setClipGain',
        clipId: clip.id,
        gainDb: -((revision % 12) + 1),
      });
      await repository.writeIndex(project);
      head = await repository.commitIndex(`Adjust clip ${revision}`, head);
      snapshots.set(head, project);
    }

    const stagedClip = project.clips[400];
    if (!stagedClip) throw new Error('Storage fixture staged clip missing');
    const stagedSnapshot = reduceCommand(project, {
      type: 'setClipPreset',
      clipId: stagedClip.id,
      preset: 'warm',
    });
    await repository.writeIndex(stagedSnapshot);

    const refsBefore = (await runGit(directory, [
      'for-each-ref',
      '--format=%(refname)%00%(objectname)',
      'refs',
    ])).stdout;
    const commitsBefore = (await runGit(directory, ['rev-list', '--all', '--parents'])).stdout;
    const reflogsBefore = (await runGit(directory, ['reflog', '--all', '--format=%H%x00%gD'])).stdout;
    const indexBefore = (await runGit(directory, ['ls-files', '--stage'])).stdout;
    const looseBytes = await regularFileBytes(path.join(directory, '.git', 'objects'));
    await setHostilePackConfig(directory);

    const assertRepositoryUnchanged = async () => {
      expect(await repository.resolve('HEAD')).toBe(head);
      expect(await repository.resolve('refs/heads/main')).toBe(head);
      expect((await runGit(directory, [
        'for-each-ref',
        '--format=%(refname)%00%(objectname)',
        'refs',
      ])).stdout).toBe(refsBefore);
      expect((await runGit(directory, ['rev-list', '--all', '--parents'])).stdout).toBe(commitsBefore);
      expect((await runGit(directory, ['reflog', '--all', '--format=%H%x00%gD'])).stdout).toBe(reflogsBefore);
      expect((await runGit(directory, ['ls-files', '--stage'])).stdout).toBe(indexBefore);
      expect(await repository.readIndex()).toEqual(stagedSnapshot);

      for (const [commit, snapshot] of snapshots) {
        expect((await runGit(directory, ['ls-tree', '-r', '--name-only', commit])).stdout.trim()).toBe('timeline.json');
        expect(await repository.readSnapshot(commit)).toEqual(snapshot);
      }
    };

    await repository.optimizeSnapshotStorage();
    const compactedBytes = await regularFileBytes(path.join(directory, '.git', 'objects'));
    expect(compactedBytes).toBeLessThan(looseBytes * 0.25);
    await assertRepositoryUnchanged();

    await repository.optimizeSnapshotStorage();
    const recompactedBytes = await regularFileBytes(path.join(directory, '.git', 'objects'));
    expect(recompactedBytes).toBeLessThanOrEqual(Math.ceil(compactedBytes * 1.05));
    await assertRepositoryUnchanged();
    await repository.fsck();
  }, 60_000);

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

  it('moves every branch through a transport-neutral Git bundle', async () => {
    const project = createDemoProject();
    const initial = await repository.createInitialCommit(project, 'Import timeline');
    await repository.createBranch('alternate', initial);
    const clip = project.clips[0];
    if (!clip) throw new Error('Fixture clip missing');
    await repository.writeIndex(reduceCommand(project, { type: 'trimClip', clipId: clip.id, start: 12, duration: 96 }));
    const main = await repository.commitIndex('Trim main', initial);

    const bundle = path.join(directory, 'transfer', 'project.bundle');
    await repository.createBundle(bundle);
    const peer = await GitRepository.create(path.join(directory, 'peer'));
    expect(await peer.fetchBundle(bundle, 'origin')).toEqual(expect.arrayContaining([
      { name: 'main', commitId: main },
      { name: 'alternate', commitId: initial },
    ]));
    expect(await peer.readSnapshot('refs/remotes/origin/main')).toEqual(
      reduceCommand(project, { type: 'trimClip', clipId: clip.id, start: 12, duration: 96 }),
    );
    await peer.fsck();
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
    expect(await realpath(resolvedWithOverride.stdout.trim())).toBe(await realpath(directory));
  });
});

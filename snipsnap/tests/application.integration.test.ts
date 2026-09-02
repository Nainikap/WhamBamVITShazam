import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DirtyWorkspaceError, ProjectService, StaleWorkspaceError } from '../src/application';
import { createDemoProject } from '../src/domain';
import { GitRepository, runGit } from '../src/git';

describe('V1 project workflow', () => {
  let root: string;
  let service: ProjectService;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'snipsnap-app-'));
    process.env.SNIPSNAP_RESOLVE_DATABASE = path.join(root, 'no-resolve-database');
    service = new ProjectService(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function stageAll(projectId: string) {
    const status = await service.status(projectId);
    return service.stage(projectId, status.unstaged.map(({ id }) => id), status.indexDigest);
  }

  it('keeps a project out of the dashboard when Resolve has not exported it', async () => {
    const project = createDemoProject('Local Only');
    await service.createProject(project);

    // The dashboard lists Resolve exports, so a bare repository must not appear.
    expect(await service.listProjectOverviews()).toEqual([]);
    expect(await service.listProjects()).toEqual([{ id: project.id, name: 'Local Only' }]);
  });

  it('compares two commits into playable plans and highlighted lane differences', async () => {
    const project = createDemoProject();
    await service.createProject(project);
    const clip = project.clips[0];
    const voice = project.clips.find(({ name }) => name === 'Interview VO');
    if (!clip || !voice) throw new Error('Fixture clips missing');
    const first = await service.status(project.id);
    let status = await service.edit(project.id, { type: 'trimClip', clipId: clip.id, start: 0, duration: 96 }, first.workspaceVersion);
    status = await service.edit(project.id, { type: 'setClipGain', clipId: voice.id, gainDb: -9 }, status.workspaceVersion);
    status = await stageAll(project.id);
    status = await service.commit(project.id, 'Tighten the intro', status.headCommit, status.indexDigest);

    const comparison = await service.compareTimelines(project.id, first.headCommit, status.headCommit);
    expect(comparison.base.commit.id).toBe(first.headCommit);
    expect(comparison.head.commit.id).toBe(status.headCommit);
    expect(comparison.base.plan.totalFrames).toBe(504);
    expect(comparison.head.plan.totalFrames).toBe(504);

    const video = comparison.diff.tracks.find(({ kind }) => kind === 'video');
    const audio = comparison.diff.tracks.find(({ kind }) => kind === 'audio');
    expect(video?.segments[0]).toMatchObject({ change: 'modified', timingChanged: true });
    expect(video?.segments[1]).toMatchObject({ change: 'modified', changedFields: ['position'] });
    expect(audio?.segments.find(({ name }) => name === 'Interview VO')).toMatchObject({
      change: 'modified',
      changedFields: ['gain'],
      timingChanged: false,
    });
    expect(comparison.hunks.length).toBeGreaterThan(0);
  });

  it('refuses a commit that would repeat the latest version', async () => {
    const project = createDemoProject();
    await service.createProject(project);
    const status = await service.status(project.id);

    expect(status.staged).toHaveLength(0);
    await expect(service.commit(project.id, 'Nothing changed', status.headCommit, status.indexDigest)).rejects.toThrow(/Nothing is staged/u);
    expect((await service.status(project.id)).history).toHaveLength(1);
  });

  it('keeps HEAD, INDEX, and WORKING distinct and commits only staged hunks', async () => {
    const project = createDemoProject();
    await service.createProject(project);
    const initial = await service.status(project.id);
    const first = project.clips[0];
    const second = project.clips[1];
    if (!first || !second) throw new Error('Fixture clips missing');

    let status = await service.edit(project.id, { type: 'setClipPreset', clipId: first.id, preset: 'warm' }, initial.workspaceVersion);
    status = await service.edit(project.id, { type: 'setClipGain', clipId: second.id, gainDb: -6 }, status.workspaceVersion);
    expect(status.unstaged).toHaveLength(2);
    const selectedHunk = status.unstaged[0];
    if (!selectedHunk) throw new Error('Expected an unstaged hunk');
    status = await service.stage(project.id, [selectedHunk.id], status.indexDigest);
    expect(status.staged).toHaveLength(1);
    expect(status.unstaged).toHaveLength(1);

    const stagedComparison = await service.compareWorkspaceTimelines(
      project.id,
      'staged',
      status.headCommit,
      status.indexDigest,
      status.workspaceVersion,
    );
    expect(stagedComparison).toMatchObject({
      kind: 'workspace',
      scope: 'staged',
      base: { state: 'head', label: 'Last commit' },
      head: { state: 'index', label: 'Staged changes' },
    });
    expect(stagedComparison.hunks.map(({ id }) => id)).toEqual(status.staged.map(({ id }) => id));

    const unstagedComparison = await service.compareWorkspaceTimelines(
      project.id,
      'unstaged',
      status.headCommit,
      status.indexDigest,
      status.workspaceVersion,
    );
    expect(unstagedComparison).toMatchObject({
      kind: 'workspace',
      scope: 'unstaged',
      base: { state: 'index', label: 'Staged changes' },
      head: { state: 'working', label: 'Working changes' },
    });
    expect(unstagedComparison.hunks.map(({ id }) => id)).toEqual(status.unstaged.map(({ id }) => id));
    const unchanged = await service.status(project.id);
    expect(unchanged).toMatchObject({
      headCommit: status.headCommit,
      indexDigest: status.indexDigest,
      workspaceVersion: status.workspaceVersion,
    });

    await expect(service.compareWorkspaceTimelines(
      project.id,
      'staged',
      status.headCommit,
      '0'.repeat(64),
      status.workspaceVersion,
    )).rejects.toThrow(/staging area changed/u);

    status = await service.commit(project.id, 'Stage one editorial decision', status.headCommit, status.indexDigest);
    expect(status.staged).toEqual([]);
    expect(status.unstaged).toHaveLength(1);
    const committed = await new GitRepository(path.join(root, 'projects', project.id, 'repo')).readSnapshot('HEAD');
    const changedClips = committed.clips.filter((clip, index) => JSON.stringify(clip) !== JSON.stringify(project.clips[index]));
    expect(changedClips).toHaveLength(1);
  });

  it('rejects a commit when INDEX changed after the commit view was loaded', async () => {
    const project = createDemoProject('Stale commit view');
    await service.createProject(project);
    const [first, second] = project.clips;
    if (!first || !second) throw new Error('Fixture clips missing');
    let status = await service.status(project.id);
    status = await service.edit(project.id, { type: 'setClipPreset', clipId: first.id, preset: 'warm' }, status.workspaceVersion);
    status = await service.edit(project.id, { type: 'setClipGain', clipId: second.id, gainDb: -8 }, status.workspaceVersion);
    const firstHunk = status.unstaged[0];
    if (!firstHunk) throw new Error('Expected the first hunk');
    const reviewed = await service.stage(project.id, [firstHunk.id], status.indexDigest);
    const remaining = reviewed.unstaged[0];
    if (!remaining) throw new Error('Expected the second hunk');
    const changed = await service.stage(project.id, [remaining.id], reviewed.indexDigest);

    await expect(service.commit(
      project.id,
      'Commit stale selection',
      reviewed.headCommit,
      reviewed.indexDigest,
    )).rejects.toBeInstanceOf(StaleWorkspaceError);
    expect((await service.status(project.id)).staged).toHaveLength(changed.staged.length);
    expect((await service.status(project.id)).history).toHaveLength(1);
  });

  it('guards dirty checkout and preserves branch history across restart', async () => {
    const project = createDemoProject();
    await service.createProject(project);
    await service.createBranch(project.id, 'experiment');
    const initial = await service.status(project.id);
    const clip = project.clips[0];
    if (!clip) throw new Error('Fixture clip missing');
    await service.edit(project.id, { type: 'setClipPreset', clipId: clip.id, preset: 'cool' }, initial.workspaceVersion);

    await expect(service.checkout(project.id, 'experiment')).rejects.toBeInstanceOf(DirtyWorkspaceError);
    const checkedOut = await service.checkout(project.id, 'experiment', true);
    expect(checkedOut.project.clips[0]?.preset).toBe('none');

    const restarted = new ProjectService(root);
    await restarted.verify(project.id);
    expect((await restarted.status(project.id)).branch).toBe('experiment');
  });

  it('replaces the local project from an immutable commit without moving history or deleting media', async () => {
    const project = createDemoProject('Safe local replacement');
    await service.createProject(project);
    const original = await service.status(project.id);
    const [first, second] = project.clips;
    const asset = project.assets[0];
    if (!first || !second || !asset) throw new Error('Fixture is incomplete');
    const mediaPath = path.join(root, 'local-camera.mov');
    await writeFile(mediaPath, 'local-media-must-survive');
    await service.linkMedia(project.id, asset.fingerprint, mediaPath);

    let status = await service.edit(project.id, {
      type: 'setClipPreset', clipId: first.id, preset: 'warm',
    }, original.workspaceVersion);
    status = await stageAll(project.id);
    const committed = await service.commit(project.id, 'Warm current cut', status.headCommit, status.indexDigest);
    status = await service.edit(project.id, {
      type: 'setClipGain', clipId: second.id, gainDb: -6,
    }, committed.workspaceVersion);
    status = await stageAll(project.id);

    await expect(service.restoreRevisionToWorking(
      project.id,
      original.headCommit,
      status.workspaceVersion,
      false,
    )).rejects.toBeInstanceOf(DirtyWorkspaceError);

    const replaced = await service.restoreRevisionToWorking(
      project.id,
      original.headCommit,
      status.workspaceVersion,
      true,
    );
    expect(replaced.headCommit).toBe(committed.headCommit);
    expect(replaced.history.map(({ message }) => message)).toEqual(['Warm current cut', 'Import timeline']);
    expect(replaced.staged).toEqual([]);
    expect(replaced.project).toEqual(project);
    expect(replaced.unstaged).not.toHaveLength(0);
    expect(await service.resolveMediaFile(project.id, asset.fingerprint)).toBe(mediaPath);
  });

  it('creates a real two-parent commit for independent branch edits', async () => {
    const project = createDemoProject();
    await service.createProject(project);
    await service.createBranch(project.id, 'caption-copy');
    const first = project.clips[0];
    const caption = project.captions[0];
    if (!first || !caption) throw new Error('Fixture is incomplete');

    let status = await service.status(project.id);
    status = await service.edit(project.id, { type: 'setClipPreset', clipId: first.id, preset: 'warm' }, status.workspaceVersion);
    status = await stageAll(project.id);
    await service.commit(project.id, 'Warm the opening', status.headCommit, status.indexDigest);

    await service.checkout(project.id, 'caption-copy');
    status = await service.status(project.id);
    status = await service.edit(project.id, { type: 'updateCaption', captionId: caption.id, text: 'Independent copy' }, status.workspaceVersion);
    status = await stageAll(project.id);
    await service.commit(project.id, 'Rewrite caption', status.headCommit, status.indexDigest);
    await service.checkout(project.id, 'main');

    const outcome = await service.merge(project.id, 'main', 'caption-copy');
    expect(outcome.status).toBe('merged');
    if (!outcome.commitId) throw new Error('Merge commit missing');
    const repoPath = path.join(root, 'projects', project.id, 'repo');
    const parents = (await runGit(repoPath, ['show', '--no-patch', '--format=%P', outcome.commitId])).stdout.trim().split(' ');
    expect(parents).toHaveLength(2);
    const merged = await new GitRepository(repoPath).readSnapshot(outcome.commitId);
    expect(merged.clips[0]?.preset).toBe('warm');
    expect(merged.captions[0]?.text).toBe('Independent copy');
  });

  it('persists conflicts, blocks completion, and aborts without moving target', async () => {
    const project = createDemoProject();
    await service.createProject(project);
    await service.createBranch(project.id, 'louder');
    const clip = project.clips[0];
    if (!clip) throw new Error('Fixture clip missing');

    let status = await service.status(project.id);
    status = await service.edit(project.id, { type: 'setClipGain', clipId: clip.id, gainDb: -3 }, status.workspaceVersion);
    status = await stageAll(project.id);
    const main = await service.commit(project.id, 'Main gain', status.headCommit, status.indexDigest);
    await service.checkout(project.id, 'louder');
    status = await service.status(project.id);
    status = await service.edit(project.id, { type: 'setClipGain', clipId: clip.id, gainDb: -9 }, status.workspaceVersion);
    status = await stageAll(project.id);
    await service.commit(project.id, 'Feature gain', status.headCommit, status.indexDigest);
    await service.checkout(project.id, 'main');

    const outcome = await service.merge(project.id, 'main', 'louder');
    expect(outcome.status).toBe('conflicts');
    if (!outcome.session) throw new Error('Merge session missing');
    await expect(service.completeMerge(project.id, outcome.session.id)).rejects.toThrow(/unresolved conflicts/u);
    await service.abortMerge(project.id, outcome.session.id);
    expect((await service.status(project.id)).headCommit).toBe(main.headCommit);
  });

  it('reloads and aborts a persisted merge whose provisional graph is invalid', async () => {
    const project = createDemoProject('Validation conflict');
    await service.createProject(project);
    await service.createBranch(project.id, 'later-cut');
    const repository = new GitRepository(path.join(root, 'projects', project.id, 'repo'));
    const baseCommit = await repository.resolve('HEAD');
    const ours = structuredClone(project);
    const oursAsset = ours.assets[0];
    if (!oursAsset) throw new Error('Fixture asset missing');
    oursAsset.durationFrames = 150;
    const oursCommit = await repository.commitSnapshot(ours, 'Shorter source', [baseCommit], 'main', baseCommit);
    const theirs = structuredClone(project);
    const theirsClip = theirs.clips[0];
    if (!theirsClip) throw new Error('Fixture clip missing');
    theirsClip.sourceRange = { start: 120, duration: 100 };
    await repository.commitSnapshot(theirs, 'Later source range', [baseCommit], 'later-cut', baseCommit);
    await service.checkout(project.id, 'main', true);

    const outcome = await service.merge(project.id, 'main', 'later-cut');
    if (!outcome.session) throw new Error('Expected validation conflict session');
    expect(outcome.session.result.conflicts.some(({ type }) => type === 'validation')).toBe(true);
    const restarted = new ProjectService(root);
    await expect(restarted.abortMerge(project.id, outcome.session.id)).resolves.toBeUndefined();
    expect((await restarted.status(project.id)).headCommit).toBe(oursCommit);
  });

  it('does not overwrite edits made after a merge conflict session opened', async () => {
    const project = createDemoProject('Guard merge workspace');
    await service.createProject(project);
    await service.createBranch(project.id, 'alternate');
    const clip = project.clips[0];
    if (!clip) throw new Error('Fixture clip missing');
    let status = await service.status(project.id);
    status = await service.edit(project.id, { type: 'setClipGain', clipId: clip.id, gainDb: -2 }, status.workspaceVersion);
    status = await stageAll(project.id);
    await service.commit(project.id, 'Target level', status.headCommit, status.indexDigest);
    await service.checkout(project.id, 'alternate');
    status = await service.status(project.id);
    status = await service.edit(project.id, { type: 'setClipGain', clipId: clip.id, gainDb: -8 }, status.workspaceVersion);
    status = await stageAll(project.id);
    await service.commit(project.id, 'Incoming level', status.headCommit, status.indexDigest);
    await service.checkout(project.id, 'main');
    const outcome = await service.merge(project.id, 'main', 'alternate');
    if (!outcome.session) throw new Error('Expected conflict session');
    const conflict = outcome.session.result.conflicts.find(({ type }) => type === 'same-field');
    if (!conflict) throw new Error('Expected level conflict');
    await service.resolveConflict(project.id, outcome.session.id, { conflictId: conflict.id, choice: 'ours' });
    const current = await service.status(project.id);
    const changed = await service.edit(project.id, {
      type: 'setClipPreset', clipId: clip.id, preset: 'mono',
    }, current.workspaceVersion);

    await expect(service.completeMerge(project.id, outcome.session.id)).rejects.toBeInstanceOf(StaleWorkspaceError);
    expect((await service.status(project.id)).project.clips.find(({ id }) => id === clip.id)?.preset).toBe('mono');
    expect((await service.status(project.id)).workspaceVersion).toBe(changed.workspaceVersion);
  });

  it('rejects completion if the target branch moved during conflict resolution', async () => {
    const project = createDemoProject('Stale target');
    await service.createProject(project);
    await service.createBranch(project.id, 'alternate');
    const clip = project.clips[0];
    if (!clip) throw new Error('Fixture clip missing');

    let status = await service.status(project.id);
    status = await service.edit(project.id, { type: 'setClipGain', clipId: clip.id, gainDb: -2 }, status.workspaceVersion);
    status = await stageAll(project.id);
    await service.commit(project.id, 'Target edit', status.headCommit, status.indexDigest);
    await service.checkout(project.id, 'alternate');
    status = await service.status(project.id);
    status = await service.edit(project.id, { type: 'setClipGain', clipId: clip.id, gainDb: -8 }, status.workspaceVersion);
    status = await stageAll(project.id);
    await service.commit(project.id, 'Source edit', status.headCommit, status.indexDigest);
    await service.checkout(project.id, 'main');
    const outcome = await service.merge(project.id, 'main', 'alternate');
    if (!outcome.session) throw new Error('Expected conflict session');
    const conflict = outcome.session.result.conflicts.find(({ type }) => type !== 'validation');
    if (!conflict) throw new Error('Expected semantic conflict');
    await service.resolveConflict(project.id, outcome.session.id, { conflictId: conflict.id, choice: 'ours' });

    const repository = new GitRepository(path.join(root, 'projects', project.id, 'repo'));
    const target = await repository.resolve('refs/heads/main');
    const targetState = await repository.readSnapshot(target);
    const moved = await repository.commitSnapshot(targetState, 'Concurrent target move', [target], 'main', target);
    expect(moved).not.toBe(target);
    await expect(service.completeMerge(project.id, outcome.session.id)).rejects.toBeInstanceOf(StaleWorkspaceError);
  });

  it('exports an immutable commit OTIO and never places footage in Git', async () => {
    const fixture = await readFile(path.join(__dirname, 'fixtures/resolve-basic.otio'), 'utf8');
    const imported = await service.importOtio(fixture);
    // Nothing in the Resolve subset is dropped any more, transitions included.
    expect(imported.unsupported).toEqual([]);
    const status = await service.status(imported.id);
    const exported = await service.exportOtio(imported.id, 'HEAD');
    expect(exported.commitId).toBe(status.headCommit);
    expect(exported.contents).toContain('Timeline.1');
    expect(exported.contents).toContain('file:///Volumes/Edit/opening.mov');
    const repoPath = path.join(root, 'projects', imported.id, 'repo');
    expect((await runGit(repoPath, ['ls-tree', '-r', '--name-only', 'HEAD'])).stdout.trim()).toBe('timeline.json');
    expect((await runGit(repoPath, ['show', 'HEAD:timeline.json'])).stdout).not.toContain('/Volumes/Edit');
    await service.tag(imported.id, 'v1.0', status.headCommit, 'Approved cut');
    expect((await runGit(repoPath, ['cat-file', '-t', 'refs/tags/v1.0'])).stdout.trim()).toBe('tag');
    const taggedExport = await service.exportOtio(imported.id, 'refs/tags/v1.0');
    expect(taggedExport.commitId).toBe(status.headCommit);
  });

  it('detects a changed Resolve export and applies it only to WORKING', async () => {
    const sourcePath = path.join(root, 'resolve.otio');
    const fixture = await readFile(path.join(__dirname, 'fixtures/resolve-basic.otio'), 'utf8');
    await writeFile(sourcePath, fixture);
    const imported = await service.importOtio(fixture, sourcePath);
    const initial = await service.status(imported.id);
    expect(initial.source.state).toBe('watching');

    const changed = JSON.parse(fixture) as {
      tracks: { children: Array<{ children: Array<{ source_range?: { duration: { value: number } } }> }> };
    };
    const first = changed.tracks.children[0]?.children[0];
    if (!first?.source_range) throw new Error('Fixture clip range missing');
    first.source_range.duration.value -= 1;
    await writeFile(sourcePath, JSON.stringify(changed));

    const scanned = await service.scanOtioSource(imported.id);
    expect(scanned.changed).toBe(true);
    expect(scanned.status.source.state).toBe('changes-ready');
    expect(scanned.status.unstaged).toEqual([]);
    const pending = scanned.status.source.pending;
    if (!pending) throw new Error('Pending source update missing');
    const applied = await service.applyPendingSync(imported.id, pending.digest, scanned.status.workspaceVersion);
    expect(applied.source.state).toBe('watching');
    expect(applied.unstaged.some(({ entityType, operation }) => entityType === 'clip' && operation === 'modify')).toBe(true);
    expect((await new GitRepository(path.join(root, 'projects', imported.id, 'repo')).readSnapshot('HEAD')).clips)
      .toEqual(initial.project.clips);
  });

  it('automatically replaces WORKING from a Resolve save and exposes every cumulative HEAD hunk', async () => {
    const fixture = await readFile(path.join(__dirname, 'fixtures/resolve-basic.otio'), 'utf8');
    const imported = await service.importOtio(fixture);
    const initial = await service.status(imported.id);
    const snapshotPath = await service.enableResolveBridge(imported.id, initial.workspaceVersion);
    const changed = JSON.parse(fixture) as {
      tracks: { children: Array<{ children: Array<{ name?: string; source_range?: { duration: { value: number } } }> }> };
    };
    const opening = changed.tracks.children[0]?.children[0];
    if (!opening?.source_range) throw new Error('Fixture clip range missing');
    opening.name = 'Short opening';
    opening.source_range.duration.value -= 4;
    await writeFile(snapshotPath, JSON.stringify(changed));

    expect(await service.applyResolveBridgeSnapshot(imported.id, {
      path: snapshotPath,
      marker: '{"lastModifiedDate":"2026-08-30T00:00:00"}',
      savedAt: '2026-08-29T18:30:00.000Z',
      projectName: 'Resolve Basic Cut',
      timelineName: 'Timeline 1',
    })).toBe(true);
    const status = await service.status(imported.id);
    expect(status.source).toMatchObject({
      mode: 'resolve', state: 'watching', resolveProjectName: 'Resolve Basic Cut', resolveTimelineName: 'Timeline 1',
    });
    expect(status.source.pending).toBeUndefined();
    expect(status.staged).toEqual([]);
    expect(status.unstaged).toHaveLength(2);
    expect(status.workingChanges.map(({ fieldGroup }) => fieldGroup)).toEqual(expect.arrayContaining(['name', 'sourceRange']));
    expect((await new GitRepository(path.join(root, 'projects', imported.id, 'repo')).readSnapshot('HEAD')))
      .toEqual(initial.project);

    const version = status.workspaceVersion;
    expect(await service.applyResolveBridgeSnapshot(imported.id, {
      path: snapshotPath,
      marker: '{"lastModifiedDate":"2026-08-30T00:01:00"}',
      savedAt: '2026-08-29T18:31:00.000Z',
      projectName: 'Resolve Basic Cut',
      timelineName: 'Timeline 1',
    })).toBe(false);
    expect((await service.status(imported.id)).workspaceVersion).toBe(version);
  });

  it('preserves the last good timeline when Resolve leaves an incomplete export', async () => {
    const sourcePath = path.join(root, 'resolve-partial.otio');
    const fixture = await readFile(path.join(__dirname, 'fixtures/resolve-basic.otio'), 'utf8');
    await writeFile(sourcePath, fixture);
    const imported = await service.importOtio(fixture, sourcePath);
    const initial = await service.status(imported.id);

    await writeFile(sourcePath, '{"OTIO_SCHEMA":');
    const invalid = await service.scanOtioSource(imported.id);
    expect(invalid.changed).toBe(false);
    expect(invalid.error).toMatch(/JSON/u);
    expect(invalid.status.source.state).toBe('invalid');
    expect(invalid.status.project).toEqual(initial.project);

    const changed = JSON.parse(fixture) as {
      tracks: { children: Array<{ children: Array<{ source_range?: { duration: { value: number } } }> }> };
    };
    const first = changed.tracks.children[0]?.children[0];
    if (!first?.source_range) throw new Error('Fixture clip range missing');
    first.source_range.duration.value -= 1;
    await writeFile(sourcePath, JSON.stringify(changed));
    const recovered = await service.scanOtioSource(imported.id);
    expect(recovered.changed).toBe(true);
    expect(recovered.status.source.state).toBe('changes-ready');
    expect(recovered.status.source.error).toBeUndefined();
  });

  it('rejects a stale Resolve candidate after the workspace moves', async () => {
    const sourcePath = path.join(root, 'resolve-stale.otio');
    const fixture = await readFile(path.join(__dirname, 'fixtures/resolve-basic.otio'), 'utf8');
    await writeFile(sourcePath, fixture);
    const imported = await service.importOtio(fixture, sourcePath);
    const changed = JSON.parse(fixture) as {
      tracks: { children: Array<{ children: Array<{ source_range?: { duration: { value: number } } }> }> };
    };
    const first = changed.tracks.children[0]?.children[0];
    if (!first?.source_range) throw new Error('Fixture clip range missing');
    first.source_range.duration.value -= 2;
    await writeFile(sourcePath, JSON.stringify(changed));
    const scanned = await service.scanOtioSource(imported.id);
    const pending = scanned.status.source.pending;
    const clip = scanned.status.project.clips[0];
    if (!pending || !clip) throw new Error('Fixture state missing');
    await service.edit(imported.id, { type: 'setClipGain', clipId: clip.id, gainDb: -1 }, scanned.status.workspaceVersion);
    await expect(service.applyPendingSync(imported.id, pending.digest, scanned.status.workspaceVersion))
      .rejects.toThrow(/Workspace changed/u);
  });

  it('guards branch checkout while a Resolve update is pending', async () => {
    const sourcePath = path.join(root, 'resolve-pending.otio');
    const fixture = await readFile(path.join(__dirname, 'fixtures/resolve-basic.otio'), 'utf8');
    await writeFile(sourcePath, fixture);
    const imported = await service.importOtio(fixture, sourcePath);
    await service.createBranch(imported.id, 'alternate');
    const changed = JSON.parse(fixture) as {
      tracks: { children: Array<{ children: Array<{ source_range?: { duration: { value: number } } }> }> };
    };
    const first = changed.tracks.children[0]?.children[0];
    if (!first?.source_range) throw new Error('Fixture clip range missing');
    first.source_range.duration.value -= 3;
    await writeFile(sourcePath, JSON.stringify(changed));
    expect((await service.scanOtioSource(imported.id)).status.source.pending).toBeDefined();

    await expect(service.checkout(imported.id, 'alternate')).rejects.toBeInstanceOf(DirtyWorkspaceError);
    const discarded = await service.checkout(imported.id, 'alternate', true);
    expect(discarded.source.pending).toBeUndefined();
    expect(discarded.branch).toBe('alternate');
  });

  it('loads immutable commit details and starts a clean branch from history', async () => {
    const project = createDemoProject('History preview');
    await service.createProject(project);
    const initial = await service.status(project.id);
    const clip = project.clips[0];
    if (!clip) throw new Error('Fixture clip missing');
    let status = await service.edit(project.id, { type: 'setClipGain', clipId: clip.id, gainDb: -4 }, initial.workspaceVersion);
    status = await stageAll(project.id);
    status = await service.commit(project.id, 'Lower opening audio', status.headCommit, status.indexDigest);

    const details = await service.revisionDetails(project.id, status.headCommit);
    expect(details.diff.some(({ entityType, operation }) => entityType === 'clip' && operation === 'modify')).toBe(true);
    expect(details.preview.commitId).toBe(status.headCommit);
    // Two clips plus the dissolve between them.
    expect(details.preview.segments).toHaveLength(3);

    const branched = await service.createBranchFromRevision(project.id, 'from-import', initial.headCommit);
    expect(branched.branch).toBe('from-import');
    expect(branched.headCommit).toBe(initial.headCommit);
    expect(branched.unstaged).toEqual([]);
  });

  it('keeps media links outside Git while making commit preview segments playable', async () => {
    const project = createDemoProject('Linked preview');
    await service.createProject(project);
    const mediaPath = path.join(root, 'intro.mov');
    await writeFile(mediaPath, 'synthetic-media');
    const asset = project.assets[0];
    if (!asset) throw new Error('Fixture asset missing');
    const details = await service.linkMedia(project.id, asset.fingerprint, mediaPath);
    expect(details.preview.segments[0]?.available).toBe(true);
    expect(await service.resolveMediaFile(project.id, asset.fingerprint)).toBe(mediaPath);
    const repoPath = path.join(root, 'projects', project.id, 'repo');
    expect((await runGit(repoPath, ['show', 'HEAD:timeline.json'])).stdout).not.toContain(mediaPath);
  });

  it('serializes concurrent media relinks without losing either asset', async () => {
    const project = createDemoProject('Concurrent links');
    await service.createProject(project);
    const [first, second] = project.assets;
    if (!first || !second) throw new Error('Fixture assets missing');
    const firstPath = path.join(root, 'first.mov');
    const secondPath = path.join(root, 'second.mov');
    await Promise.all([writeFile(firstPath, 'first'), writeFile(secondPath, 'second')]);

    await Promise.all([
      service.linkMedia(project.id, first.fingerprint, firstPath),
      service.linkMedia(project.id, second.fingerprint, secondPath),
    ]);
    await expect(service.resolveMediaFile(project.id, first.fingerprint)).resolves.toBe(firstPath);
    await expect(service.resolveMediaFile(project.id, second.fingerprint)).resolves.toBe(secondPath);
  });
});

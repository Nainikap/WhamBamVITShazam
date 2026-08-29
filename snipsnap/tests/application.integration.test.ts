import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DirtyWorkspaceError, ProjectService } from '../src/application';
import { createDemoProject } from '../src/domain';
import { GitRepository, StaleRefError, runGit } from '../src/git';

describe('V1 project workflow', () => {
  let root: string;
  let service: ProjectService;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'snipsnap-app-'));
    service = new ProjectService(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function stageAll(projectId: string) {
    const status = await service.status(projectId);
    return service.stage(projectId, status.unstaged.map(({ id }) => id), status.indexDigest);
  }

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

    status = await service.commit(project.id, 'Stage one editorial decision', status.headCommit);
    expect(status.staged).toEqual([]);
    expect(status.unstaged).toHaveLength(1);
    const committed = await new GitRepository(path.join(root, 'projects', project.id, 'repo')).readSnapshot('HEAD');
    const changedClips = committed.clips.filter((clip, index) => JSON.stringify(clip) !== JSON.stringify(project.clips[index]));
    expect(changedClips).toHaveLength(1);
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
    await service.commit(project.id, 'Warm the opening', status.headCommit);

    await service.checkout(project.id, 'caption-copy');
    status = await service.status(project.id);
    status = await service.edit(project.id, { type: 'updateCaption', captionId: caption.id, text: 'Independent copy' }, status.workspaceVersion);
    status = await stageAll(project.id);
    await service.commit(project.id, 'Rewrite caption', status.headCommit);
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
    const main = await service.commit(project.id, 'Main gain', status.headCommit);
    await service.checkout(project.id, 'louder');
    status = await service.status(project.id);
    status = await service.edit(project.id, { type: 'setClipGain', clipId: clip.id, gainDb: -9 }, status.workspaceVersion);
    status = await stageAll(project.id);
    await service.commit(project.id, 'Feature gain', status.headCommit);
    await service.checkout(project.id, 'main');

    const outcome = await service.merge(project.id, 'main', 'louder');
    expect(outcome.status).toBe('conflicts');
    if (!outcome.session) throw new Error('Merge session missing');
    await expect(service.completeMerge(project.id, outcome.session.id)).rejects.toThrow(/unresolved conflicts/u);
    await service.abortMerge(project.id, outcome.session.id);
    expect((await service.status(project.id)).headCommit).toBe(main.headCommit);
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
    await service.commit(project.id, 'Target edit', status.headCommit);
    await service.checkout(project.id, 'alternate');
    status = await service.status(project.id);
    status = await service.edit(project.id, { type: 'setClipGain', clipId: clip.id, gainDb: -8 }, status.workspaceVersion);
    status = await stageAll(project.id);
    await service.commit(project.id, 'Source edit', status.headCommit);
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
    await expect(service.completeMerge(project.id, outcome.session.id)).rejects.toBeInstanceOf(StaleRefError);
  });

  it('exports an immutable commit OTIO and never places footage in Git', async () => {
    const fixture = await readFile(path.join(__dirname, 'fixtures/resolve-basic.otio'), 'utf8');
    const imported = await service.importOtio(fixture);
    expect(imported.unsupported).toHaveLength(1);
    const status = await service.status(imported.id);
    const exported = await service.exportOtio(imported.id, 'HEAD');
    expect(exported.commitId).toBe(status.headCommit);
    expect(exported.contents).toContain('Timeline.1');
    expect(exported.contents).not.toContain('/Volumes/Edit');
    const repoPath = path.join(root, 'projects', imported.id, 'repo');
    expect((await runGit(repoPath, ['ls-tree', '-r', '--name-only', 'HEAD'])).stdout.trim()).toBe('timeline.json');
  });
});

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LanCollaborationService, ProjectService } from '../src/application';
import { createDemoProject } from '../src/domain';

describe('LAN collaboration', () => {
  let root: string;
  let host: ProjectService;
  let peer: ProjectService;
  let hostLan: LanCollaborationService;
  let peerLan: LanCollaborationService;
  let previousResolveDatabase: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'snipsnap-collaboration-'));
    previousResolveDatabase = process.env.SNIPSNAP_RESOLVE_DATABASE;
    process.env.SNIPSNAP_RESOLVE_DATABASE = path.join(root, 'no-resolve-database');
    host = new ProjectService(path.join(root, 'host'));
    peer = new ProjectService(path.join(root, 'peer'));
    hostLan = new LanCollaborationService(path.join(root, 'host'), host);
    peerLan = new LanCollaborationService(path.join(root, 'peer'), peer);
  });

  afterEach(async () => {
    await hostLan.stopHosting();
    await peerLan.stopHosting();
    await rm(root, { recursive: true, force: true });
    if (previousResolveDatabase === undefined) delete process.env.SNIPSNAP_RESOLVE_DATABASE;
    else process.env.SNIPSNAP_RESOLVE_DATABASE = previousResolveDatabase;
  });

  it('clones all Git history, downloads verified media, then pushes and pulls commits', async () => {
    const project = createDemoProject();
    await host.createProject(project, 'Import shared cut');
    const media = path.join(root, 'camera-original.mp4');
    const mediaBytes = Buffer.from('synthetic-video-payload-for-lan-transfer');
    await writeFile(media, mediaBytes);
    const firstAsset = project.assets[0];
    const clip = project.clips[0];
    if (!firstAsset || !clip) throw new Error('Fixture is incomplete');
    await host.linkMedia(project.id, firstAsset.fingerprint, media);

    let hostStatus = await host.status(project.id);
    hostStatus = await host.edit(project.id, {
      type: 'trimClip', clipId: clip.id, start: 8, duration: 120,
    }, hostStatus.workspaceVersion);
    hostStatus = await host.stage(project.id, hostStatus.unstaged.map(({ id }) => id), hostStatus.indexDigest);
    hostStatus = await host.commit(project.id, 'Host trims opening', hostStatus.headCommit);
    await host.createBranch(project.id, 'review', hostStatus.headCommit);

    const hosting = await hostLan.startHosting(project.id);
    expect(hosting.mode).toBe('hosting');
    const joined = await peerLan.join(hosting.inviteCode ?? '');

    expect(joined.status.history.map(({ message }) => message)).toEqual(expect.arrayContaining([
      'Import shared cut',
      'Host trims opening',
    ]));
    expect(joined.status.branches.map(({ name }) => name)).toEqual(expect.arrayContaining(['main', 'review']));
    expect(await peer.listProjectOverviews()).toEqual([
      expect.objectContaining({ id: project.id, kind: 'remote', openable: true }),
    ]);
    const restartedPeer = new ProjectService(path.join(root, 'peer'));
    await expect(restartedPeer.openResolveProjectById(project.id)).resolves.toMatchObject({
      project: { id: project.id },
    });
    const linkedPath = await peer.resolveMediaFile(project.id, firstAsset.fingerprint);
    expect(await readFile(linkedPath)).toEqual(mediaBytes);
    expect((await peer.revisionDetails(project.id, joined.status.headCommit)).preview.missingAssets).not.toContain(firstAsset.fingerprint);

    let peerStatus = await peer.status(project.id);
    peerStatus = await peer.edit(project.id, {
      type: 'setClipGain', clipId: clip.id, gainDb: -4,
    }, peerStatus.workspaceVersion);
    peerStatus = await peer.stage(project.id, peerStatus.unstaged.map(({ id }) => id), peerStatus.indexDigest);
    await peer.commit(project.id, 'Peer balances clip', peerStatus.headCommit);
    const pushed = await peerLan.push(project.id);
    expect((await host.status(project.id)).headCommit).toBe(pushed.status.headCommit);

    hostStatus = await host.status(project.id);
    hostStatus = await host.edit(project.id, {
      type: 'setClipPreset', clipId: clip.id, preset: 'cool',
    }, hostStatus.workspaceVersion);
    hostStatus = await host.stage(project.id, hostStatus.unstaged.map(({ id }) => id), hostStatus.indexDigest);
    hostStatus = await host.commit(project.id, 'Host cools clip', hostStatus.headCommit);
    const pulled = await peerLan.pull(project.id);

    expect(pulled.pull?.fastForwarded).toContain('main');
    expect(pulled.status.headCommit).toBe(hostStatus.headCommit);
    expect(pulled.status.history[0]?.message).toBe('Host cools clip');
  }, 60_000);
});

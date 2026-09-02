import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectService, WebRtcCollaborationService } from '../src/application';
import { createDemoProject } from '../src/domain';
import { WebRtcSignalingServer } from '../src/webrtc';

describe('WebRTC collaboration', () => {
  let root: string;
  let host: ProjectService;
  let peer: ProjectService;
  let secondPeer: ProjectService;
  let hostRtc: WebRtcCollaborationService;
  let peerRtc: WebRtcCollaborationService;
  let secondPeerRtc: WebRtcCollaborationService;
  let signaling: WebRtcSignalingServer;
  let previousResolveDatabase: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'snipsnap-collaboration-'));
    previousResolveDatabase = process.env.SNIPSNAP_RESOLVE_DATABASE;
    process.env.SNIPSNAP_RESOLVE_DATABASE = path.join(root, 'no-resolve-database');
    host = new ProjectService(path.join(root, 'host'));
    peer = new ProjectService(path.join(root, 'peer'));
    secondPeer = new ProjectService(path.join(root, 'second-peer'));
    signaling = new WebRtcSignalingServer({ host: '127.0.0.1', advertisedHost: '127.0.0.1' });
    const { url } = await signaling.listen();
    hostRtc = new WebRtcCollaborationService(path.join(root, 'host'), host, undefined, undefined, { signalingUrl: url });
    peerRtc = new WebRtcCollaborationService(path.join(root, 'peer'), peer);
    secondPeerRtc = new WebRtcCollaborationService(path.join(root, 'second-peer'), secondPeer);
  });

  afterEach(async () => {
    await Promise.all([hostRtc.close(), peerRtc.close(), secondPeerRtc.close()]);
    await signaling.close();
    await rm(root, { recursive: true, force: true });
    if (previousResolveDatabase === undefined) delete process.env.SNIPSNAP_RESOLVE_DATABASE;
    else process.env.SNIPSNAP_RESOLVE_DATABASE = previousResolveDatabase;
  });

  it('lets every project editor clone, pull the latest refs and media, and push over WebRTC', async () => {
    const project = createDemoProject();
    await host.createProject(project, 'Import shared cut');
    const media = path.join(root, 'camera-original.mp4');
    const mediaBytes = Buffer.alloc(200_000, 0x5a);
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
    hostStatus = await host.commit(project.id, 'Host trims opening', hostStatus.headCommit, hostStatus.indexDigest);
    await host.createBranch(project.id, 'review', hostStatus.headCommit);

    const hosting = await hostRtc.startHosting(project.id);
    expect(hosting.mode).toBe('hosting');
    expect(hosting.transport).toBe('webrtc');
    const [joined, secondJoined] = await Promise.all([
      peerRtc.join(hosting.inviteCode ?? ''),
      secondPeerRtc.join(hosting.inviteCode ?? ''),
    ]);
    expect((await hostRtc.status(project.id)).peerCount).toBe(2);

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
    expect(await readFile(await secondPeer.resolveMediaFile(project.id, firstAsset.fingerprint))).toEqual(mediaBytes);
    expect((await peer.revisionDetails(project.id, joined.status.headCommit)).preview.missingAssets).not.toContain(firstAsset.fingerprint);
    expect(secondJoined.status.headCommit).toBe(joined.status.headCommit);

    const secondAsset = project.assets[1];
    if (!secondAsset) throw new Error('Second fixture asset missing');
    const secondMedia = path.join(root, 'late-linked.mp4');
    const secondBytes = Buffer.from('media-linked-after-hosting-started');
    await writeFile(secondMedia, secondBytes);
    await expect(peer.resolveMediaFile(project.id, secondAsset.fingerprint)).rejects.toThrow(/not linked/u);
    await host.linkMedia(project.id, secondAsset.fingerprint, secondMedia);
    await Promise.all([peerRtc.pull(project.id), secondPeerRtc.pull(project.id)]);
    expect(await readFile(await peer.resolveMediaFile(project.id, secondAsset.fingerprint))).toEqual(secondBytes);
    expect(await readFile(await secondPeer.resolveMediaFile(project.id, secondAsset.fingerprint))).toEqual(secondBytes);

    let peerStatus = await peer.status(project.id);
    peerStatus = await peer.edit(project.id, {
      type: 'setClipGain', clipId: clip.id, gainDb: -4,
    }, peerStatus.workspaceVersion);
    peerStatus = await peer.stage(project.id, peerStatus.unstaged.map(({ id }) => id), peerStatus.indexDigest);
    await peer.commit(project.id, 'Peer balances clip', peerStatus.headCommit, peerStatus.indexDigest);
    const pushed = await peerRtc.push(project.id);
    expect((await host.status(project.id)).headCommit).toBe(pushed.status.headCommit);

    hostStatus = await host.status(project.id);
    hostStatus = await host.edit(project.id, {
      type: 'setClipPreset', clipId: clip.id, preset: 'cool',
    }, hostStatus.workspaceVersion);
    hostStatus = await host.stage(project.id, hostStatus.unstaged.map(({ id }) => id), hostStatus.indexDigest);
    hostStatus = await host.commit(project.id, 'Host cools clip', hostStatus.headCommit, hostStatus.indexDigest);
    const [pulled, secondPulled] = await Promise.all([peerRtc.pull(project.id), secondPeerRtc.pull(project.id)]);

    expect(pulled.pull?.fastForwarded).toContain('main');
    expect(pulled.status.headCommit).toBe(hostStatus.headCommit);
    expect(pulled.status.history[0]?.message).toBe('Host cools clip');
    expect(secondPulled.pull?.fastForwarded).toContain('main');
    expect(secondPulled.status.headCommit).toBe(hostStatus.headCommit);
  }, 120_000);
});

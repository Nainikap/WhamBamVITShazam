import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { hostname, networkInterfaces } from 'node:os';
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { RTCPeerConnection, type RTCDataChannel } from 'werift';
import { z } from 'zod';
import {
  IceServersSchema,
  MAX_WEBRTC_RPC_BODY_BYTES,
  WebRtcRpcChannel,
  WebRtcSignalingClient,
  WebRtcSignalingServer,
  parseIceServers,
  type ServerSignal,
  type WebRtcIceServer,
} from '../webrtc';
import { MediaCatalog, MediaStore, SharedMediaManifestSchema, type SharedMediaManifest } from './media-transfer';
import {
  ProjectService,
  SharedProjectDescriptorSchema,
  type ProjectStatus,
  type SharedProjectDescriptor,
  type SharedPullResult,
} from './project-service';
import { atomicWriteJson, readJson } from './storage';

const CONNECTION_TIMEOUT_MS = 30_000;
const PeerNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u);
const SignalUrlSchema = z.string().min(1).max(2_048).refine((value) => {
  try {
    const parsed = new URL(value);
    return ['ws:', 'wss:'].includes(parsed.protocol) && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}, 'WebRTC signaling URL is invalid');

const InviteSchema = z.object({
  version: z.literal(2),
  signalingUrl: SignalUrlSchema,
  roomId: z.string().uuid(),
  secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  projectId: z.string().uuid(),
  hostName: PeerNameSchema,
}).strict();
type Invite = z.infer<typeof InviteSchema>;

const RemoteConfigSchema = InviteSchema.extend({
  peerName: PeerNameSchema,
  heads: z.record(z.string()),
  lastSyncedAt: z.string().datetime().optional(),
}).strict();
type RemoteConfig = z.infer<typeof RemoteConfigSchema>;

export interface CollaborationProgress {
  stage: 'repository' | 'media-manifest' | 'media' | 'complete';
  fileName?: string;
  completedBytes: number;
  totalBytes: number;
  completedFiles: number;
  totalFiles: number;
}

export interface CollaborationStatus {
  mode: 'none' | 'hosting' | 'peer';
  connected: boolean;
  transport?: 'webrtc';
  projectId?: string;
  peerName?: string;
  peerCount?: number;
  inviteCode?: string;
  address?: string;
  lastSyncedAt?: string;
  progress?: CollaborationProgress;
}

export interface CollaborationSyncResult {
  status: ProjectStatus;
  pull?: Omit<SharedPullResult, 'status'>;
  media: CollaborationProgress;
}

interface HostPeer {
  connection: RTCPeerConnection;
  rpc: WebRtcRpcChannel;
}

interface HostSession {
  projectId: string;
  secret: Buffer;
  roomId: string;
  inviteCode: string;
  signalingUrl: string;
  hostName: string;
  signal: WebRtcSignalingClient;
  signalServer?: WebRtcSignalingServer;
  iceServers: WebRtcIceServer[];
  peers: Map<string, HostPeer>;
  manifest?: SharedMediaManifest;
  mediaPaths: Map<string, string>;
}

interface PeerSession {
  projectId: string;
  roomId: string;
  signal: WebRtcSignalingClient;
  connection: RTCPeerConnection;
  rpc: WebRtcRpcChannel;
}

export interface WebRtcCollaborationOptions {
  /** Public WSS endpoint. Omit to run an embedded signaling-only server. */
  signalingUrl?: string;
  iceServers?: WebRtcIceServer[];
  embeddedHost?: string;
  embeddedAdvertisedHost?: string;
}

function peerName(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 64);
  return PeerNameSchema.parse(cleaned || 'snipsnap-peer');
}

function encodeInvite(invite: Invite): string {
  return Buffer.from(JSON.stringify(InviteSchema.parse(invite)), 'utf8').toString('base64url');
}

function decodeInvite(code: string): Invite {
  try {
    return InviteSchema.parse(JSON.parse(Buffer.from(code.trim(), 'base64url').toString('utf8')) as unknown);
  } catch {
    throw new Error('That WebRTC pairing code is invalid');
  }
}

function privateIpv4(): string {
  const candidates = Object.values(networkInterfaces()).flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === 'IPv4' && !entry.internal)
    .map(({ address }) => address);
  return candidates.find((address) => /^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[01])\./u.test(address))
    ?? candidates[0]
    ?? '127.0.0.1';
}

function accessToken(secret: Buffer, roomId: string): string {
  return createHash('sha256')
    .update('snipsnap-webrtc-signaling-v1\0')
    .update(roomId)
    .update(secret)
    .digest('base64url');
}

function projectSecret(invite: Invite): Buffer {
  const secret = Buffer.from(invite.secret, 'base64url');
  if (secret.length !== 32) throw new Error('WebRTC pairing secret is invalid');
  return secret;
}

function json(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), 'utf8');
}

function connection(iceServers: WebRtcIceServer[]): RTCPeerConnection {
  const normalized = IceServersSchema.parse(iceServers).map((server) => ({
    urls: server.urls,
    ...(server.username !== undefined ? { username: server.username } : {}),
    ...(server.credential !== undefined ? { credential: server.credential } : {}),
  }));
  return new RTCPeerConnection({ iceServers: normalized, maxMessageSize: 64 * 1_024 });
}

async function waitForDataChannel(channel: RTCDataChannel): Promise<void> {
  if (channel.readyState === 'open') return;
  const [state] = await channel.stateChanged.watch(
    (candidate) => candidate === 'open' || candidate === 'closed',
    CONNECTION_TIMEOUT_MS,
  );
  if (state !== 'open') throw new Error('WebRTC project channel closed before it was ready');
}

function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), CONNECTION_TIMEOUT_MS);
    promise.then(
      (value) => { clearTimeout(timeout); resolve(value); },
      (error: unknown) => { clearTimeout(timeout); reject(error); },
    );
  });
}

/**
 * Local-first collaboration over WebRTC. The signaling server sees only room
 * membership and SDP; Git bundles and media remain peer-to-peer and are stored
 * only in each editor's existing local repository/CAS.
 */
export class WebRtcCollaborationService {
  private hostSession: HostSession | null = null;

  private readonly peerSessions = new Map<string, PeerSession>();

  private readonly progress = new Map<string, CollaborationProgress>();

  constructor(
    private readonly root: string,
    private readonly projects: ProjectService,
    private readonly changed: (projectId: string) => void = () => undefined,
    private readonly progressChanged: (projectId: string, progress: CollaborationProgress) => void = () => undefined,
    private readonly options: WebRtcCollaborationOptions = {},
  ) {}

  private remotePath(projectId: string): string {
    return path.join(this.root, 'projects', projectId, 'collaboration-remote.json');
  }

  private tempPath(extension: string): string {
    return path.join(this.root, 'collaboration', 'temp', `${randomUUID()}.${extension}`);
  }

  private catalogPath(projectId: string): string {
    return path.join(this.root, 'projects', projectId, 'collaboration-media-catalog.json');
  }

  private mediaStore(): MediaStore {
    return new MediaStore(path.join(this.root, 'media'));
  }

  private updateProgress(projectId: string, value: CollaborationProgress): void {
    this.progress.set(projectId, value);
    this.progressChanged(projectId, value);
  }

  private configuredIceServers(): WebRtcIceServer[] {
    return IceServersSchema.parse(this.options.iceServers ?? parseIceServers());
  }

  private async signalingEndpoint(): Promise<{ url: string; server?: WebRtcSignalingServer }> {
    const configured = this.options.signalingUrl ?? process.env.SNIPSNAP_SIGNALING_URL;
    if (configured) return { url: SignalUrlSchema.parse(configured) };
    const server = new WebRtcSignalingServer({
      host: this.options.embeddedHost ?? '0.0.0.0',
      advertisedHost: this.options.embeddedAdvertisedHost ?? privateIpv4(),
      iceServers: this.configuredIceServers(),
    });
    const { url } = await server.listen();
    return { url, server };
  }

  async startHosting(projectId: string): Promise<CollaborationStatus> {
    await this.stopHosting();
    await this.projects.status(projectId);
    const secret = randomBytes(32);
    const roomId = randomUUID();
    const hostName = peerName(hostname());
    const endpoint = await this.signalingEndpoint();
    const signal = new WebRtcSignalingClient();
    const session: HostSession = {
      projectId,
      secret,
      roomId,
      inviteCode: '',
      signalingUrl: endpoint.url,
      hostName,
      signal,
      ...(endpoint.server ? { signalServer: endpoint.server } : {}),
      iceServers: [],
      peers: new Map(),
      mediaPaths: new Map(),
    };
    signal.onMessage((message) => this.handleHostSignal(session, message));
    try {
      const registered = await signal.connect(endpoint.url, {
        type: 'register',
        role: 'host',
        roomId,
        peerId: randomUUID(),
        accessToken: accessToken(secret, roomId),
      });
      session.iceServers = registered.iceServers;
      session.inviteCode = encodeInvite({
        version: 2,
        signalingUrl: endpoint.url,
        roomId,
        secret: secret.toString('base64url'),
        projectId,
        hostName,
      });
      this.hostSession = session;
      return this.status(projectId);
    } catch (error) {
      signal.close();
      if (endpoint.server) await endpoint.server.close();
      throw error;
    }
  }

  private handleHostSignal(session: HostSession, message: Exclude<ServerSignal, { type: 'registered' }>): void {
    if (message.type === 'peer-ready') {
      void this.offerPeer(session, message.peerId).catch(() => this.removeHostPeer(session, message.peerId));
      return;
    }
    if (message.type === 'answer') {
      const peer = session.peers.get(message.peerId);
      if (peer) void peer.connection.setRemoteDescription(message.description).catch(() => this.removeHostPeer(session, message.peerId));
      return;
    }
    if (message.type === 'peer-left') this.removeHostPeer(session, message.peerId);
  }

  private async offerPeer(session: HostSession, peerId: string): Promise<void> {
    this.removeHostPeer(session, peerId);
    const peerConnection = connection(session.iceServers);
    const channel = peerConnection.createDataChannel('snipsnap-project-v2', { ordered: true });
    const rpc = new WebRtcRpcChannel(channel, session.secret, (request) => this.handleHostRequest(session, request));
    session.peers.set(peerId, { connection: peerConnection, rpc });
    peerConnection.connectionStateChange.subscribe((state) => {
      if (state === 'failed' || state === 'closed') this.removeHostPeer(session, peerId);
      if (state === 'connected') this.changed(session.projectId);
    });
    channel.stateChanged.subscribe((state) => {
      if (state === 'open' || state === 'closed') this.changed(session.projectId);
    });
    await peerConnection.setLocalDescription(await peerConnection.createOffer());
    const description = peerConnection.localDescription;
    if (!description) throw new Error('WebRTC host could not create an offer');
    session.signal.send({
      type: 'offer',
      peerId,
      description: { type: 'offer', sdp: description.sdp },
    });
  }

  private removeHostPeer(session: HostSession, peerId: string): void {
    const peer = session.peers.get(peerId);
    if (!peer) return;
    session.peers.delete(peerId);
    peer.rpc.close();
    void peer.connection.close();
    this.changed(session.projectId);
  }

  async stopHosting(): Promise<void> {
    const session = this.hostSession;
    this.hostSession = null;
    if (!session) return;
    for (const peerId of [...session.peers.keys()]) this.removeHostPeer(session, peerId);
    session.signal.close();
    if (session.signalServer) await session.signalServer.close();
  }

  private async hostManifest(session: HostSession, refresh = false): Promise<SharedMediaManifest> {
    if (session.manifest && !refresh) return session.manifest;
    const sources = await this.projects.sharedMediaSources(session.projectId);
    const manifest = await new MediaCatalog(this.catalogPath(session.projectId)).manifest(sources);
    session.mediaPaths.clear();
    for (const asset of manifest.assets) {
      const source = sources.find(({ fingerprint }) => fingerprint === asset.fingerprint);
      if (source) session.mediaPaths.set(asset.contentHash, source.filePath);
    }
    session.manifest = manifest;
    return manifest;
  }

  private async handleHostRequest(
    session: HostSession,
    request: { method: 'GET' | 'POST'; route: string; body: Buffer },
  ): Promise<Buffer> {
    const url = new URL(request.route, 'https://snipsnap.invalid');
    if (request.method === 'GET' && url.pathname === '/v1/project') {
      return json(await this.projects.sharedProjectDescriptor(session.projectId));
    }
    if (request.method === 'GET' && url.pathname === '/v1/bundle') {
      const bundlePath = this.tempPath('bundle');
      try {
        await this.projects.createSharedBundle(session.projectId, bundlePath);
        return await readFile(bundlePath);
      } finally {
        await rm(bundlePath, { force: true });
      }
    }
    if (request.method === 'GET' && url.pathname === '/v1/media-manifest') {
      return json(await this.hostManifest(session, true));
    }
    const mediaMatch = /^\/v1\/media\/([a-f0-9]{64})\/(\d+)$/u.exec(url.pathname);
    if (request.method === 'GET' && mediaMatch) {
      const [, contentHash, rawIndex] = mediaMatch;
      const index = Number(rawIndex);
      const manifest = await this.hostManifest(session);
      const asset = manifest.assets.find((candidate) => candidate.contentHash === contentHash);
      const filePath = contentHash ? session.mediaPaths.get(contentHash) : undefined;
      if (!asset || !filePath || !Number.isSafeInteger(index) || index < 0 || index >= asset.chunkHashes.length) {
        throw new Error('Unknown media chunk');
      }
      const length = Math.min(asset.chunkBytes, asset.bytes - index * asset.chunkBytes);
      const bytes = Buffer.allocUnsafe(length);
      const handle = await open(filePath, 'r');
      try {
        const result = await handle.read(bytes, 0, length, index * asset.chunkBytes);
        if (result.bytesRead !== length) throw new Error('Media changed during transfer');
      } finally {
        await handle.close();
      }
      return bytes;
    }
    if (request.method === 'POST' && url.pathname === '/v1/push') {
      if (request.body.length > MAX_WEBRTC_RPC_BODY_BYTES) throw new Error('Repository bundle is too large');
      const branch = url.searchParams.get('branch') ?? '';
      const expected = url.searchParams.get('expected');
      const sender = PeerNameSchema.parse(url.searchParams.get('peer'));
      const bundlePath = this.tempPath('bundle');
      try {
        await mkdir(path.dirname(bundlePath), { recursive: true });
        await writeFile(bundlePath, request.body, { mode: 0o600 });
        await this.projects.applySharedPush(session.projectId, bundlePath, sender, branch, expected || null);
      } finally {
        await rm(bundlePath, { force: true });
      }
      delete session.manifest;
      this.changed(session.projectId);
      return json(await this.projects.sharedProjectDescriptor(session.projectId));
    }
    throw new Error('Unknown WebRTC project request');
  }

  private async connectPeer(invite: Invite): Promise<PeerSession> {
    const existing = this.peerSessions.get(invite.projectId);
    if (existing?.roomId === invite.roomId && existing.rpc.isOpen) return existing;
    if (existing) this.closePeer(existing);

    const signal = new WebRtcSignalingClient();
    let resolveOffer: (description: { type: 'offer'; sdp: string }) => void = () => undefined;
    let rejectOffer: (error: Error) => void = () => undefined;
    const offer = new Promise<{ type: 'offer'; sdp: string }>((resolve, reject) => {
      resolveOffer = resolve;
      rejectOffer = reject;
    });
    let active: PeerSession | null = null;
    signal.onMessage((message) => {
      if (message.type === 'offer') resolveOffer(message.description);
      if (message.type === 'host-left') {
        rejectOffer(new Error('The project host went offline'));
        if (active) this.closePeer(active);
      }
      if (message.type === 'error') rejectOffer(new Error(message.message));
    });

    let peerConnection: RTCPeerConnection | null = null;
    try {
      const registered = await signal.connect(invite.signalingUrl, {
        type: 'register',
        role: 'peer',
        roomId: invite.roomId,
        peerId: randomUUID(),
        accessToken: accessToken(projectSecret(invite), invite.roomId),
      });
      const description = await withTimeout(offer, 'Timed out waiting for the project host');
      peerConnection = connection(registered.iceServers);
      const incomingChannel = peerConnection.onDataChannel.asPromise(CONNECTION_TIMEOUT_MS);
      await peerConnection.setRemoteDescription(description);
      await peerConnection.setLocalDescription(await peerConnection.createAnswer());
      const answer = peerConnection.localDescription;
      if (!answer) throw new Error('WebRTC editor could not create an answer');
      signal.send({ type: 'answer', description: { type: 'answer', sdp: answer.sdp } });
      const [channel] = await incomingChannel;
      await waitForDataChannel(channel);
      const rpc = new WebRtcRpcChannel(channel, projectSecret(invite));
      active = { projectId: invite.projectId, roomId: invite.roomId, signal, connection: peerConnection, rpc };
      this.peerSessions.set(invite.projectId, active);
      peerConnection.connectionStateChange.subscribe((state) => {
        if ((state === 'failed' || state === 'closed') && active) this.closePeer(active);
      });
      this.changed(invite.projectId);
      return active;
    } catch (error) {
      signal.close();
      if (peerConnection) await peerConnection.close();
      throw error;
    }
  }

  private closePeer(session: PeerSession): void {
    if (this.peerSessions.get(session.projectId) === session) this.peerSessions.delete(session.projectId);
    session.rpc.close();
    session.signal.close();
    void session.connection.close();
    this.changed(session.projectId);
  }

  private async request(invite: Invite, route: string, method: 'GET' | 'POST' = 'GET', body = Buffer.alloc(0)): Promise<Buffer> {
    return (await this.connectPeer(invite)).rpc.request(route, method, body);
  }

  private async descriptor(invite: Invite): Promise<SharedProjectDescriptor> {
    return SharedProjectDescriptorSchema.parse(
      JSON.parse((await this.request(invite, '/v1/project')).toString('utf8')) as unknown,
    );
  }

  private async bundle(invite: Invite): Promise<string> {
    const bundlePath = this.tempPath('bundle');
    await mkdir(path.dirname(bundlePath), { recursive: true });
    await writeFile(bundlePath, await this.request(invite, '/v1/bundle'), { mode: 0o600 });
    return bundlePath;
  }

  private async synchronizeMedia(projectId: string, invite: Invite): Promise<CollaborationProgress> {
    this.updateProgress(projectId, {
      stage: 'media-manifest', completedBytes: 0, totalBytes: 0, completedFiles: 0, totalFiles: 0,
    });
    const manifest = SharedMediaManifestSchema.parse(
      JSON.parse((await this.request(invite, '/v1/media-manifest')).toString('utf8')) as unknown,
    );
    const store = this.mediaStore();
    const unique = [...new Map(manifest.assets.map((asset) => [asset.contentHash, asset])).values()]
      .sort((left, right) => left.priority.localeCompare(right.priority));
    const totalBytes = unique.reduce((total, asset) => total + asset.bytes, 0);
    let completedBytes = 0;
    let completedFiles = 0;
    for (const asset of unique) {
      if (await store.has(asset.contentHash)) {
        completedBytes += asset.bytes;
        completedFiles += 1;
        continue;
      }
      const missing = await store.missingChunks(asset);
      for (let cursor = 0; cursor < missing.length; cursor += 4) {
        const indexes = missing.slice(cursor, cursor + 4);
        const chunks = await Promise.all(indexes.map(async (index) => ({
          index,
          bytes: await this.request(invite, `/v1/media/${asset.contentHash}/${index}`),
        })));
        for (const chunk of chunks) await store.acceptChunk(asset, chunk.index, chunk.bytes);
        completedBytes += indexes.reduce((total, index) => total
          + Math.min(asset.chunkBytes, asset.bytes - index * asset.chunkBytes), 0);
        this.updateProgress(projectId, {
          stage: 'media', fileName: asset.fileName, completedBytes, totalBytes,
          completedFiles, totalFiles: unique.length,
        });
      }
      completedFiles += 1;
    }
    const links: Record<string, string> = {};
    for (const asset of manifest.assets) links[asset.fingerprint] = store.assetPath(asset.contentHash);
    await this.projects.linkSharedMedia(projectId, links);
    const completed: CollaborationProgress = {
      stage: 'complete', completedBytes: totalBytes, totalBytes,
      completedFiles: unique.length, totalFiles: unique.length,
    };
    this.updateProgress(projectId, completed);
    return completed;
  }

  async join(inviteCode: string): Promise<CollaborationSyncResult> {
    const invite = decodeInvite(inviteCode);
    const descriptor = await this.descriptor(invite);
    if (descriptor.projectId !== invite.projectId) throw new Error('Pairing code project does not match the peer');
    this.updateProgress(descriptor.projectId, {
      stage: 'repository', completedBytes: 0, totalBytes: 0, completedFiles: 0, totalFiles: 0,
    });
    const bundlePath = await this.bundle(invite);
    let pull: SharedPullResult | undefined;
    try {
      const existing = (await this.projects.listProjects()).some(({ id }) => id === descriptor.projectId);
      if (existing) pull = await this.projects.pullSharedBundle(descriptor.projectId, bundlePath, invite.hostName);
      else await this.projects.importSharedProject(descriptor, bundlePath, invite.hostName);
    } finally {
      await rm(bundlePath, { force: true });
    }
    const config: RemoteConfig = {
      ...invite,
      peerName: peerName(hostname()),
      heads: Object.fromEntries(descriptor.branches.map(({ name, commitId }) => [name, commitId])),
      lastSyncedAt: new Date().toISOString(),
    };
    await atomicWriteJson(this.remotePath(descriptor.projectId), config);
    const media = await this.synchronizeMedia(descriptor.projectId, invite);
    this.changed(descriptor.projectId);
    return {
      status: await this.projects.status(descriptor.projectId),
      ...(pull ? { pull: { fastForwarded: pull.fastForwarded, added: pull.added, diverged: pull.diverged } } : {}),
      media,
    };
  }

  private async remote(projectId: string): Promise<RemoteConfig> {
    try {
      return RemoteConfigSchema.parse(await readJson(this.remotePath(projectId)));
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        throw new Error('This project is not connected to a WebRTC peer');
      }
      throw error;
    }
  }

  async pull(projectId: string): Promise<CollaborationSyncResult> {
    const remote = await this.remote(projectId);
    const descriptor = await this.descriptor(remote);
    const bundlePath = await this.bundle(remote);
    let pull: SharedPullResult;
    try {
      pull = await this.projects.pullSharedBundle(projectId, bundlePath, remote.hostName);
    } finally {
      await rm(bundlePath, { force: true });
    }
    await atomicWriteJson(this.remotePath(projectId), {
      ...remote,
      heads: Object.fromEntries(descriptor.branches.map(({ name, commitId }) => [name, commitId])),
      lastSyncedAt: new Date().toISOString(),
    });
    const media = await this.synchronizeMedia(projectId, remote);
    this.changed(projectId);
    return {
      status: await this.projects.status(projectId),
      pull: { fastForwarded: pull.fastForwarded, added: pull.added, diverged: pull.diverged },
      media,
    };
  }

  async push(projectId: string): Promise<CollaborationSyncResult> {
    const remote = await this.remote(projectId);
    const local = await this.projects.sharedProjectDescriptor(projectId);
    const bundlePath = this.tempPath('bundle');
    try {
      await this.projects.createSharedBundle(projectId, bundlePath);
      const route = `/v1/push?branch=${encodeURIComponent(local.branch)}`
        + `&expected=${encodeURIComponent(remote.heads[local.branch] ?? '')}`
        + `&peer=${encodeURIComponent(remote.peerName)}`;
      const descriptor = SharedProjectDescriptorSchema.parse(
        JSON.parse((await this.request(remote, route, 'POST', await readFile(bundlePath))).toString('utf8')) as unknown,
      );
      await atomicWriteJson(this.remotePath(projectId), {
        ...remote,
        heads: Object.fromEntries(descriptor.branches.map(({ name, commitId }) => [name, commitId])),
        lastSyncedAt: new Date().toISOString(),
      });
      const media: CollaborationProgress = {
        stage: 'complete', completedBytes: 0, totalBytes: 0, completedFiles: 0, totalFiles: 0,
      };
      this.updateProgress(projectId, media);
      return { status: await this.projects.status(projectId), media };
    } finally {
      await rm(bundlePath, { force: true });
    }
  }

  async status(projectId?: string): Promise<CollaborationStatus> {
    if (this.hostSession && (!projectId || this.hostSession.projectId === projectId)) {
      const hostProgress = this.progress.get(this.hostSession.projectId);
      const peerCount = [...this.hostSession.peers.values()].filter(({ rpc }) => rpc.isOpen).length;
      return {
        mode: 'hosting',
        connected: this.hostSession.signal.connected,
        transport: 'webrtc',
        projectId: this.hostSession.projectId,
        peerName: this.hostSession.hostName,
        peerCount,
        inviteCode: this.hostSession.inviteCode,
        address: this.hostSession.signalingUrl,
        ...(hostProgress ? { progress: hostProgress } : {}),
      };
    }
    if (!projectId) return { mode: 'none', connected: false };
    try {
      const remote = await this.remote(projectId);
      const peerProgress = this.progress.get(projectId);
      return {
        mode: 'peer',
        connected: this.peerSessions.get(projectId)?.rpc.isOpen ?? false,
        transport: 'webrtc',
        projectId,
        peerName: remote.hostName,
        address: remote.signalingUrl,
        ...(remote.lastSyncedAt ? { lastSyncedAt: remote.lastSyncedAt } : {}),
        ...(peerProgress ? { progress: peerProgress } : {}),
      };
    } catch {
      return { mode: 'none', connected: false, projectId };
    }
  }

  async close(): Promise<void> {
    await this.stopHosting();
    for (const session of [...this.peerSessions.values()]) this.closePeer(session);
  }
}

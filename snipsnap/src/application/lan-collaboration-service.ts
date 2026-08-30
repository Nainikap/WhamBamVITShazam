import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { networkInterfaces, hostname } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { MediaCatalog, MediaStore, SharedMediaManifestSchema, type SharedMediaManifest } from './media-transfer';
import {
  ProjectService,
  SharedProjectDescriptorSchema,
  type ProjectStatus,
  type SharedProjectDescriptor,
  type SharedPullResult,
} from './project-service';
import { atomicWriteJson, readJson } from './storage';

const MAX_BUNDLE_BYTES = 64 * 1_024 * 1_024;
const CLOCK_SKEW_MS = 5 * 60_000;
const PeerSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u);
const InviteSchema = z.object({
  version: z.literal(1),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65_535),
  secret: z.string().min(43).max(64),
  projectId: z.string().uuid(),
  hostName: PeerSchema,
}).strict();
type Invite = z.infer<typeof InviteSchema>;

const RemoteConfigSchema = InviteSchema.extend({
  peerName: PeerSchema,
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
  projectId?: string;
  peerName?: string;
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

interface HostSession {
  projectId: string;
  secret: Buffer;
  inviteCode: string;
  address: string;
  hostName: string;
  server: Server;
  manifest?: SharedMediaManifest;
  mediaPaths: Map<string, string>;
  usedNonces: Map<string, number>;
}

function peerName(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 64);
  return PeerSchema.parse(cleaned || 'snipsnap-peer');
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function encodeInvite(invite: Invite): string {
  return Buffer.from(JSON.stringify(InviteSchema.parse(invite)), 'utf8').toString('base64url');
}

function decodeInvite(code: string): Invite {
  try {
    return InviteSchema.parse(JSON.parse(Buffer.from(code.trim(), 'base64url').toString('utf8')) as unknown);
  } catch {
    throw new Error('That pairing code is invalid');
  }
}

function encrypt(secret: Buffer, route: string, plaintext: Uint8Array): {
  body: Buffer;
  iv: string;
  tag: string;
} {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', secret, iv);
  cipher.setAAD(Buffer.from(route));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { body, iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') };
}

function decrypt(secret: Buffer, route: string, ciphertext: Uint8Array, iv: string, tag: string): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', secret, Buffer.from(iv, 'base64url'));
  decipher.setAAD(Buffer.from(route));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function signature(secret: Buffer, method: string, route: string, timestamp: string, nonce: string, body: Uint8Array): Buffer {
  return createHmac('sha256', secret)
    .update(`${method}\n${route}\n${timestamp}\n${nonce}\n${sha256(body)}`)
    .digest();
}

async function body(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > limit) throw new Error('Request is too large');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function json(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), 'utf8');
}

function privateIpv4(): string {
  const candidates = Object.values(networkInterfaces()).flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === 'IPv4' && !entry.internal)
    .map(({ address }) => address);
  return candidates.find((address) => /^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[01])\./u.test(address))
    ?? candidates[0]
    ?? '127.0.0.1';
}

export class LanCollaborationService {
  private hostSession: HostSession | null = null;

  private readonly progress = new Map<string, CollaborationProgress>();

  constructor(
    private readonly root: string,
    private readonly projects: ProjectService,
    private readonly changed: (projectId: string) => void = () => undefined,
    private readonly progressChanged: (projectId: string, progress: CollaborationProgress) => void = () => undefined,
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

  async startHosting(projectId: string): Promise<CollaborationStatus> {
    await this.stopHosting();
    await this.projects.status(projectId);
    const secret = randomBytes(32);
    const address = privateIpv4();
    const hostName = peerName(hostname());
    const server = createServer();
    const session: HostSession = {
      projectId,
      secret,
      inviteCode: '',
      address,
      hostName,
      server,
      mediaPaths: new Map(),
      usedNonces: new Map(),
    };
    server.on('request', (request, response) => void this.handle(session, request, response));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '0.0.0.0', () => resolve());
    });
    const bound = server.address();
    if (!bound || typeof bound === 'string') throw new Error('Could not start LAN sharing');
    session.inviteCode = encodeInvite({
      version: 1,
      host: address,
      port: bound.port,
      secret: secret.toString('base64url'),
      projectId,
      hostName,
    });
    this.hostSession = session;
    return this.status(projectId);
  }

  async stopHosting(): Promise<void> {
    const session = this.hostSession;
    this.hostSession = null;
    if (!session) return;
    await new Promise<void>((resolve) => session.server.close(() => resolve()));
  }

  private async authenticate(session: HostSession, request: IncomingMessage, requestBody: Buffer): Promise<boolean> {
    const route = request.url ?? '/';
    const timestamp = request.headers['x-snipsnap-time'];
    const nonce = request.headers['x-snipsnap-nonce'];
    const supplied = request.headers['x-snipsnap-signature'];
    if (typeof timestamp !== 'string' || typeof nonce !== 'string' || typeof supplied !== 'string') return false;
    const time = Number(timestamp);
    if (!Number.isFinite(time) || Math.abs(Date.now() - time) > CLOCK_SKEW_MS) return false;
    for (const [used, expires] of session.usedNonces) if (expires < Date.now()) session.usedNonces.delete(used);
    if (session.usedNonces.has(nonce)) return false;
    const expected = signature(session.secret, request.method ?? 'GET', route, timestamp, nonce, requestBody);
    const received = Buffer.from(supplied, 'base64url');
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) return false;
    session.usedNonces.set(nonce, Date.now() + CLOCK_SKEW_MS);
    return true;
  }

  private send(session: HostSession, response: ServerResponse, route: string, value: Uint8Array, status = 200): void {
    const encrypted = encrypt(session.secret, route, value);
    response.writeHead(status, {
      'content-type': 'application/octet-stream',
      'content-length': encrypted.body.length,
      'x-snipsnap-iv': encrypted.iv,
      'x-snipsnap-tag': encrypted.tag,
      'cache-control': 'no-store',
    });
    response.end(encrypted.body);
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

  private async handle(session: HostSession, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const route = request.url ?? '/';
    try {
      const encryptedBody = await body(request, MAX_BUNDLE_BYTES + 1_024);
      if (!await this.authenticate(session, request, encryptedBody)) {
        response.writeHead(401).end('Unauthorized');
        return;
      }
      const url = new URL(route, 'http://snipsnap.local');
      if (request.method === 'GET' && url.pathname === '/v1/project') {
        this.send(session, response, route, json(await this.projects.sharedProjectDescriptor(session.projectId)));
        return;
      }
      if (request.method === 'GET' && url.pathname === '/v1/bundle') {
        const bundlePath = this.tempPath('bundle');
        try {
          await this.projects.createSharedBundle(session.projectId, bundlePath);
          this.send(session, response, route, await readFile(bundlePath));
        } finally {
          await rm(bundlePath, { force: true });
        }
        return;
      }
      if (request.method === 'GET' && url.pathname === '/v1/media-manifest') {
        // Every synchronization starts here. Rebuild so media linked since the
        // previous peer pull is immediately advertised; chunks then stay on
        // this immutable manifest for the duration of that transfer.
        this.send(session, response, route, json(await this.hostManifest(session, true)));
        return;
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
        this.send(session, response, route, bytes);
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/push') {
        const iv = request.headers['x-snipsnap-iv'];
        const tag = request.headers['x-snipsnap-tag'];
        if (typeof iv !== 'string' || typeof tag !== 'string') throw new Error('Encrypted push body is missing');
        const plaintext = decrypt(session.secret, route, encryptedBody, iv, tag);
        if (plaintext.length > MAX_BUNDLE_BYTES) throw new Error('Repository bundle is too large');
        const branch = url.searchParams.get('branch') ?? '';
        const expected = url.searchParams.get('expected');
        const sender = PeerSchema.parse(url.searchParams.get('peer'));
        const bundlePath = this.tempPath('bundle');
        try {
          await mkdir(path.dirname(bundlePath), { recursive: true });
          await writeFile(bundlePath, plaintext, { mode: 0o600 });
          await this.projects.applySharedPush(session.projectId, bundlePath, sender, branch, expected || null);
        } finally {
          await rm(bundlePath, { force: true });
        }
        delete session.manifest;
        this.changed(session.projectId);
        this.send(session, response, route, json(await this.projects.sharedProjectDescriptor(session.projectId)));
        return;
      }
      response.writeHead(404).end('Not found');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.send(session, response, route, json({ error: message }), 400);
    }
  }

  private async request(invite: Invite, route: string, method = 'GET', plaintext = Buffer.alloc(0)): Promise<Buffer> {
    const secret = Buffer.from(invite.secret, 'base64url');
    const encrypted = plaintext.length > 0 ? encrypt(secret, route, plaintext) : null;
    const requestBody = encrypted?.body ?? Buffer.alloc(0);
    const timestamp = String(Date.now());
    const nonce = randomBytes(18).toString('base64url');
    const uploadBody = requestBody.buffer.slice(
      requestBody.byteOffset,
      requestBody.byteOffset + requestBody.byteLength,
    ) as ArrayBuffer;
    const response = await fetch(`http://${invite.host}:${invite.port}${route}`, {
      method,
      headers: {
        'x-snipsnap-time': timestamp,
        'x-snipsnap-nonce': nonce,
        'x-snipsnap-signature': signature(secret, method, route, timestamp, nonce, requestBody).toString('base64url'),
        ...(encrypted ? { 'x-snipsnap-iv': encrypted.iv, 'x-snipsnap-tag': encrypted.tag } : {}),
      },
      ...(requestBody.length > 0 ? { body: uploadBody } : {}),
    });
    const ciphertext = Buffer.from(await response.arrayBuffer());
    const iv = response.headers.get('x-snipsnap-iv');
    const tag = response.headers.get('x-snipsnap-tag');
    if (!iv || !tag) throw new Error(`Peer returned an unencrypted response (${response.status})`);
    const output = decrypt(secret, route, ciphertext, iv, tag);
    if (!response.ok) {
      const parsed = z.object({ error: z.string() }).safeParse(JSON.parse(output.toString('utf8')) as unknown);
      throw new Error(parsed.success ? parsed.data.error : `Peer request failed (${response.status})`);
    }
    return output;
  }

  private async descriptor(invite: Invite): Promise<SharedProjectDescriptor> {
    return SharedProjectDescriptorSchema.parse(JSON.parse((await this.request(invite, '/v1/project')).toString('utf8')) as unknown);
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
        const received = indexes.reduce((total, index) => total
          + Math.min(asset.chunkBytes, asset.bytes - index * asset.chunkBytes), 0);
        completedBytes += received;
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
    const progress: CollaborationProgress = {
      stage: 'complete', completedBytes: totalBytes, totalBytes,
      completedFiles: unique.length, totalFiles: unique.length,
    };
    this.updateProgress(projectId, progress);
    return progress;
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
      if (existing) {
        pull = await this.projects.pullSharedBundle(descriptor.projectId, bundlePath, invite.hostName);
      } else {
        await this.projects.importSharedProject(descriptor, bundlePath, invite.hostName);
      }
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
        throw new Error('This project is not connected to a peer');
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
    const next = { ...remote, heads: Object.fromEntries(descriptor.branches.map(({ name, commitId }) => [name, commitId])), lastSyncedAt: new Date().toISOString() };
    await atomicWriteJson(this.remotePath(projectId), next);
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
      const next = {
        ...remote,
        heads: Object.fromEntries(descriptor.branches.map(({ name, commitId }) => [name, commitId])),
        lastSyncedAt: new Date().toISOString(),
      };
      await atomicWriteJson(this.remotePath(projectId), next);
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
      return {
        mode: 'hosting', connected: true, projectId: this.hostSession.projectId,
        peerName: this.hostSession.hostName, inviteCode: this.hostSession.inviteCode,
        address: this.hostSession.address,
        ...(hostProgress ? { progress: hostProgress } : {}),
      };
    }
    if (!projectId) return { mode: 'none', connected: false };
    try {
      const remote = await this.remote(projectId);
      const peerProgress = this.progress.get(projectId);
      return {
        mode: 'peer', connected: true, projectId, peerName: remote.hostName,
        address: remote.host,
        ...(remote.lastSyncedAt ? { lastSyncedAt: remote.lastSyncedAt } : {}),
        ...(peerProgress ? { progress: peerProgress } : {}),
      };
    } catch {
      return { mode: 'none', connected: false, projectId };
    }
  }
}

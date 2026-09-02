import { createServer, type Server } from 'node:http';
import { z } from 'zod';
import Ws, { WebSocketServer, type RawData } from 'ws';

const MAX_SIGNAL_BYTES = 1_024 * 1_024;
const SIGNAL_TIMEOUT_MS = 20_000;
const HEARTBEAT_MS = 30_000;

const WebRtcUrlSchema = z.string().min(1).max(2_048).refine((value) => {
  try {
    const parsed = new URL(value);
    return ['stun:', 'stuns:', 'turn:', 'turns:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}, 'ICE server URLs must use STUN or TURN');

export const IceServerSchema = z.object({
  urls: z.union([WebRtcUrlSchema, z.array(WebRtcUrlSchema).min(1).max(8)]),
  username: z.string().max(512).optional(),
  credential: z.string().max(512).optional(),
}).strict();

export const IceServersSchema = z.array(IceServerSchema).max(16);
export type WebRtcIceServer = z.infer<typeof IceServerSchema>;

const SignalUrlSchema = z.string().min(1).max(2_048).transform((value, context) => {
  try {
    const parsed = new URL(value);
    if (!['ws:', 'wss:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error();
    return parsed.toString();
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Signaling URL must be a ws:// or wss:// URL' });
    return z.NEVER;
  }
});

const RoomIdSchema = z.string().uuid();
const PeerIdSchema = z.string().uuid();
const AccessTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43,128}$/u);
const SessionDescriptionSchema = z.object({
  type: z.enum(['offer', 'answer']),
  sdp: z.string().min(1).max(MAX_SIGNAL_BYTES - 1_024),
}).strict();

const RegistrationSchema = z.object({
  type: z.literal('register'),
  roomId: RoomIdSchema,
  peerId: PeerIdSchema,
  role: z.enum(['host', 'peer']),
  accessToken: AccessTokenSchema,
}).strict();

const HostOfferSchema = z.object({
  type: z.literal('offer'),
  peerId: PeerIdSchema,
  description: SessionDescriptionSchema.extend({ type: z.literal('offer') }),
}).strict();

const PeerAnswerSchema = z.object({
  type: z.literal('answer'),
  description: SessionDescriptionSchema.extend({ type: z.literal('answer') }),
}).strict();

const ClientSignalSchema = z.discriminatedUnion('type', [RegistrationSchema, HostOfferSchema, PeerAnswerSchema]);
export type SignalRegistration = z.infer<typeof RegistrationSchema>;
type ClientSignal = z.infer<typeof ClientSignalSchema>;

const RegisteredSchema = z.object({
  type: z.literal('registered'),
  iceServers: IceServersSchema,
}).strict();

const ServerSignalSchema = z.discriminatedUnion('type', [
  RegisteredSchema,
  z.object({ type: z.literal('peer-ready'), peerId: PeerIdSchema }).strict(),
  z.object({
    type: z.literal('offer'),
    description: SessionDescriptionSchema.extend({ type: z.literal('offer') }),
  }).strict(),
  z.object({
    type: z.literal('answer'),
    peerId: PeerIdSchema,
    description: SessionDescriptionSchema.extend({ type: z.literal('answer') }),
  }).strict(),
  z.object({ type: z.literal('peer-left'), peerId: PeerIdSchema }).strict(),
  z.object({ type: z.literal('host-left') }).strict(),
  z.object({ type: z.literal('error'), message: z.string().min(1).max(500) }).strict(),
]);

export type ServerSignal = z.infer<typeof ServerSignalSchema>;
export type RegisteredSignal = z.infer<typeof RegisteredSchema>;

interface ConnectionIdentity {
  roomId: string;
  peerId: string;
  role: 'host' | 'peer';
}

interface SignalingRoom {
  accessToken: string;
  host: Ws;
  peers: Map<string, Ws>;
}

function signalText(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
}

function send(socket: Ws, message: ServerSignal): void {
  if (socket.readyState === Ws.OPEN) socket.send(JSON.stringify(ServerSignalSchema.parse(message)));
}

export function parseIceServers(value = process.env.SNIPSNAP_ICE_SERVERS_JSON): WebRtcIceServer[] {
  if (!value?.trim()) return [];
  try {
    return IceServersSchema.parse(JSON.parse(value) as unknown);
  } catch {
    throw new Error('SNIPSNAP_ICE_SERVERS_JSON must be a valid JSON array of STUN/TURN server settings');
  }
}

export interface WebRtcSignalingServerOptions {
  host?: string;
  port?: number;
  path?: string;
  advertisedHost?: string;
  iceServers?: WebRtcIceServer[];
}

/**
 * Ephemeral WebRTC signaling only. Project history and media never pass through
 * this server; after SDP exchange, editors communicate over RTCDataChannel.
 */
export class WebRtcSignalingServer {
  private readonly http: Server;

  private readonly sockets: WebSocketServer;

  private readonly rooms = new Map<string, SignalingRoom>();

  private readonly identities = new WeakMap<Ws, ConnectionIdentity>();

  private heartbeat: NodeJS.Timeout | null = null;

  private listening = false;

  constructor(private readonly options: WebRtcSignalingServerOptions = {}) {
    const signalPath = options.path ?? '/signal';
    const iceServers = IceServersSchema.parse(options.iceServers ?? []);
    this.http = createServer((request, response) => {
      const pathname = new URL(request.url ?? '/', 'http://snipsnap.invalid').pathname;
      if (request.method === 'GET' && pathname === '/healthz') {
        response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        response.end(JSON.stringify({ ok: true, rooms: this.rooms.size }));
        return;
      }
      response.writeHead(404).end('Not found');
    });
    this.sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_SIGNAL_BYTES, perMessageDeflate: false });
    this.http.on('upgrade', (request, socket, head) => {
      const pathname = new URL(request.url ?? '/', 'http://snipsnap.invalid').pathname;
      if (pathname !== signalPath) {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }
      this.sockets.handleUpgrade(request, socket, head, (client) => this.sockets.emit('connection', client, request));
    });
    this.sockets.on('connection', (socket) => {
      let alive = true;
      socket.on('pong', () => { alive = true; });
      socket.on('message', (data, binary) => {
        if (binary) {
          send(socket, { type: 'error', message: 'Signaling messages must be JSON' });
          return;
        }
        try {
          this.handle(socket, ClientSignalSchema.parse(JSON.parse(signalText(data)) as unknown), iceServers);
        } catch (error) {
          send(socket, { type: 'error', message: error instanceof Error ? error.message : 'Invalid signaling message' });
        }
      });
      socket.on('close', () => this.remove(socket));
      socket.on('error', () => this.remove(socket));
      Object.defineProperty(socket, '__snipsnapHeartbeat', {
        get: () => alive,
        set: (value: boolean) => { alive = value; },
      });
    });
  }

  private handle(socket: Ws, message: ClientSignal, iceServers: WebRtcIceServer[]): void {
    const identity = this.identities.get(socket);
    if (!identity) {
      if (message.type !== 'register') throw new Error('Register before sending signaling messages');
      this.register(socket, message, iceServers);
      return;
    }
    if (message.type === 'register') throw new Error('This signaling connection is already registered');
    const room = this.rooms.get(identity.roomId);
    if (!room) throw new Error('The project host is no longer online');
    if (identity.role === 'host' && message.type === 'offer') {
      const peer = room.peers.get(message.peerId);
      if (!peer) throw new Error('That editor is no longer connected');
      send(peer, { type: 'offer', description: message.description });
      return;
    }
    if (identity.role === 'peer' && message.type === 'answer') {
      send(room.host, { type: 'answer', peerId: identity.peerId, description: message.description });
      return;
    }
    throw new Error('That signaling message is not allowed for this connection');
  }

  private register(socket: Ws, registration: SignalRegistration, iceServers: WebRtcIceServer[]): void {
    if (registration.role === 'host') {
      if (this.rooms.has(registration.roomId)) throw new Error('That project room is already hosted');
      this.rooms.set(registration.roomId, {
        accessToken: registration.accessToken,
        host: socket,
        peers: new Map(),
      });
    } else {
      const room = this.rooms.get(registration.roomId);
      if (!room || room.accessToken !== registration.accessToken) throw new Error('The project invite is invalid or offline');
      if (room.peers.has(registration.peerId)) throw new Error('That editor connection is already registered');
      room.peers.set(registration.peerId, socket);
    }
    this.identities.set(socket, {
      roomId: registration.roomId,
      peerId: registration.peerId,
      role: registration.role,
    });
    send(socket, { type: 'registered', iceServers });
    if (registration.role === 'peer') {
      const room = this.rooms.get(registration.roomId);
      if (room) send(room.host, { type: 'peer-ready', peerId: registration.peerId });
    }
  }

  private remove(socket: Ws): void {
    const identity = this.identities.get(socket);
    if (!identity) return;
    this.identities.delete(socket);
    const room = this.rooms.get(identity.roomId);
    if (!room) return;
    if (identity.role === 'host') {
      for (const peer of room.peers.values()) send(peer, { type: 'host-left' });
      this.rooms.delete(identity.roomId);
      return;
    }
    if (room.peers.get(identity.peerId) === socket) {
      room.peers.delete(identity.peerId);
      send(room.host, { type: 'peer-left', peerId: identity.peerId });
    }
  }

  async listen(): Promise<{ url: string; port: number }> {
    if (this.listening) throw new Error('WebRTC signaling server is already listening');
    const host = this.options.host ?? '127.0.0.1';
    const port = this.options.port ?? 0;
    await new Promise<void>((resolve, reject) => {
      const fail = (error: Error) => reject(error);
      this.http.once('error', fail);
      this.http.listen(port, host, () => {
        this.http.removeListener('error', fail);
        resolve();
      });
    });
    const address = this.http.address();
    if (!address || typeof address === 'string') throw new Error('Could not start WebRTC signaling');
    this.listening = true;
    this.heartbeat = setInterval(() => {
      for (const socket of this.sockets.clients) {
        const tracked = socket as Ws & { __snipsnapHeartbeat?: boolean };
        if (tracked.__snipsnapHeartbeat === false) {
          socket.terminate();
          continue;
        }
        tracked.__snipsnapHeartbeat = false;
        socket.ping();
      }
    }, HEARTBEAT_MS);
    this.heartbeat.unref();
    const advertisedHost = this.options.advertisedHost ?? (host === '0.0.0.0' ? '127.0.0.1' : host);
    const signalPath = this.options.path ?? '/signal';
    return { url: SignalUrlSchema.parse(`ws://${advertisedHost}:${address.port}${signalPath}`), port: address.port };
  }

  async close(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const socket of this.sockets.clients) socket.terminate();
    this.rooms.clear();
    await new Promise<void>((resolve) => this.sockets.close(() => resolve()));
    if (this.listening) await new Promise<void>((resolve) => this.http.close(() => resolve()));
    this.listening = false;
  }
}

export class WebRtcSignalingClient {
  private socket: Ws | null = null;

  private readonly listeners = new Set<(message: Exclude<ServerSignal, RegisteredSignal>) => void>();

  get connected(): boolean {
    return this.socket?.readyState === Ws.OPEN;
  }

  onMessage(listener: (message: Exclude<ServerSignal, RegisteredSignal>) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async connect(urlValue: string, registrationValue: SignalRegistration): Promise<RegisteredSignal> {
    if (this.socket) throw new Error('WebRTC signaling client is already connected');
    const url = SignalUrlSchema.parse(urlValue);
    const registration = RegistrationSchema.parse(registrationValue);
    const socket = new Ws(url, { perMessageDeflate: false, maxPayload: MAX_SIGNAL_BYTES });
    this.socket = socket;
    return new Promise<RegisteredSignal>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (!settled) reject(new Error('Timed out connecting to the WebRTC signaling server'));
        socket.terminate();
      }, SIGNAL_TIMEOUT_MS);
      const finishError = (error: Error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(error);
        }
      };
      socket.once('open', () => socket.send(JSON.stringify(registration)));
      socket.on('message', (data, binary) => {
        try {
          if (binary) throw new Error('Signaling server returned a binary message');
          const message = ServerSignalSchema.parse(JSON.parse(signalText(data)) as unknown);
          if (message.type === 'registered') {
            if (!settled) {
              settled = true;
              clearTimeout(timeout);
              resolve(message);
            }
            return;
          }
          if (message.type === 'error' && !settled) {
            finishError(new Error(message.message));
            return;
          }
          for (const listener of this.listeners) listener(message);
        } catch (error) {
          finishError(error instanceof Error ? error : new Error('Invalid signaling response'));
        }
      });
      socket.once('error', (error) => finishError(error));
      socket.once('close', () => finishError(new Error('WebRTC signaling connection closed')));
    });
  }

  send(messageValue: Exclude<ClientSignal, SignalRegistration>): void {
    const message = ClientSignalSchema.parse(messageValue);
    if (!this.socket || this.socket.readyState !== Ws.OPEN) throw new Error('WebRTC signaling is disconnected');
    this.socket.send(JSON.stringify(message));
  }

  close(): void {
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    if (socket.readyState === Ws.CONNECTING || socket.readyState === Ws.OPEN) socket.close();
  }
}

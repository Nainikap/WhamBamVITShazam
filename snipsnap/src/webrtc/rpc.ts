import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { RTCDataChannel } from 'werift';

const FRAME_BYTES = 16 * 1_024;
const FRAME_HEADER_BYTES = 21;
const HIGH_WATER_BYTES = 2 * 1_024 * 1_024;
const LOW_WATER_BYTES = 512 * 1_024;
const OPEN_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 10 * 60_000;
export const MAX_WEBRTC_RPC_BODY_BYTES = 64 * 1_024 * 1_024;

const EncodedSchema = {
  id: z.string().uuid(),
  iv: z.string().regex(/^[A-Za-z0-9_-]{16}$/u),
  tag: z.string().regex(/^[A-Za-z0-9_-]{22}$/u),
  byteLength: z.number().int().safe().min(0).max(MAX_WEBRTC_RPC_BODY_BYTES),
};

const RequestStartSchema = z.object({
  protocol: z.literal('snipsnap-webrtc-rpc-v1'),
  kind: z.literal('request'),
  ...EncodedSchema,
  method: z.enum(['GET', 'POST']),
  route: z.string().min(1).max(2_048).startsWith('/v1/'),
}).strict();

const ResponseStartSchema = z.object({
  protocol: z.literal('snipsnap-webrtc-rpc-v1'),
  kind: z.literal('response'),
  ...EncodedSchema,
  ok: z.boolean(),
}).strict();

const StartSchema = z.discriminatedUnion('kind', [RequestStartSchema, ResponseStartSchema]);
type RequestStart = z.infer<typeof RequestStartSchema>;
type ResponseStart = z.infer<typeof ResponseStartSchema>;
type Start = z.infer<typeof StartSchema>;

export interface WebRtcRpcRequest {
  method: 'GET' | 'POST';
  route: string;
  body: Buffer;
}

export type WebRtcRpcHandler = (request: WebRtcRpcRequest) => Promise<Buffer>;

interface Assembly<T extends Start> {
  start: T;
  body: Buffer;
  nextIndex: number;
  receivedBytes: number;
}

interface PendingResponse {
  route: string;
  resolve(value: Buffer): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
}

function uuidBytes(id: string): Buffer {
  return Buffer.from(id.replace(/-/gu, ''), 'hex');
}

function uuidFromBytes(bytes: Buffer): string {
  const value = bytes.toString('hex');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function seal(secret: Buffer, aad: string, plaintext: Buffer): { body: Buffer; iv: string; tag: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', secret, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { body, iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') };
}

function open(secret: Buffer, aad: string, encrypted: { body: Buffer; iv: string; tag: string }): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', secret, Buffer.from(encrypted.iv, 'base64url'));
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64url'));
  return Buffer.concat([decipher.update(encrypted.body), decipher.final()]);
}

function errorBody(error: unknown): Buffer {
  const message = error instanceof Error ? error.message : String(error);
  return Buffer.from(JSON.stringify({ error: message.slice(0, 500) }), 'utf8');
}

function readError(bytes: Buffer): Error {
  try {
    const parsed = z.object({ error: z.string().min(1).max(500) }).parse(JSON.parse(bytes.toString('utf8')) as unknown);
    return new Error(parsed.error);
  } catch {
    return new Error('The remote editor could not complete the WebRTC request');
  }
}

/** Bounded request/response framing over one ordered RTCDataChannel. */
export class WebRtcRpcChannel {
  private readonly requestAssemblies = new Map<string, Assembly<RequestStart>>();

  private readonly responseAssemblies = new Map<string, Assembly<ResponseStart>>();

  private readonly pending = new Map<string, PendingResponse>();

  private readonly seenRequests = new Set<string>();

  private sendChain = Promise.resolve();

  private failed: Error | null = null;

  constructor(
    private readonly channel: RTCDataChannel,
    private readonly secret: Buffer,
    private readonly handler?: WebRtcRpcHandler,
  ) {
    if (secret.length !== 32) throw new Error('WebRTC project secret must be 256 bits');
    channel.bufferedAmountLowThreshold = LOW_WATER_BYTES;
    channel.onMessage.subscribe((message) => {
      void this.receive(message).catch((error: unknown) => this.fail(error));
    });
    channel.error.subscribe((error) => this.fail(error));
    channel.stateChanged.subscribe((state) => {
      if (state === 'closed') this.fail(new Error('WebRTC project channel closed'));
    });
  }

  get isOpen(): boolean {
    return !this.failed && this.channel.readyState === 'open';
  }

  private async waitForOpen(): Promise<void> {
    if (this.failed) throw this.failed;
    if (this.channel.readyState === 'open') return;
    if (this.channel.readyState !== 'connecting') throw new Error('WebRTC project channel is not available');
    const [state] = await this.channel.stateChanged.watch(
      (candidate) => candidate === 'open' || candidate === 'closed',
      OPEN_TIMEOUT_MS,
    );
    if (state !== 'open') throw new Error('WebRTC project channel closed before it opened');
  }

  private async waitForWritable(): Promise<void> {
    while (this.channel.bufferedAmount > HIGH_WATER_BYTES) {
      if (this.failed) throw this.failed;
      await this.channel.bufferedAmountLow.asPromise(30_000);
    }
  }

  private enqueue(start: Start, body: Buffer, frameType: 1 | 2): Promise<void> {
    const operation = this.sendChain.then(async () => {
      await this.waitForOpen();
      this.channel.send(JSON.stringify(start));
      const id = uuidBytes(start.id);
      let index = 0;
      for (let offset = 0; offset < body.length; offset += FRAME_BYTES) {
        await this.waitForWritable();
        const payload = body.subarray(offset, Math.min(body.length, offset + FRAME_BYTES));
        const frame = Buffer.allocUnsafe(FRAME_HEADER_BYTES + payload.length);
        frame.writeUInt8(frameType, 0);
        id.copy(frame, 1);
        frame.writeUInt32BE(index, 17);
        payload.copy(frame, FRAME_HEADER_BYTES);
        this.channel.send(frame);
        index += 1;
      }
    });
    this.sendChain = operation.catch(() => undefined);
    return operation;
  }

  async request(route: string, method: 'GET' | 'POST' = 'GET', plaintext = Buffer.alloc(0)): Promise<Buffer> {
    if (plaintext.length > MAX_WEBRTC_RPC_BODY_BYTES) throw new Error('WebRTC request body is too large');
    const id = randomUUID();
    const encrypted = seal(this.secret, `request:${id}:${method}:${route}`, plaintext);
    const start = RequestStartSchema.parse({
      protocol: 'snipsnap-webrtc-rpc-v1',
      kind: 'request',
      id,
      method,
      route,
      iv: encrypted.iv,
      tag: encrypted.tag,
      byteLength: encrypted.body.length,
    });
    const response = new Promise<Buffer>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Timed out waiting for the remote editor'));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { route, resolve, reject, timeout });
    });
    try {
      await this.enqueue(start, encrypted.body, 1);
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pending.delete(id);
        pending.reject(error instanceof Error ? error : new Error('Could not send WebRTC request'));
      }
    }
    return response;
  }

  private async receive(message: string | Buffer): Promise<void> {
    if (typeof message === 'string') {
      const start = StartSchema.parse(JSON.parse(message) as unknown);
      if (start.kind === 'request') {
        if (this.requestAssemblies.has(start.id) || this.seenRequests.has(start.id)) throw new Error('Duplicate WebRTC request');
        this.requestAssemblies.set(start.id, {
          start,
          body: Buffer.allocUnsafe(start.byteLength),
          nextIndex: 0,
          receivedBytes: 0,
        });
        if (start.byteLength === 0) await this.completeRequest(start.id);
      } else {
        if (!this.pending.has(start.id) || this.responseAssemblies.has(start.id)) throw new Error('Unexpected WebRTC response');
        this.responseAssemblies.set(start.id, {
          start,
          body: Buffer.allocUnsafe(start.byteLength),
          nextIndex: 0,
          receivedBytes: 0,
        });
        if (start.byteLength === 0) this.completeResponse(start.id);
      }
      return;
    }
    if (message.length < FRAME_HEADER_BYTES) throw new Error('WebRTC data frame is truncated');
    const frameType = message.readUInt8(0);
    if (frameType !== 1 && frameType !== 2) throw new Error('WebRTC data frame type is invalid');
    const id = uuidFromBytes(message.subarray(1, 17));
    const index = message.readUInt32BE(17);
    const assembly = frameType === 1 ? this.requestAssemblies.get(id) : this.responseAssemblies.get(id);
    if (!assembly || index !== assembly.nextIndex) throw new Error('WebRTC data frames arrived out of order');
    const payload = message.subarray(FRAME_HEADER_BYTES);
    const remaining = assembly.body.length - assembly.receivedBytes;
    const expected = Math.min(FRAME_BYTES, remaining);
    if (payload.length !== expected) throw new Error('WebRTC data frame has an invalid length');
    payload.copy(assembly.body, assembly.receivedBytes);
    assembly.receivedBytes += payload.length;
    assembly.nextIndex += 1;
    if (assembly.receivedBytes === assembly.body.length) {
      if (frameType === 1) await this.completeRequest(id);
      else this.completeResponse(id);
    }
  }

  private async completeRequest(id: string): Promise<void> {
    const assembly = this.requestAssemblies.get(id);
    if (!assembly) throw new Error('WebRTC request assembly is missing');
    this.requestAssemblies.delete(id);
    this.seenRequests.add(id);
    if (this.seenRequests.size > 10_000) this.seenRequests.delete(this.seenRequests.values().next().value as string);
    const { start } = assembly;
    let ok = true;
    let response: Buffer;
    try {
      if (!this.handler) throw new Error('This editor does not host project requests');
      const body = open(this.secret, `request:${id}:${start.method}:${start.route}`, {
        body: assembly.body,
        iv: start.iv,
        tag: start.tag,
      });
      response = await this.handler({ method: start.method, route: start.route, body });
      if (response.length > MAX_WEBRTC_RPC_BODY_BYTES) throw new Error('WebRTC response body is too large');
    } catch (error) {
      ok = false;
      response = errorBody(error);
    }
    const encrypted = seal(this.secret, `response:${id}:${start.route}`, response);
    const responseStart = ResponseStartSchema.parse({
      protocol: 'snipsnap-webrtc-rpc-v1',
      kind: 'response',
      id,
      ok,
      iv: encrypted.iv,
      tag: encrypted.tag,
      byteLength: encrypted.body.length,
    });
    await this.enqueue(responseStart, encrypted.body, 2);
  }

  private completeResponse(id: string): void {
    const assembly = this.responseAssemblies.get(id);
    const pending = this.pending.get(id);
    if (!assembly || !pending) throw new Error('WebRTC response state is missing');
    this.responseAssemblies.delete(id);
    this.pending.delete(id);
    clearTimeout(pending.timeout);
    try {
      const response = open(this.secret, `response:${id}:${pending.route}`, {
        body: assembly.body,
        iv: assembly.start.iv,
        tag: assembly.start.tag,
      });
      if (assembly.start.ok) pending.resolve(response);
      else pending.reject(readError(response));
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error('WebRTC response authentication failed'));
    }
  }

  private fail(error: unknown): void {
    if (this.failed) return;
    this.failed = error instanceof Error ? error : new Error('WebRTC project channel failed');
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(this.failed);
    }
    this.pending.clear();
    this.requestAssemblies.clear();
    this.responseAssemblies.clear();
  }

  close(): void {
    this.fail(new Error('WebRTC project channel closed'));
    if (this.channel.readyState !== 'closed') this.channel.close();
  }
}

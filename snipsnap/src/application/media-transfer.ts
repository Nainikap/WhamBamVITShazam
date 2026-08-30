import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, open, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { atomicWriteJson, readJson } from './storage';

export const DEFAULT_MEDIA_CHUNK_BYTES = 8 * 1_024 * 1_024;

const HashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const SharedMediaAssetSchema = z.object({
  fingerprint: HashSchema,
  contentHash: HashSchema,
  fileName: z.string().min(1).max(1_000),
  bytes: z.number().int().positive(),
  chunkBytes: z.number().int().positive(),
  chunkHashes: z.array(HashSchema),
  priority: z.enum(['proxy', 'original']),
}).strict();

export type SharedMediaAsset = z.infer<typeof SharedMediaAssetSchema>;

export const SharedMediaManifestSchema = z.object({
  version: z.literal(1),
  assets: z.array(SharedMediaAssetSchema),
}).strict();

export type SharedMediaManifest = z.infer<typeof SharedMediaManifestSchema>;

export interface LocalMediaSource {
  fingerprint: string;
  fileName: string;
  filePath: string;
  priority?: 'proxy' | 'original';
}

const CachedDescriptorSchema = z.object({
  size: z.number().int().nonnegative(),
  modifiedMs: z.number().nonnegative(),
  descriptor: SharedMediaAssetSchema,
}).strict();
const CatalogSchema = z.object({
  version: z.literal(1),
  entries: z.record(CachedDescriptorSchema),
}).strict();
type Catalog = z.infer<typeof CatalogSchema>;

function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function hashFile(filePath: string): Promise<string> {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) digest.update(chunk as Buffer);
  return digest.digest('hex');
}

async function describeFile(
  source: LocalMediaSource,
  chunkBytes: number,
): Promise<{ descriptor: SharedMediaAsset; size: number; modifiedMs: number }> {
  const before = await stat(source.filePath);
  if (!before.isFile()) throw new Error(`${source.fileName} is not a regular media file`);
  const handle = await open(source.filePath, 'r');
  const whole = createHash('sha256');
  const chunkHashes: string[] = [];
  try {
    for (let offset = 0; offset < before.size; offset += chunkBytes) {
      const length = Math.min(chunkBytes, before.size - offset);
      const bytes = Buffer.allocUnsafe(length);
      const result = await handle.read(bytes, 0, length, offset);
      if (result.bytesRead !== length) throw new Error(`Media changed while hashing ${source.fileName}`);
      whole.update(bytes);
      chunkHashes.push(hash(bytes));
    }
  } finally {
    await handle.close();
  }
  const after = await stat(source.filePath);
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
    throw new Error(`Media changed while hashing ${source.fileName}`);
  }
  const descriptor = SharedMediaAssetSchema.parse({
    fingerprint: source.fingerprint,
    contentHash: whole.digest('hex'),
    fileName: path.basename(source.fileName),
    bytes: before.size,
    chunkBytes,
    chunkHashes,
    priority: source.priority ?? 'original',
  });
  return { descriptor, size: before.size, modifiedMs: before.mtimeMs };
}

/** Local paths are cached here, but never included in the shared manifest or Git. */
export class MediaCatalog {
  constructor(
    private readonly catalogPath: string,
    private readonly chunkBytes = DEFAULT_MEDIA_CHUNK_BYTES,
  ) {}

  private async read(): Promise<Catalog> {
    try {
      return CatalogSchema.parse(await readJson(this.catalogPath));
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return { version: 1, entries: {} };
      }
      throw error;
    }
  }

  async manifest(sources: LocalMediaSource[]): Promise<SharedMediaManifest> {
    const catalog = await this.read();
    const assets: SharedMediaAsset[] = [];
    const activePaths = new Set(sources.map(({ filePath }) => path.resolve(filePath)));
    for (const source of sources) {
      const sourcePath = path.resolve(source.filePath);
      const details = await stat(sourcePath);
      const cached = catalog.entries[sourcePath];
      if (cached && cached.size === details.size && cached.modifiedMs === details.mtimeMs
        && cached.descriptor.fingerprint === source.fingerprint
        && cached.descriptor.priority === (source.priority ?? 'original')) {
        assets.push(cached.descriptor);
        continue;
      }
      const described = await describeFile({ ...source, filePath: sourcePath }, this.chunkBytes);
      catalog.entries[sourcePath] = described;
      assets.push(described.descriptor);
    }
    for (const sourcePath of Object.keys(catalog.entries)) {
      if (!activePaths.has(sourcePath)) delete catalog.entries[sourcePath];
    }
    await atomicWriteJson(this.catalogPath, catalog);
    return SharedMediaManifestSchema.parse({ version: 1, assets });
  }
}

const DownloadStateSchema = z.object({
  version: z.literal(1),
  contentHash: HashSchema,
  bytes: z.number().int().positive(),
  chunkBytes: z.number().int().positive(),
  completed: z.array(z.boolean()),
}).strict();
type DownloadState = z.infer<typeof DownloadStateSchema>;

export interface MediaDownloadProgress {
  completedChunks: number;
  totalChunks: number;
  downloadedBytes: number;
  totalBytes: number;
  complete: boolean;
}

/** Content-addressed receiver with persisted chunk completion and atomic publish. */
export class MediaStore {
  constructor(readonly root: string) {}

  assetPath(contentHash: string): string {
    HashSchema.parse(contentHash);
    return path.join(this.root, 'sha256', contentHash.slice(0, 2), contentHash);
  }

  private partialPath(contentHash: string): string {
    return `${this.assetPath(contentHash)}.part`;
  }

  private statePath(contentHash: string): string {
    return `${this.assetPath(contentHash)}.download.json`;
  }

  async has(contentHash: string): Promise<boolean> {
    try {
      await access(this.assetPath(contentHash));
      return true;
    } catch {
      return false;
    }
  }

  private emptyState(asset: SharedMediaAsset): DownloadState {
    return {
      version: 1,
      contentHash: asset.contentHash,
      bytes: asset.bytes,
      chunkBytes: asset.chunkBytes,
      completed: asset.chunkHashes.map(() => false),
    };
  }

  private async state(asset: SharedMediaAsset): Promise<DownloadState> {
    try {
      const state = DownloadStateSchema.parse(await readJson(this.statePath(asset.contentHash)));
      if (state.bytes === asset.bytes && state.chunkBytes === asset.chunkBytes
        && state.completed.length === asset.chunkHashes.length) return state;
      await this.reset(asset.contentHash);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    return this.emptyState(asset);
  }

  async missingChunks(assetInput: SharedMediaAsset): Promise<number[]> {
    const asset = SharedMediaAssetSchema.parse(assetInput);
    if (await this.has(asset.contentHash)) return [];
    const state = await this.state(asset);
    return state.completed.flatMap((completed, index) => completed ? [] : [index]);
  }

  async acceptChunk(assetInput: SharedMediaAsset, index: number, bytes: Uint8Array): Promise<MediaDownloadProgress> {
    const asset = SharedMediaAssetSchema.parse(assetInput);
    if (!Number.isSafeInteger(index) || index < 0 || index >= asset.chunkHashes.length) {
      throw new Error('Invalid media chunk index');
    }
    const expectedLength = Math.min(asset.chunkBytes, asset.bytes - index * asset.chunkBytes);
    if (bytes.byteLength !== expectedLength || hash(bytes) !== asset.chunkHashes[index]) {
      throw new Error(`Media chunk ${index} failed verification`);
    }
    await mkdir(path.dirname(this.assetPath(asset.contentHash)), { recursive: true });
    const state = await this.state(asset);
    if (!state.completed[index]) {
      const partial = this.partialPath(asset.contentHash);
      const handle = await open(partial, 'r+').catch(async (error: unknown) => {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return open(partial, 'w+');
        throw error;
      });
      try {
        await handle.write(bytes, 0, bytes.byteLength, index * asset.chunkBytes);
      } finally {
        await handle.close();
      }
      state.completed[index] = true;
      await atomicWriteJson(this.statePath(asset.contentHash), state);
    }
    if (state.completed.every(Boolean)) await this.finalize(asset);
    return this.progressFrom(asset, state);
  }

  private progressFrom(asset: SharedMediaAsset, state: DownloadState): MediaDownloadProgress {
    const completedChunks = state.completed.filter(Boolean).length;
    const downloadedBytes = state.completed.reduce((total, complete, index) => complete
      ? total + Math.min(asset.chunkBytes, asset.bytes - index * asset.chunkBytes)
      : total, 0);
    return {
      completedChunks,
      totalChunks: state.completed.length,
      downloadedBytes,
      totalBytes: asset.bytes,
      complete: completedChunks === state.completed.length,
    };
  }

  private async finalize(asset: SharedMediaAsset): Promise<void> {
    const partial = this.partialPath(asset.contentHash);
    const details = await stat(partial);
    if (!details.isFile() || details.size !== asset.bytes || await hashFile(partial) !== asset.contentHash) {
      await this.reset(asset.contentHash);
      throw new Error(`Completed media ${asset.fileName} failed full-file verification`);
    }
    await rename(partial, this.assetPath(asset.contentHash));
    await rm(this.statePath(asset.contentHash), { force: true });
  }

  async reset(contentHash: string): Promise<void> {
    await Promise.all([
      rm(this.partialPath(contentHash), { force: true }),
      rm(this.statePath(contentHash), { force: true }),
    ]);
  }
}

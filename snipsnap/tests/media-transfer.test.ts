import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MediaCatalog, MediaStore } from '../src/application';
import { digestText } from '../src/domain';

describe('collaboration media transfer', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'snipsnap-media-transfer-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('builds a path-free content and chunk hash manifest', async () => {
    const source = path.join(root, 'camera-a.mp4');
    await writeFile(source, 'abcdefghij');
    const manifest = await new MediaCatalog(path.join(root, 'catalog.json'), 4).manifest([{
      fingerprint: digestText('camera-a'),
      fileName: 'camera-a.mp4',
      filePath: source,
    }]);

    expect(manifest.assets).toHaveLength(1);
    expect(manifest.assets[0]).toMatchObject({ fileName: 'camera-a.mp4', bytes: 10, chunkBytes: 4 });
    expect(manifest.assets[0]?.chunkHashes).toHaveLength(3);
    expect(JSON.stringify(manifest)).not.toContain(root);
  });

  it('resumes verified chunks and atomically publishes a complete asset', async () => {
    const source = path.join(root, 'interview.mov');
    const original = Buffer.from('abcdefghij');
    await writeFile(source, original);
    const asset = (await new MediaCatalog(path.join(root, 'catalog.json'), 4).manifest([{
      fingerprint: digestText('interview'),
      fileName: 'interview.mov',
      filePath: source,
    }])).assets[0];
    if (!asset) throw new Error('Missing descriptor');

    const store = new MediaStore(path.join(root, 'cas'));
    await store.acceptChunk(asset, 1, original.subarray(4, 8));
    expect(await new MediaStore(path.join(root, 'cas')).missingChunks(asset)).toEqual([0, 2]);
    await expect(store.acceptChunk(asset, 0, Buffer.from('xxxx'))).rejects.toThrow(/failed verification/u);
    await store.acceptChunk(asset, 0, original.subarray(0, 4));
    const progress = await store.acceptChunk(asset, 2, original.subarray(8));

    expect(progress).toMatchObject({ completedChunks: 3, totalChunks: 3, complete: true });
    expect(await readFile(store.assetPath(asset.contentHash))).toEqual(original);
    expect(await store.missingChunks(asset)).toEqual([]);
  });
});

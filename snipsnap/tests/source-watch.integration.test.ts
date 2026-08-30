import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SourceWatchService, type WatchedSourceChange } from '../src/application';

describe('Resolve source watcher', () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it('coalesces file updates and survives replacement of the watched directory entry', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'snipsnap-watch-'));
    directories.push(directory);
    const sourcePath = path.join(directory, 'timeline.otio');
    await writeFile(sourcePath, 'first');
    let notify: ((change: WatchedSourceChange) => void) | undefined;
    const observed = new Promise<WatchedSourceChange>((resolve) => { notify = resolve; });
    const watcher = new SourceWatchService((change) => notify?.(change), 30, 25);
    watcher.watch('project-id', sourcePath);

    // This leaves fs.watch attached to the old directory inode. The polling
    // fallback must notice the newly created path, as happens with replacement
    // saves on Windows and with some NLE save implementations.
    const movedDirectory = `${directory}-old`;
    directories.push(movedDirectory);
    await rename(directory, movedDirectory);
    await mkdir(directory);
    await writeFile(sourcePath, 'second');
    try {
      const change = await Promise.race([
        observed,
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('Watcher did not fire')), 10_000)),
      ]);
      expect(change).toEqual({ projectId: 'project-id', sourcePath });
    } finally {
      watcher.close();
    }
  });
});

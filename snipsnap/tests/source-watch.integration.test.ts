import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SourceWatchService, type WatchedSourceChange } from '../src/application';

describe('Resolve source watcher', () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it('coalesces file updates and survives replacement-style exports', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'snipsnap-watch-'));
    directories.push(directory);
    const sourcePath = path.join(directory, 'timeline.otio');
    await writeFile(sourcePath, 'first');
    let notify: ((change: WatchedSourceChange) => void) | undefined;
    const observed = new Promise<WatchedSourceChange>((resolve) => { notify = resolve; });
    const watcher = new SourceWatchService((change) => notify?.(change), 30);
    watcher.watch('project-id', sourcePath);

    await writeFile(sourcePath, 'second');
    const change = await Promise.race([
      observed,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('Watcher did not fire')), 2000)),
    ]);
    watcher.close();
    expect(change).toEqual({ projectId: 'project-id', sourcePath });
  });
});

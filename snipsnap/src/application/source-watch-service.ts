import { watch, type FSWatcher } from 'node:fs';
import path from 'node:path';

export interface WatchedSourceChange {
  projectId: string;
  sourcePath: string;
}

/** Watches parent directories so atomic file replacement by Resolve remains visible. */
export class SourceWatchService {
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly onChange: (change: WatchedSourceChange) => void | Promise<void>,
    private readonly debounceMs = 650,
  ) {}

  watch(projectId: string, sourcePath: string): void {
    this.unwatch(projectId);
    const resolved = path.resolve(sourcePath);
    const expectedName = path.basename(resolved).toLocaleLowerCase();
    let watcher: FSWatcher;
    try {
      watcher = watch(path.dirname(resolved), { persistent: false }, (_event, filename) => {
        if (filename && filename.toString().toLocaleLowerCase() !== expectedName) return;
        const previous = this.timers.get(projectId);
        if (previous) clearTimeout(previous);
        this.timers.set(projectId, setTimeout(() => {
          this.timers.delete(projectId);
          void this.onChange({ projectId, sourcePath: resolved });
        }, this.debounceMs));
      });
    } catch {
      return;
    }
    watcher.on('error', () => this.unwatch(projectId));
    this.watchers.set(projectId, watcher);
  }

  unwatch(projectId: string): void {
    this.watchers.get(projectId)?.close();
    this.watchers.delete(projectId);
    const timer = this.timers.get(projectId);
    if (timer) clearTimeout(timer);
    this.timers.delete(projectId);
  }

  close(): void {
    for (const projectId of this.watchers.keys()) this.unwatch(projectId);
  }
}

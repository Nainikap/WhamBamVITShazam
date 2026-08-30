import { statSync, watch, type FSWatcher } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

export interface WatchedSourceChange {
  projectId: string;
  sourcePath: string;
}

/** Watches parent directories so atomic file replacement by Resolve remains visible. */
export class SourceWatchService {
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly pollers = new Map<string, NodeJS.Timeout>();
  private readonly sourcePaths = new Map<string, string>();
  private readonly fileMarkers = new Map<string, string | null>();
  private readonly polling = new Set<string>();

  constructor(
    private readonly onChange: (change: WatchedSourceChange) => void | Promise<void>,
    private readonly debounceMs = 650,
    private readonly pollIntervalMs = 500,
  ) {}

  private initialMarker(sourcePath: string): string | null {
    try {
      const metadata = statSync(sourcePath, { bigint: true });
      return `${metadata.mtimeNs}:${metadata.ctimeNs}:${metadata.size}`;
    } catch {
      return null;
    }
  }

  private async currentMarker(sourcePath: string): Promise<string | null> {
    try {
      const metadata = await stat(sourcePath, { bigint: true });
      return `${metadata.mtimeNs}:${metadata.ctimeNs}:${metadata.size}`;
    } catch {
      return null;
    }
  }

  private schedule(projectId: string, sourcePath: string): void {
    const previous = this.timers.get(projectId);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      this.timers.delete(projectId);
      if (this.sourcePaths.get(projectId) !== sourcePath) return;
      void this.onChange({ projectId, sourcePath });
    }, this.debounceMs);
    timer.unref();
    this.timers.set(projectId, timer);
  }

  private async poll(projectId: string, sourcePath: string): Promise<void> {
    if (this.polling.has(projectId) || this.sourcePaths.get(projectId) !== sourcePath) return;
    this.polling.add(projectId);
    try {
      const marker = await this.currentMarker(sourcePath);
      if (this.sourcePaths.get(projectId) !== sourcePath) return;
      if (marker === this.fileMarkers.get(projectId)) return;
      this.fileMarkers.set(projectId, marker);
      this.schedule(projectId, sourcePath);
    } finally {
      this.polling.delete(projectId);
    }
  }

  watch(projectId: string, sourcePath: string): void {
    this.unwatch(projectId);
    const resolved = path.resolve(sourcePath);
    const expectedName = path.basename(resolved).toLocaleLowerCase();
    this.sourcePaths.set(projectId, resolved);
    this.fileMarkers.set(projectId, this.initialMarker(resolved));

    const poller = setInterval(() => void this.poll(projectId, resolved), this.pollIntervalMs);
    poller.unref();
    this.pollers.set(projectId, poller);

    try {
      const watcher = watch(path.dirname(resolved), { persistent: false }, (_event, filename) => {
        if (filename && filename.toString().toLocaleLowerCase() !== expectedName) return;
        this.fileMarkers.set(projectId, this.initialMarker(resolved));
        this.schedule(projectId, resolved);
      });
      // A native watcher can fail after an editor atomically replaces its
      // directory entry. Keep the polling fallback alive in that case.
      watcher.on('error', () => {
        watcher.close();
        if (this.watchers.get(projectId) === watcher) this.watchers.delete(projectId);
      });
      this.watchers.set(projectId, watcher);
    } catch {
      // Polling still observes the source when a native watcher is unavailable.
    }
  }

  unwatch(projectId: string): void {
    this.watchers.get(projectId)?.close();
    this.watchers.delete(projectId);
    const timer = this.timers.get(projectId);
    if (timer) clearTimeout(timer);
    this.timers.delete(projectId);
    const poller = this.pollers.get(projectId);
    if (poller) clearInterval(poller);
    this.pollers.delete(projectId);
    this.sourcePaths.delete(projectId);
    this.fileMarkers.delete(projectId);
    this.polling.delete(projectId);
  }

  close(): void {
    for (const projectId of this.sourcePaths.keys()) this.unwatch(projectId);
  }
}

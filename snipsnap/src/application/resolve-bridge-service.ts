import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { z } from 'zod';
import type { ProjectService } from './project-service';

const BridgeEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('status'),
    state: z.enum(['waiting-for-resolve', 'watching']),
    message: z.string().max(2000).optional(),
  }).strict(),
  z.object({
    type: z.literal('snapshot'),
    path: z.string().min(1),
    marker: z.string().min(1).max(2000),
    savedAt: z.string().datetime(),
    projectName: z.string().min(1).max(1000),
    timelineName: z.string().min(1).max(1000),
  }).strict(),
]);

export interface ResolveBridgeOptions {
  command?: string;
  commandPrefixArgs?: string[];
  environment?: NodeJS.ProcessEnv;
  databasePollIntervalMs?: number;
}

/** Runs one validated, save-marker-driven Resolve scripting process per project. */
export class ResolveBridgeService {
  private readonly processes = new Map<string, ChildProcessWithoutNullStreams>();
  private readonly databasePollers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly databaseMarkers = new Map<string, string>();
  private readonly databaseBusy = new Set<string>();
  private readonly stopping = new Set<string>();

  constructor(
    private readonly projects: ProjectService,
    private readonly scriptPath: string,
    private readonly onChange: (projectId: string) => void | Promise<void>,
    private readonly options: ResolveBridgeOptions = {},
  ) {}

  isRunning(projectId: string): boolean {
    return this.processes.has(projectId) || this.databasePollers.has(projectId);
  }

  async start(projectId: string, expectedVersion?: number): Promise<void> {
    if (this.isRunning(projectId)) return;
    const status = await this.projects.status(projectId);
    const snapshotPath = status.source.mode === 'resolve'
      ? this.projects.resolveBridgeSnapshotPath(projectId)
      : await this.projects.enableResolveBridge(projectId, expectedVersion ?? status.workspaceVersion);
    await this.projects.updateResolveBridgeState(projectId, 'starting');
    await this.onChange(projectId);

    const command = this.options.command ?? (process.platform === 'win32' ? 'py' : 'python3');
    const prefix = this.options.commandPrefixArgs ?? (process.platform === 'win32' ? ['-3'] : []);
    const resolveApi = process.platform === 'win32' && process.env.PROGRAMDATA
      ? path.join(process.env.PROGRAMDATA, 'Blackmagic Design', 'DaVinci Resolve', 'Support', 'Developer', 'Scripting')
      : undefined;
    const modulePath = resolveApi ? path.join(resolveApi, 'Modules') : undefined;
    const environment: NodeJS.ProcessEnv = { ...process.env, ...this.options.environment };
    if (resolveApi) environment.RESOLVE_SCRIPT_API = resolveApi;
    if (modulePath) environment.PYTHONPATH = [modulePath, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);
    if (process.platform === 'win32') {
      environment.RESOLVE_SCRIPT_LIB ??= path.join(
        process.env.ProgramFiles ?? 'C:\\Program Files',
        'Blackmagic Design', 'DaVinci Resolve', 'fusionscript.dll',
      );
    }

    const child = spawn(command, [...prefix, this.scriptPath, '--output', snapshotPath], {
      cwd: path.dirname(snapshotPath),
      env: environment,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.end();
    this.processes.set(projectId, child);
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-2000);
    });
    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', (line) => void this.handleLine(projectId, line));
    child.once('error', (error) => void this.fail(projectId, `Could not start the Resolve bridge: ${error.message}`));
    child.once('exit', (code) => {
      lines.close();
      this.processes.delete(projectId);
      if (this.stopping.delete(projectId)) return;
      void this.fail(projectId, stderr.trim() || `Resolve bridge exited with code ${code ?? 'unknown'}`);
    });
    await this.startDatabaseFallback(projectId);
  }

  async stop(projectId: string): Promise<void> {
    const child = this.processes.get(projectId);
    if (child) {
      this.stopping.add(projectId);
      this.processes.delete(projectId);
      child.kill();
    }
    this.stopDatabaseFallback(projectId);
    await this.projects.updateResolveBridgeState(projectId, 'stopped');
    await this.onChange(projectId);
  }

  async restore(): Promise<void> {
    for (const project of await this.projects.listProjects()) {
      const binding = await this.projects.sourceBinding(project.id);
      if (binding?.mode === 'resolve') await this.start(project.id);
    }
  }

  close(): void {
    for (const [projectId, child] of this.processes) {
      this.stopping.add(projectId);
      child.kill();
    }
    this.processes.clear();
    for (const projectId of this.databasePollers.keys()) this.stopDatabaseFallback(projectId);
  }

  private async startDatabaseFallback(projectId: string): Promise<void> {
    const source = await this.projects.resolveDatabaseBridgeSource(projectId);
    if (!source || this.databasePollers.has(projectId)) return;
    try {
      const info = await stat(source.databasePath);
      this.databaseMarkers.set(projectId, `${info.mtimeMs}:${info.size}`);
    } catch {
      return;
    }
    const interval = setInterval(
      () => void this.pollDatabaseFallback(projectId, source.databasePath),
      this.options.databasePollIntervalMs ?? 500,
    );
    interval.unref();
    this.databasePollers.set(projectId, interval);
  }

  private stopDatabaseFallback(projectId: string): void {
    const interval = this.databasePollers.get(projectId);
    if (interval) clearInterval(interval);
    this.databasePollers.delete(projectId);
    this.databaseMarkers.delete(projectId);
    this.databaseBusy.delete(projectId);
  }

  private async pollDatabaseFallback(projectId: string, databasePath: string): Promise<void> {
    if (this.databaseBusy.has(projectId)) return;
    let info;
    try {
      info = await stat(databasePath);
    } catch {
      return;
    }
    const marker = `${info.mtimeMs}:${info.size}`;
    if (marker === this.databaseMarkers.get(projectId)) return;
    this.databaseBusy.add(projectId);
    try {
      await this.projects.applyResolveDatabaseBridgeSnapshot(
        projectId,
        `database:${marker}`,
        new Date(info.mtimeMs).toISOString(),
      );
      this.databaseMarkers.set(projectId, marker);
      await this.onChange(projectId);
    } catch {
      // Resolve may still be replacing SQLite pages. Keep the old marker so
      // the next poll retries this same save instead of losing it.
    } finally {
      this.databaseBusy.delete(projectId);
    }
  }

  private async handleLine(projectId: string, line: string): Promise<void> {
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      await this.fail(projectId, 'Resolve bridge returned an invalid response');
      return;
    }
    const parsed = BridgeEventSchema.safeParse(value);
    if (!parsed.success) {
      await this.fail(projectId, 'Resolve bridge returned an invalid event');
      return;
    }
    try {
      if (parsed.data.type === 'status') {
        await this.projects.updateResolveBridgeState(projectId, parsed.data.state);
      } else {
        await this.projects.applyResolveBridgeSnapshot(projectId, parsed.data);
      }
      await this.onChange(projectId);
    } catch (error) {
      await this.fail(projectId, error instanceof Error ? error.message : String(error));
    }
  }

  private async fail(projectId: string, error: string): Promise<void> {
    await this.projects.updateResolveBridgeState(projectId, 'invalid', error);
    await this.onChange(projectId);
  }
}

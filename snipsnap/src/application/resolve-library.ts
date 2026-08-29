import { access, copyFile, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { deterministicUuid } from '../domain';

const MAX_SCAN_DEPTH = 4;

const ManifestTimelineSchema = z.object({
  name: z.string().min(1),
  otio: z.string().min(1),
  isCurrent: z.boolean().optional(),
  modifiedAt: z.string().optional(),
}).passthrough();

const ManifestProjectSchema = z.object({
  name: z.string().min(1),
  drp: z.string().min(1),
  folder: z.string().optional(),
  currentTimeline: z.string().nullable().optional(),
  timelines: z.array(ManifestTimelineSchema),
  settings: z.object({
    fps: z.number().positive().optional(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
  }).partial().optional(),
  exportedAt: z.string().optional(),
}).passthrough();

const ManifestSchema = z.object({
  version: z.literal(1),
  generatedAt: z.string().optional(),
  resolveVersion: z.string().optional(),
  projects: z.array(ManifestProjectSchema),
}).passthrough();

export interface ResolveTimelineRef {
  name: string;
  otioPath: string;
  isCurrent: boolean;
}

export type ResolveProjectKind = 'export' | 'database';

/**
 * A Resolve project SnipSnap knows about. It is openable once a timeline
 * export sits beside it; until then it is listed with `activeTimeline` null so
 * the editor can still see that Resolve has the project.
 */
export interface ResolveProjectRef {
  id: string;
  name: string;
  /** Empty for a project that lives only in Resolve's own database. */
  drpPath: string;
  folder: string;
  kind: ResolveProjectKind;
  timelines: ResolveTimelineRef[];
  activeTimeline: ResolveTimelineRef | null;
  updatedAt: string;
  discoveredVia: 'manifest' | 'scan' | 'database';
  /** Timeline names Resolve knows about, even when none has been exported. */
  knownTimelines?: string[];
  settings?: { fps?: number | undefined; width?: number | undefined; height?: number | undefined };
}

export function defaultResolveRoot(): string {
  return defaultResolveRoots()[0] as string;
}

/**
 * Where the export script writes. Run from inside the sandboxed App Store
 * build, its idea of the home folder is the container, so look in both.
 */
export function defaultResolveRoots(): string[] {
  if (process.env.SNIPSNAP_RESOLVE_ROOT) {
    return process.env.SNIPSNAP_RESOLVE_ROOT.split(path.delimiter).filter(Boolean);
  }
  const home = os.homedir();
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return [path.join(appData, 'SnipSnap', 'resolve')];
  }
  const containers = ['com.blackmagic-design.DaVinciResolveLite', 'com.blackmagic-design.DaVinciResolve'];
  return [
    path.join(home, 'Library', 'Application Support', 'SnipSnap', 'resolve'),
    ...containers.map((bundle) => path.join(
      home, 'Library', 'Containers', bundle, 'Data', 'Library', 'Application Support', 'SnipSnap', 'resolve',
    )),
  ];
}

const PROJECT_LIBRARY_TAILS = [
  ['Resolve Project Library', 'Resolve Projects', 'Users', 'guest', 'Projects'],
  ['Resolve Disk Database', 'Resolve Projects', 'Users', 'guest', 'Projects'],
];

/**
 * Where Resolve keeps its own project database. The App Store build is
 * sandboxed, so its library sits inside a container rather than the usual
 * Application Support folder.
 */
export function resolveDatabaseRoots(): string[] {
  if (process.env.SNIPSNAP_RESOLVE_DATABASE) {
    return process.env.SNIPSNAP_RESOLVE_DATABASE.split(path.delimiter).filter(Boolean);
  }
  const home = os.homedir();
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const programData = process.env.PROGRAMDATA || path.join(home, 'AppData', 'ProgramData');
    const bases = [
      path.join(appData, 'Blackmagic Design', 'DaVinci Resolve', 'Support'),
      path.join(programData, 'Blackmagic Design', 'DaVinci Resolve', 'Support'),
    ];
    return bases.flatMap((base) => PROJECT_LIBRARY_TAILS.map((tail) => path.join(base, ...tail)));
  }
  const bases = [
    path.join(home, 'Library', 'Application Support'),
    path.join(home, 'Library', 'Application Support', 'Blackmagic Design', 'DaVinci Resolve'),
    path.join(home, 'Library', 'Containers', 'com.blackmagic-design.DaVinciResolveLite', 'Data', 'Library', 'Application Support'),
    path.join(home, 'Library', 'Containers', 'com.blackmagic-design.DaVinciResolve', 'Data', 'Library', 'Application Support'),
    path.join(home, 'Movies', 'DaVinci Resolve'),
  ];
  return bases.flatMap((base) => PROJECT_LIBRARY_TAILS.map((tail) => path.join(base, ...tail)));
}

/** Folders a .drp is likely to be sitting in, so the list is never empty. */
export function commonExportRoots(): string[] {
  if (process.env.SNIPSNAP_RESOLVE_SCAN) return process.env.SNIPSNAP_RESOLVE_SCAN.split(path.delimiter).filter(Boolean);
  const home = os.homedir();
  const mediaFolder = process.platform === 'win32' ? 'Videos' : 'Movies';
  return ['Documents', 'Desktop', mediaFolder, 'Downloads'].map((folder) => path.join(home, folder));
}

/**
 * Where Resolve looks for scripts it runs itself. Builds that refuse external
 * scripting still run these, so installing here is the way in on the App Store
 * version.
 */
export function resolveScriptFolders(): string[] {
  if (process.env.SNIPSNAP_RESOLVE_SCRIPTS) {
    return process.env.SNIPSNAP_RESOLVE_SCRIPTS.split(path.delimiter).filter(Boolean);
  }
  const home = os.homedir();
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const programData = process.env.PROGRAMDATA || path.join(home, 'AppData', 'ProgramData');
    return [appData, programData].map((base) => path.join(
      base, 'Blackmagic Design', 'DaVinci Resolve', 'Support', 'Fusion', 'Scripts', 'Utility',
    ));
  }
  const containers = ['com.blackmagic-design.DaVinciResolveLite', 'com.blackmagic-design.DaVinciResolve'];
  return [
    path.join(home, 'Library', 'Application Support', 'Blackmagic Design', 'DaVinci Resolve', 'Fusion', 'Scripts', 'Utility'),
    ...containers.map((bundle) => path.join(
      home, 'Library', 'Containers', bundle, 'Data', 'Library', 'Application Support', 'Fusion', 'Scripts', 'Utility',
    )),
    path.join(home, 'Library', 'Application Support', 'Fusion', 'Scripts', 'Utility'),
  ];
}

/**
 * Copy the export script into Resolve's Scripts menu. Only folders whose
 * Scripts directory already exists are used, so nothing is scattered around a
 * machine that has no Resolve on it.
 */
export async function installResolveScript(scriptPath: string): Promise<string[]> {
  const installed: string[] = [];
  for (const folder of resolveScriptFolders()) {
    try {
      await access(path.dirname(folder));
    } catch {
      continue;
    }
    try {
      await mkdir(folder, { recursive: true });
      const target = path.join(folder, path.basename(scriptPath));
      await copyFile(scriptPath, target);
      installed.push(target);
    } catch {
      // A folder we cannot write to is simply not one of the install targets.
    }
  }
  return installed;
}

export function resolveDatabaseProjectId(folder: string): string {
  return deterministicUuid(`resolve-database-project:${path.resolve(folder)}`);
}

/** Where SnipSnap keeps timelines it rebuilt from a Resolve project database. */
export function generatedExportFolder(projectFolder: string): string {
  return path.join(defaultResolveRoots()[0] as string, 'generated', path.basename(projectFolder));
}

/** One SnipSnap project per Resolve project file, stable across re-exports. */
export function resolveProjectId(drpPath: string): string {
  return deterministicUuid(`resolve-project:${path.resolve(drpPath)}`);
}

async function readableFile(candidate: string): Promise<{ path: string; modifiedAt: string } | null> {
  try {
    const info = await stat(candidate);
    if (!info.isFile() || info.size <= 0) return null;
    return { path: path.resolve(candidate), modifiedAt: info.mtime.toISOString() };
  } catch {
    return null;
  }
}

function newest(values: string[]): string {
  return [...values].sort().at(-1) ?? new Date(0).toISOString();
}

interface DiscoveredTimeline {
  name: string;
  file: { path: string; modifiedAt: string };
  isCurrent: boolean;
}

function toRef(
  name: string,
  drp: { path: string; modifiedAt: string },
  timelines: DiscoveredTimeline[],
  discoveredVia: ResolveProjectRef['discoveredVia'],
  settings?: ResolveProjectRef['settings'],
): ResolveProjectRef {
  const refs: ResolveTimelineRef[] = timelines.map((timeline) => ({
    name: timeline.name,
    otioPath: timeline.file.path,
    isCurrent: timeline.isCurrent,
  }));
  const active = refs.find((timeline) => timeline.isCurrent) ?? refs[0] ?? null;
  return {
    id: resolveProjectId(drp.path),
    name,
    drpPath: drp.path,
    folder: path.dirname(drp.path),
    kind: 'export',
    timelines: refs,
    activeTimeline: active,
    updatedAt: newest([drp.modifiedAt, ...timelines.map(({ file }) => file.modifiedAt)]),
    discoveredVia,
    ...(settings ? { settings } : {}),
  };
}

interface SqliteRow { [column: string]: unknown }
interface SqliteDatabase {
  prepare(sql: string): { all(): SqliteRow[] };
  close(): void;
}
type SqliteModule = {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteDatabase;
};

/** Loaded at run time so bundlers do not try to resolve a Node built-in. */
function loadSqlite(): SqliteModule | null {
  try {
    return createRequire(__filename)('node:sqlite') as SqliteModule;
  } catch {
    return null;
  }
}

interface DatabaseProject {
  name: string;
  timelines: string[];
}

/**
 * Read a project's name and timeline names straight out of Resolve's own
 * database, so a project appears with real detail even before any export.
 * The file is copied first because Resolve may hold it open.
 */
async function readProjectDatabase(databasePath: string): Promise<DatabaseProject | null> {
  const sqlite = loadSqlite();
  if (!sqlite) return null;
  const copy = `${databasePath}.snipsnap-read`;
  try {
    await copyFile(databasePath, copy);
    const database = new sqlite.DatabaseSync(copy, { readOnly: true });
    try {
      const projects = database.prepare('SELECT ProjectName FROM SM_Project LIMIT 1').all();
      const timelines = database.prepare('SELECT Name FROM Sm2Timeline ORDER BY ModTimeInSecs DESC').all();
      const projectName = projects[0]?.ProjectName;
      return {
        name: typeof projectName === 'string' ? projectName : '',
        timelines: timelines
          .map((row) => row.Name)
          .filter((name): name is string => typeof name === 'string' && name.length > 0),
      };
    } finally {
      database.close();
    }
  } catch {
    return null;
  } finally {
    await rm(copy, { force: true });
  }
}

/** Projects Resolve keeps in its own database, which have no .drp of their own. */
async function fromDatabase(root: string): Promise<ResolveProjectRef[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const refs: ResolveProjectRef[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const folder = path.join(root, entry.name);
    let contents: string[];
    try {
      contents = await readdir(folder);
    } catch {
      continue;
    }
    // A Resolve project folder carries its database file next to its media.
    const databaseFile = contents.find((name) => name.toLowerCase().endsWith('.db'));
    if (!databaseFile) continue;
    let modifiedAt = new Date(0).toISOString();
    try {
      modifiedAt = (await stat(folder)).mtime.toISOString();
    } catch {
      continue;
    }
    const timelines: DiscoveredTimeline[] = [];
    // Exports Resolve wrote itself, then any this app rebuilt from the database.
    const sources: Array<{ dir: string; names: string[] }> = [
      { dir: folder, names: contents },
      { dir: generatedExportFolder(folder), names: await readdir(generatedExportFolder(folder)).catch(() => []) },
    ];
    for (const source of sources) {
      for (const name of source.names.filter((candidate) => candidate.toLowerCase().endsWith('.otio'))) {
        const file = await readableFile(path.join(source.dir, name));
        if (file) timelines.push({ name: path.basename(name, '.otio'), file, isCurrent: timelines.length === 0 });
      }
    }
    const details = await readProjectDatabase(path.join(folder, databaseFile));
    refs.push({
      id: resolveDatabaseProjectId(folder),
      name: details?.name || entry.name,
      drpPath: '',
      folder,
      kind: 'database',
      timelines: timelines.map(({ name, file, isCurrent }) => ({ name, otioPath: file.path, isCurrent })),
      activeTimeline: timelines[0] ? { name: timelines[0].name, otioPath: timelines[0].file.path, isCurrent: true } : null,
      updatedAt: newest([modifiedAt, ...timelines.map(({ file }) => file.modifiedAt)]),
      discoveredVia: 'database',
      ...(details?.timelines.length ? { knownTimelines: details.timelines } : {}),
    });
  }
  return refs;
}

async function fromManifest(root: string): Promise<ResolveProjectRef[]> {
  let parsed;
  try {
    parsed = ManifestSchema.parse(JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8')));
  } catch {
    return [];
  }

  const refs: ResolveProjectRef[] = [];
  for (const project of parsed.projects) {
    const drp = await readableFile(project.drp);
    // A project whose Resolve file or timeline export has gone is not openable.
    if (!drp) continue;
    const timelines: DiscoveredTimeline[] = [];
    for (const timeline of project.timelines) {
      const file = await readableFile(timeline.otio);
      if (!file) continue;
      timelines.push({
        name: timeline.name,
        file,
        isCurrent: timeline.isCurrent === true || timeline.name === project.currentTimeline,
      });
    }
    refs.push(toRef(project.name, drp, timelines, 'manifest', project.settings));
  }
  return refs;
}

async function collectProjectFiles(root: string, depth: number, found: string[]): Promise<void> {
  if (depth > MAX_SCAN_DEPTH) return;
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) await collectProjectFiles(entryPath, depth + 1, found);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.drp')) found.push(entryPath);
  }
}

/** Pick up .drp/.otio pairs a user exported by hand, not only plugin output. */
async function fromScan(root: string): Promise<ResolveProjectRef[]> {
  const projectFiles: string[] = [];
  await collectProjectFiles(root, 0, projectFiles);
  const refs: ResolveProjectRef[] = [];

  for (const projectFile of projectFiles) {
    const drp = await readableFile(projectFile);
    if (!drp) continue;
    const folder = path.dirname(drp.path);
    let siblings: string[];
    try {
      siblings = (await readdir(folder)).filter((name) => name.toLowerCase().endsWith('.otio'));
    } catch {
      continue;
    }
    const base = path.basename(drp.path, path.extname(drp.path));
    const ordered = siblings.sort((left, right) => {
      const leftMatch = path.basename(left, '.otio') === base ? 0 : 1;
      const rightMatch = path.basename(right, '.otio') === base ? 0 : 1;
      return leftMatch - rightMatch || left.localeCompare(right);
    });
    const timelines: DiscoveredTimeline[] = [];
    for (const [index, name] of ordered.entries()) {
      const file = await readableFile(path.join(folder, name));
      if (file) timelines.push({ name: path.basename(name, '.otio'), file, isCurrent: index === 0 });
    }
    refs.push(toRef(base, drp, timelines, 'scan'));
  }
  return refs;
}

/**
 * Finds the Resolve projects SnipSnap is willing to show: the manifest the
 * companion script writes, plus any .drp sitting beside an .otio in a watched
 * folder. Anything missing either file is left out rather than shown broken.
 */
export class ResolveLibrary {
  private readonly roots: () => Promise<string[]>;

  constructor(roots: string[] | (() => Promise<string[]>)) {
    this.roots = typeof roots === 'function' ? roots : async () => roots;
  }

  async discover(): Promise<ResolveProjectRef[]> {
    const byId = new Map<string, ResolveProjectRef>();
    for (const root of await this.roots()) {
      try {
        await access(root);
      } catch {
        continue;
      }
      // Manifest entries win because they carry real timeline names.
      for (const ref of await fromScan(root)) byId.set(ref.id, ref);
      for (const ref of await fromManifest(root)) byId.set(ref.id, ref);
    }
    for (const root of resolveDatabaseRoots()) {
      for (const ref of await fromDatabase(root)) {
        if (!byId.has(ref.id)) byId.set(ref.id, ref);
      }
    }
    return [...byId.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }
}

import { access, readdir, readFile, stat } from 'node:fs/promises';
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

/** A Resolve project SnipSnap can actually open: a .drp with at least one .otio. */
export interface ResolveProjectRef {
  id: string;
  name: string;
  drpPath: string;
  folder: string;
  timelines: ResolveTimelineRef[];
  activeTimeline: ResolveTimelineRef;
  updatedAt: string;
  discoveredVia: 'manifest' | 'scan';
  settings?: { fps?: number | undefined; width?: number | undefined; height?: number | undefined };
}

export function defaultResolveRoot(): string {
  return process.env.SNIPSNAP_RESOLVE_ROOT
    ?? path.join(os.homedir(), 'Library', 'Application Support', 'SnipSnap', 'resolve');
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
): ResolveProjectRef | null {
  if (timelines.length === 0) return null;
  const refs: ResolveTimelineRef[] = timelines.map((timeline) => ({
    name: timeline.name,
    otioPath: timeline.file.path,
    isCurrent: timeline.isCurrent,
  }));
  const active = refs.find((timeline) => timeline.isCurrent) ?? refs[0];
  if (!active) return null;
  return {
    id: resolveProjectId(drp.path),
    name,
    drpPath: drp.path,
    folder: path.dirname(drp.path),
    timelines: refs,
    activeTimeline: active,
    updatedAt: newest([drp.modifiedAt, ...timelines.map(({ file }) => file.modifiedAt)]),
    discoveredVia,
    ...(settings ? { settings } : {}),
  };
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
    const ref = toRef(project.name, drp, timelines, 'manifest', project.settings);
    if (ref) refs.push(ref);
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
    const ref = toRef(base, drp, timelines, 'scan');
    if (ref) refs.push(ref);
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
    return [...byId.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }
}

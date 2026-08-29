import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectService, ResolveLibrary, resolveProjectId } from '../src/application';

const HARNESS = path.resolve(__dirname, '../../resolve/tests/run_with_fake_resolve.py');
const SYNC = path.resolve(__dirname, '../../resolve/SnipSnapSync.py');
const BRIDGE = path.resolve(__dirname, '../../resolve/SnipSnapSaveBridge.py');
const FIXTURE = path.resolve(__dirname, 'fixtures/resolve-real-export.otio');
const hasPython = spawnSync('python3', ['--version'], { stdio: 'ignore' }).status === 0;

/**
 * Resolve itself cannot run here, but the files SnipSnapSync.py writes are a
 * contract with the app. This runs the real script against a stand-in Resolve
 * and then reads the result the way the dashboard does.
 */
describe.runIf(hasPython)('SnipSnapSync output', () => {
  let root: string;
  let library: string;
  let service: ProjectService;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'snipsnap-plugin-'));
    process.env.SNIPSNAP_RESOLVE_DATABASE = path.join(root, 'no-resolve-database');
    library = path.join(root, 'library');
    service = new ProjectService(path.join(root, 'data'), new ResolveLibrary([library]));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function runPlugin(...extra: string[]) {
    return spawnSync('python3', [HARNESS, library, FIXTURE, ...extra], { encoding: 'utf8' });
  }

  it('writes a manifest and export layout the app can read back', async () => {
    const result = runPlugin('--all');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('2 project(s) ready for SnipSnap');

    const discovered = await service.discoverResolveProjects();
    expect(discovered.map(({ name }) => name).sort()).toEqual(['Launch Promo', 'Second Project']);

    const promo = discovered.find(({ name }) => name === 'Launch Promo');
    expect(promo?.discoveredVia).toBe('manifest');
    expect(promo?.timelines.map(({ name }) => name)).toEqual(['Launch Promo v1', 'Launch Promo v2']);
    // The timeline open in Resolve is the one SnipSnap opens.
    expect(promo?.activeTimeline?.name).toBe('Launch Promo v2');
    expect(promo?.settings).toEqual({ fps: 24, width: 1920, height: 1080 });
    expect(path.basename(promo?.drpPath ?? '')).toBe('Launch-Promo.drp');
  });

  it('exports only the open project unless every project is asked for', async () => {
    expect(runPlugin().status).toBe(0);

    const discovered = await service.discoverResolveProjects();
    expect(discovered.map(({ name }) => name)).toEqual(['Launch Promo']);
  });

  it('opens a plugin export straight into a versioned project', async () => {
    expect(runPlugin().status).toBe(0);
    const [reference] = await service.discoverResolveProjects();
    if (!reference) throw new Error('The plugin exported nothing');

    const status = await service.openResolveProjectById(resolveProjectId(reference.drpPath));
    expect(status.project.name).toBe('Launch Promo');
    expect(status.resolve?.timelineName).toBe('Launch Promo v2');
    expect(status.history).toHaveLength(1);
    expect(status.project.tracks.map(({ kind }) => kind)).toEqual(['video', 'audio']);
    expect(status.unstaged).toEqual([]);
  });

  it('reports a missing Resolve rather than failing to import its module', () => {
    // Point the loader at nothing so it takes the same path as a machine
    // without Resolve installed.
    const environment = { ...process.env, RESOLVE_SCRIPT_API: path.join(root, 'no-resolve') };

    const sync = spawnSync('python3', [SYNC, '--output', path.join(root, 'out')], {
      encoding: 'utf8',
      env: environment,
      timeout: 30_000,
    });
    expect(sync.stderr).not.toContain('Traceback');
    expect(sync.stderr).not.toContain('ModuleNotFoundError');

    const bridge = spawnSync('python3', [BRIDGE, '--output', path.join(root, 'timeline.otio')], {
      encoding: 'utf8',
      env: environment,
      timeout: 6_000,
    });
    expect(bridge.stderr).not.toContain('Traceback');
    expect(bridge.stderr).not.toContain('ModuleNotFoundError');
    const first = bridge.stdout.split('\n').filter(Boolean)[0] ?? '';
    // Every state it can be in is reported as one JSON status line.
    expect(JSON.parse(first)).toMatchObject({ type: 'status', state: expect.any(String) });
  });
});

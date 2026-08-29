import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  commonExportRoots,
  defaultResolveRoots,
  installResolveScript,
  resolveDatabaseRoots,
  resolveScriptFolders,
} from '../src/application';

describe('installing the Resolve script', () => {
  let root: string;
  let script: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'snipsnap-install-'));
    script = path.join(root, 'SnipSnapSync.py');
    await writeFile(script, '# export script\n');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    delete process.env.SNIPSNAP_RESOLVE_SCRIPTS;
  });

  it('installs into a Scripts folder that already exists', async () => {
    const utility = path.join(root, 'Fusion', 'Scripts', 'Utility');
    await mkdir(path.dirname(utility), { recursive: true });
    process.env.SNIPSNAP_RESOLVE_SCRIPTS = utility;

    const installed = await installResolveScript(script);
    expect(installed).toEqual([path.join(utility, 'SnipSnapSync.py')]);
    expect(await readFile(installed[0] as string, 'utf8')).toContain('export script');
  });

  it('leaves a machine with no Resolve alone', async () => {
    process.env.SNIPSNAP_RESOLVE_SCRIPTS = path.join(root, 'nothing', 'here', 'Utility');
    expect(await installResolveScript(script)).toEqual([]);
  });

  it('uses the installed platform\'s Resolve folders', () => {
    delete process.env.SNIPSNAP_RESOLVE_SCRIPTS;
    if (process.platform === 'win32') {
      const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
      expect(resolveScriptFolders()).toContain(path.join(
        appData, 'Blackmagic Design', 'DaVinci Resolve', 'Support', 'Fusion', 'Scripts', 'Utility',
      ));
      expect(resolveDatabaseRoots()).toContain(path.join(
        appData, 'Blackmagic Design', 'DaVinci Resolve', 'Support', 'Resolve Project Library',
        'Resolve Projects', 'Users', 'guest', 'Projects',
      ));
      expect(defaultResolveRoots()).toEqual([path.join(appData, 'SnipSnap', 'resolve')]);
      expect(commonExportRoots()).toContain(path.join(os.homedir(), 'Videos'));
      return;
    }

    expect(resolveScriptFolders().some((folder) => folder.includes('com.blackmagic-design.DaVinciResolveLite')))
      .toBe(true);
  });
});

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installResolveScript, resolveScriptFolders } from '../src/application';

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

  it('offers the sandboxed App Store container among its targets', () => {
    delete process.env.SNIPSNAP_RESOLVE_SCRIPTS;
    expect(resolveScriptFolders().some((folder) => folder.includes('com.blackmagic-design.DaVinciResolveLite')))
      .toBe(true);
  });
});

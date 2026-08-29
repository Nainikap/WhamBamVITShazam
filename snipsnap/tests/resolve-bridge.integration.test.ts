import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectService, ResolveBridgeService } from '../src/application';

describe('save-driven Resolve bridge', () => {
  let root: string;
  let service: ProjectService;
  let bridge: ResolveBridgeService | undefined;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'snipsnap-save-bridge-'));
    service = new ProjectService(path.join(root, 'data'));
  });

  afterEach(async () => {
    bridge?.close();
    await rm(root, { recursive: true, force: true });
  });

  it('validates one snapshot event and automatically makes it the latest WORKING state', async () => {
    const fixture = await readFile(path.join(__dirname, 'fixtures', 'resolve-basic.otio'), 'utf8');
    const imported = await service.importOtio(fixture);
    const changedPath = path.join(root, 'changed.otio');
    const changed = JSON.parse(fixture) as {
      tracks: { children: Array<{ children: Array<{ name?: string; source_range?: { duration: { value: number } } }> }> };
    };
    const opening = changed.tracks.children[0]?.children[0];
    if (!opening?.source_range) throw new Error('Fixture clip range missing');
    opening.name = 'Bridge opening';
    opening.source_range.duration.value -= 3;
    await writeFile(changedPath, JSON.stringify(changed));

    const fake = path.join(root, 'fake-bridge.cjs');
    await writeFile(fake, [
      "const fs = require('node:fs');",
      "const output = process.argv[process.argv.indexOf('--output') + 1];",
      "fs.copyFileSync(process.env.FAKE_OTIO, output);",
      "console.log(JSON.stringify({type:'snapshot',path:output,marker:'saved-1',savedAt:'2026-08-29T18:30:00.000Z',projectName:'Resolve Basic Cut',timelineName:'Timeline 1'}));",
      'setInterval(() => {}, 1000);',
    ].join('\n'));

    let notify: (() => void) | undefined;
    const changedEvent = new Promise<void>((resolve) => { notify = resolve; });
    bridge = new ResolveBridgeService(service, 'ignored.py', () => {
      void service.status(imported.id).then((status) => {
        if (status.source.lastSavedAt) notify?.();
      });
    }, {
      command: process.execPath,
      commandPrefixArgs: [fake],
      environment: { FAKE_OTIO: changedPath },
    });
    const initial = await service.status(imported.id);
    await bridge.start(imported.id, initial.workspaceVersion);
    await Promise.race([
      changedEvent,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('Bridge event timed out')), 3000)),
    ]);

    const status = await service.status(imported.id);
    expect(status.source.state).toBe('watching');
    expect(status.workingChanges).toHaveLength(2);
    expect(status.source.pending).toBeUndefined();
    await bridge.stop(imported.id);
    expect((await service.status(imported.id)).source.state).toBe('stopped');
  });
});

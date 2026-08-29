import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { exportOtio, importOtio } from '../src/adapters/otio';
import { canonicalJson, createDemoProject } from '../src/domain';

describe('OTIO adapter', () => {
  it('imports the supported Resolve cut subset and reports unsupported items', () => {
    const fixture = readFileSync(path.join(__dirname, 'fixtures/resolve-basic.otio'), 'utf8');
    const result = importOtio(fixture);

    expect(result.project.name).toBe('Resolve Basic Cut');
    expect(result.project.clips).toHaveLength(1);
    expect(result.project.clips[0]?.sourceRange).toEqual({ start: 48, duration: 96 });
    expect(result.project.gaps[0]?.durationFrames).toBe(12);
    expect(result.project.assets[0]?.name).toBe('opening.mov');
    expect(Object.values(result.mediaLinks)).toEqual(['file:///Volumes/Edit/opening.mov']);
    expect(result.unsupported).toEqual([
      expect.objectContaining({ schema: 'Transition.1', reason: expect.stringContaining('Clip and Gap') }),
    ]);
  });

  it('round-trips the canonical V1 subset without frame or identity drift', () => {
    const project = createDemoProject();
    const otio = exportOtio(project);
    const imported = importOtio(otio);

    expect(imported.unsupported).toEqual([]);
    expect(imported.mediaLinks).toEqual({});
    expect(canonicalJson(imported.project)).toBe(canonicalJson(project));
    expect(otio).not.toContain('/Volumes/');
    expect(otio).toContain('videogit://asset/');
  });

  it('rejects non-timeline OTIO roots', () => {
    expect(() => importOtio({ OTIO_SCHEMA: 'SerializableCollection.1', tracks: { children: [] } }))
      .toThrow(/Expected an OTIO Timeline/u);
  });

  const hasOfficialOtio = spawnSync('python', ['-c', 'import opentimelineio'], { stdio: 'ignore' }).status === 0;
  it.runIf(hasOfficialOtio)('produces JSON accepted by the official OpenTimelineIO parser', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'snipsnap-otio-'));
    const filePath = path.join(directory, 'export.otio');
    try {
      writeFileSync(filePath, exportOtio(createDemoProject()), 'utf8');
      const result = spawnSync('python', [
        '-c',
        'import opentimelineio as otio,sys; value=otio.adapters.read_from_file(sys.argv[1]); assert isinstance(value, otio.schema.Timeline)',
        filePath,
      ], { encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

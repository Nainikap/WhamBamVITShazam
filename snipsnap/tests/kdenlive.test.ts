import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  KdenliveInterchangeReportSchema,
  assessKdenliveCompatibility,
  exportKdenliveOtio,
  importKdenliveOtio,
} from '../src/adapters/kdenlive';
import { projectDigest } from '../src/domain';
import { createDemoProject } from '../src/domain/fixture';

describe('Kdenlive OTIO adapter', () => {
  it('reports the exact canonical features that are not guaranteed to survive', () => {
    const report = assessKdenliveCompatibility(createDemoProject());
    expect(() => KdenliveInterchangeReportSchema.parse(report)).not.toThrow();
    expect(report.supported).toEqual([
      'tracks', 'clips', 'gaps', 'source-ranges', 'media-references', 'markers',
    ]);
    expect(report.losses).toEqual(expect.arrayContaining([
      expect.objectContaining({ feature: 'transitions', support: 'best-effort', count: 1 }),
      expect.objectContaining({ feature: 'captions', support: 'not-portable', count: 1 }),
      expect.objectContaining({ feature: 'audio-gain', support: 'best-effort', count: 2 }),
    ]));
  });

  it('round-trips the canonical graph while preserving Kdenlive namespaced metadata', () => {
    const project = createDemoProject('Kdenlive Round Trip');
    project.sequences[0]?.markers.push({
      name: 'Review',
      color: 'BLUE',
      start: 48,
      duration: 0,
      comment: 'Director note',
      extras: { metadata: { kdenlive: { type: 3 } } },
    });

    const exported = exportKdenliveOtio(project, {
      mediaLinks: Object.fromEntries(project.assets.map((asset) => [
        asset.fingerprint,
        `file:///tmp/${encodeURIComponent(asset.name)}`,
      ])),
    });
    const imported = importKdenliveOtio(exported.contents);

    expect(projectDigest(imported.project)).toBe(projectDigest(project));
    expect(imported.project.sequences[0]?.markers[0]?.extras).toEqual({
      metadata: { kdenlive: { type: 3 } },
    });
    expect(imported.report.losses.some(({ feature }) => feature === 'unsupported-otio')).toBe(false);
  });

  it('repairs Kdenlive audio media availability exported with a zero rate', () => {
    const value = JSON.parse(exportKdenliveOtio(createDemoProject('Kdenlive Audio')).contents) as {
      tracks: { children: Array<{ children: Array<Record<string, unknown>> }> };
    };
    const clip = value.tracks.children
      .flatMap(({ children }) => children)
      .find(({ OTIO_SCHEMA }) => OTIO_SCHEMA === 'Clip.2');
    if (!clip) throw new Error('Fixture clip is missing');
    const references = clip.media_references as {
      DEFAULT_MEDIA: { available_range: { start_time: { rate: number }; duration: { rate: number } } };
    };
    references.DEFAULT_MEDIA.available_range.start_time.rate = 0;
    references.DEFAULT_MEDIA.available_range.duration.rate = 0;

    const imported = importKdenliveOtio(value);

    expect(imported.project.assets[0]?.durationFrames).toBeGreaterThan(0);
    expect(imported.unsupported).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: expect.stringContaining('available_range'),
        reason: expect.stringContaining('interpreted at the clip source rate'),
      }),
    ]));
    expect(imported.report.losses).toEqual(expect.arrayContaining([
      expect.objectContaining({ feature: 'source-ranges', support: 'best-effort', count: 1 }),
    ]));
    expect(imported.report.losses.some(({ feature }) => feature === 'unsupported-otio')).toBe(false);
  });

  it('produces OTIO JSON accepted by the installed OpenTimelineIO runtime when available', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'snipsnap-kdenlive-'));
    const filePath = path.join(directory, 'handoff.otio');
    try {
      writeFileSync(filePath, exportKdenliveOtio(createDemoProject()).contents, 'utf8');
      const parsed = spawnSync('python3', ['-c', [
        'import opentimelineio as otio,sys',
        'value=otio.adapters.read_from_file(sys.argv[1])',
        'assert isinstance(value, otio.schema.Timeline)',
      ].join(';'), filePath], { encoding: 'utf8' });
      if (parsed.error && 'code' in parsed.error && parsed.error.code === 'ENOENT') return;
      if (parsed.status !== 0 && /No module named ['"]opentimelineio/u.test(parsed.stderr)) return;
      expect(parsed.stderr).toBe('');
      expect(parsed.status).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

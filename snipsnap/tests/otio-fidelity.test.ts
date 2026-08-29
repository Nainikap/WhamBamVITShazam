import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { exportOtio, importOtio } from '../src/adapters/otio';
import { semanticDiff } from '../src/diff';
import { reconcileImportedProject } from '../src/application/source-sync';

const FIXTURE = path.join(__dirname, 'fixtures/resolve-real-export.otio');

describe('real Resolve OTIO', () => {
  {
    it('imports a real export with no drift and no dropped content', () => {
      const contents = readFileSync(FIXTURE, 'utf8');
      const first = importOtio(contents);
      expect(first.unsupported).toEqual([]);
      expect(first.project.assets.every(({ name }) => name !== 'watch')).toBe(true);

      // Re-reading the same export must report nothing to review.
      const rescan = reconcileImportedProject(first.project, importOtio(contents).project);
      expect(semanticDiff(first.project, rescan)).toEqual([]);

      // Committing and re-importing our own export must be stable too.
      const round = importOtio(exportOtio(first.project, { mediaLinks: first.mediaLinks }));
      expect(semanticDiff(first.project, reconcileImportedProject(first.project, round.project))).toEqual([]);
    });
  }

  it('notices a marker added to a real timeline', () => {
    const contents = readFileSync(FIXTURE, 'utf8');
    const base = importOtio(contents).project;
    const document = JSON.parse(contents) as {
      tracks: { children: Array<{ children: Array<Record<string, unknown>> }> };
    };
    const clip = document.tracks.children[0]?.children[0];
    if (!clip) throw new Error('Fixture clip missing');
    clip.markers = [{
      OTIO_SCHEMA: 'Marker.2',
      name: 'Recheck this beat',
      color: 'YELLOW',
      comment: '',
      marked_range: {
        OTIO_SCHEMA: 'TimeRange.1',
        start_time: { OTIO_SCHEMA: 'RationalTime.1', value: 120, rate: 60 },
        duration: { OTIO_SCHEMA: 'RationalTime.1', value: 0, rate: 60 },
      },
    }];

    const changed = reconcileImportedProject(base, importOtio(document).project);
    const hunks = semanticDiff(base, changed);
    expect(hunks).toEqual([expect.objectContaining({
      entityType: 'clip',
      fieldGroup: 'markers',
      message: expect.stringContaining('added 1 markers'),
    })]);
  });
});

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { importOtio } from '../src/adapters/otio';
import { importKdenliveProject } from '../src/adapters/kdenlive';
import { reconcileImportedProject } from '../src/application/source-sync';
import { semanticDiff } from '../src/diff';
import { deterministicUuid } from '../src/domain';
import { KDENLIVE_NATIVE_FIXTURE } from './fixtures/kdenlive-native';

const fixture = readFileSync(path.join(__dirname, 'fixtures', 'resolve-basic.otio'), 'utf8');

function withoutVideoGitMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutVideoGitMetadata);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    key === 'metadata' ? {} : withoutVideoGitMetadata(child),
  ]));
}

describe('Resolve source synchronization', () => {
  it('preserves stable clip identities when Resolve rewrites and reorders OTIO', () => {
    const clean = withoutVideoGitMetadata(JSON.parse(fixture) as unknown) as Record<string, unknown>;
    const base = importOtio(clean).project;
    const changed = structuredClone(clean) as {
      tracks: { children: Array<{ children: Array<{ name?: string; source_range?: { duration: { value: number } } }> }> };
    };
    const videoTrack = changed.tracks.children[0];
    if (!videoTrack || videoTrack.children.length < 2) throw new Error('Fixture requires two video items');
    const first = videoTrack.children[0];
    if (!first?.source_range) throw new Error('Fixture clip range missing');
    first.source_range.duration.value -= 1;
    videoTrack.children.reverse();

    const reconciled = reconcileImportedProject(base, importOtio(changed).project);
    const baseIds = new Map(base.clips.map((clip) => [clip.name, clip.id]));
    expect(reconciled.clips.map((clip) => [clip.name, clip.id])).toEqual(
      expect.arrayContaining([...baseIds].map(([name, id]) => [name, id])),
    );
    const hunks = semanticDiff(base, reconciled);
    expect(hunks.some(({ operation }) => operation === 'modify')).toBe(true);
    expect(hunks.filter(({ entityType }) => entityType === 'clip').every(({ operation }) => operation !== 'add' && operation !== 'delete')).toBe(true);
  });

  it('keeps downstream identities stable and reports one change for a metadata-free blade cut', () => {
    const clean = withoutVideoGitMetadata(JSON.parse(fixture) as unknown) as {
      tracks: { children: Array<{ children: Array<{
        name?: string;
        source_range?: {
          start_time: { value: number };
          duration: { value: number };
        };
      }> }> };
    };
    const base = importOtio(clean).project;
    const changed = structuredClone(clean);
    const videoTrack = changed.tracks.children[0];
    const opening = videoTrack?.children[0];
    if (!videoTrack || !opening?.source_range) throw new Error('Fixture opening clip missing');
    const secondHalf = structuredClone(opening);
    const half = opening.source_range.duration.value / 2;
    opening.source_range.duration.value = half;
    if (!secondHalf.source_range) throw new Error('Split clip range missing');
    secondHalf.source_range.start_time.value += half;
    secondHalf.source_range.duration.value = half;
    videoTrack.children.splice(1, 0, secondHalf);

    const reconciled = reconcileImportedProject(base, importOtio(changed).project);
    expect(reconciled.gaps.map(({ id }) => id)).toEqual(base.gaps.map(({ id }) => id));
    expect(reconciled.transitions.map(({ id }) => id)).toEqual(base.transitions.map(({ id }) => id));
    expect(semanticDiff(base, reconciled)).toEqual([
      expect.objectContaining({ fieldGroup: 'split', message: 'Split clip Opening into 2 clips' }),
    ]);
  });

  it('reconciles transition references when Resolve rewrites track identities', () => {
    const base = importOtio(fixture).project;
    const imported = structuredClone(base);
    for (const [index, track] of imported.tracks.entries()) {
      const oldId = track.id;
      const rewrittenId = `${String(index + 1).padStart(8, '0')}-1111-5111-8111-111111111111`;
      track.id = rewrittenId;
      for (const sequence of imported.sequences) {
        sequence.trackIds = sequence.trackIds.map((id) => id === oldId ? rewrittenId : id);
      }
      for (const item of [...imported.clips, ...imported.gaps, ...imported.transitions, ...imported.captions]) {
        if (item.trackId === oldId) item.trackId = rewrittenId;
      }
    }

    const reconciled = reconcileImportedProject(base, imported);
    expect(reconciled.transitions).toEqual(base.transitions);
    expect(reconciled.tracks.map(({ itemIds }) => itemIds)).toEqual(base.tracks.map(({ itemIds }) => itemIds));
  });

  it('keeps a moved Kdenlive clip stable when the editor also rewrites its asset ID', () => {
    const base = importKdenliveProject(KDENLIVE_NATIVE_FIXTURE, { sourceIdentity: '/edit/project/sample.kdenlive' }).project;
    const movedDocument = KDENLIVE_NATIVE_FIXTURE
      .replace('{11111111-1111-4111-8111-111111111111}', '{33333333-3333-4333-8333-333333333333}')
      .replace('  <playlist id="video-playlist">\n    <blank length="00:00:01.000"/>', '  <playlist id="video-playlist">');
    const imported = importKdenliveProject(movedDocument, { sourceIdentity: '/edit/project/sample.kdenlive' }).project;
    const moved = imported.clips.find(({ name }) => name === 'shot.mp4');
    const movedTrack = imported.tracks.find(({ id }) => id === moved?.trackId);
    if (!moved || !movedTrack) throw new Error('Moved Kdenlive fixture clip is missing');
    const rewrittenId = deterministicUuid('Kdenlive rewrote the timeline item ID');
    movedTrack.itemIds = movedTrack.itemIds.map((id) => id === moved.id ? rewrittenId : id);
    moved.id = rewrittenId;

    const reconciled = reconcileImportedProject(base, imported);
    const original = base.clips.find(({ name }) => name === 'shot.mp4');
    expect(reconciled.clips.find(({ name }) => name === 'shot.mp4')?.id).toBe(original?.id);
    expect(semanticDiff(base, reconciled)).toEqual([
      expect.objectContaining({
        entityId: original?.id,
        fieldGroup: 'timelinePosition',
        message: 'Moved clip shot.mp4 25 frames earlier',
      }),
    ]);
  });
});

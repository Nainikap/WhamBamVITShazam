import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { reduceCommand } from '../src/commands';
import { createDemoProject, deterministicUuid } from '../src/domain';
import { completeMerge, mergeThreeWay, resolveMerge } from '../src/merge';

describe('conservative three-way merge', () => {
  it('combines independent edits without losing either branch', () => {
    const base = createDemoProject();
    const first = base.clips[0];
    const caption = base.captions[0];
    if (!first || !caption) throw new Error('Fixture is incomplete');
    const ours = reduceCommand(base, { type: 'setClipPreset', clipId: first.id, preset: 'warm' });
    const theirs = reduceCommand(base, { type: 'updateCaption', captionId: caption.id, text: 'A better line' });

    const result = mergeThreeWay(base, ours, theirs);
    expect(result.conflicts).toEqual([]);
    const merged = completeMerge(result);
    expect(merged.clips[0]?.preset).toBe('warm');
    expect(merged.captions[0]?.text).toBe('A better line');
  });

  it('makes same-field edits explicit and accepts a deliberate choice', () => {
    const base = createDemoProject();
    const clip = base.clips[0];
    if (!clip) throw new Error('Fixture clip missing');
    const ours = reduceCommand(base, { type: 'setClipGain', clipId: clip.id, gainDb: -3 });
    const theirs = reduceCommand(base, { type: 'setClipGain', clipId: clip.id, gainDb: -9 });

    const result = mergeThreeWay(base, ours, theirs);
    expect(result.conflicts[0]).toEqual(expect.objectContaining({ type: 'same-field', fieldGroup: 'gainDb' }));
    expect(() => completeMerge(result)).toThrow(/unresolved conflicts/u);
    const conflict = result.conflicts[0];
    if (!conflict) throw new Error('Expected a conflict');
    const resolved = resolveMerge(result, [{ conflictId: conflict.id, choice: 'theirs' }]);
    expect(completeMerge(resolved).clips[0]?.gainDb).toBe(-9);
  });

  it('reports delete versus modify and does not invent editorial intent', () => {
    const base = createDemoProject();
    const clip = base.clips[0];
    if (!clip) throw new Error('Fixture clip missing');
    const ours = structuredClone(base);
    ours.clips = ours.clips.filter(({ id }) => id !== clip.id);
    const oursTrack = ours.tracks[0];
    if (!oursTrack) throw new Error('Fixture track missing');
    oursTrack.itemIds = oursTrack.itemIds.filter((id) => id !== clip.id);
    const theirs = reduceCommand(base, { type: 'setClipPreset', clipId: clip.id, preset: 'mono' });

    const result = mergeThreeWay(base, ours, theirs);
    const deleteConflict = result.conflicts.find(({ type }) => type === 'delete-modify');
    expect(deleteConflict).toBeDefined();
    if (!deleteConflict) throw new Error('Delete conflict missing');
    const restored = completeMerge(resolveMerge(result, [{ conflictId: deleteConflict.id, choice: 'theirs' }]));
    expect(restored.clips.find(({ id }) => id === clip.id)?.preset).toBe('mono');
    expect(restored.tracks[0]?.itemIds).toEqual(base.tracks[0]?.itemIds);
  });

  it('turns invalid combined timing into a validation conflict', () => {
    const base = createDemoProject();
    const clip = base.clips[0];
    const asset = base.assets[0];
    if (!clip || !asset) throw new Error('Fixture is incomplete');
    const ours = structuredClone(base);
    const oursAsset = ours.assets[0];
    if (!oursAsset) throw new Error('Fixture asset missing');
    oursAsset.durationFrames = 150;
    const theirs = reduceCommand(base, { type: 'trimClip', clipId: clip.id, start: 120, duration: 100 });

    const result = mergeThreeWay(base, ours, theirs);
    expect(result.conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'validation', validationErrors: expect.arrayContaining([expect.stringContaining('exceeds')]) }),
    ]));

    const validation = result.conflicts.find(({ type }) => type === 'validation');
    if (!validation) throw new Error('Validation conflict missing');
    const resolved = resolveMerge(result, [{ conflictId: validation.id, choice: 'theirs' }]);
    expect(resolved.conflicts).toEqual([]);
    expect(completeMerge(resolved).clips[0]?.sourceRange).toEqual({ start: 120, duration: 100 });
  });

  it('reports incompatible clip ordering instead of inventing an order', () => {
    const base = createDemoProject();
    const track = base.tracks[0];
    if (!track) throw new Error('Fixture track missing');
    const gapId = deterministicUuid(`${track.id}:gap`);
    base.gaps.push({ id: gapId, type: 'gap', trackId: track.id, durationFrames: 12 });
    track.itemIds.push(gapId);
    const [first, second, third] = track.itemIds;
    if (!first || !second || !third) throw new Error('Fixture order missing');
    const ours = reduceCommand(base, { type: 'reorderTrack', trackId: track.id, itemIds: [second, first, third] });
    const theirs = reduceCommand(base, { type: 'reorderTrack', trackId: track.id, itemIds: [first, third, second] });

    const result = mergeThreeWay(base, ours, theirs);
    expect(result.conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'order', fieldGroup: 'itemIds' }),
    ]));
    expect(() => completeMerge(result)).toThrow(/unresolved conflicts/u);
  });

  it('preserves independent edits over generated valid gain values', () => {
    fc.assert(fc.property(
      fc.float({ min: -60, max: 12, noNaN: true }),
      fc.constantFrom('warm', 'cool', 'mono') as fc.Arbitrary<'warm' | 'cool' | 'mono'>,
      (gainDb, preset) => {
        const base = createDemoProject();
        const first = base.clips[0];
        const second = base.clips[1];
        if (!first || !second) return false;
        const ours = reduceCommand(base, { type: 'setClipGain', clipId: first.id, gainDb });
        const theirs = reduceCommand(base, { type: 'setClipPreset', clipId: second.id, preset });
        const merged = completeMerge(mergeThreeWay(base, ours, theirs));
        return merged.clips[0]?.gainDb === gainDb && merged.clips[1]?.preset === preset;
      },
    ));
  });
});

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { reduceCommand } from '../src/commands';
import { createDemoProject, decorations, deterministicUuid } from '../src/domain';
import { combinePlan, completeMerge, describeConflict, mergeOrders, mergeThreeWay, resolveMerge } from '../src/merge';

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

  it('preserves project metadata changed only by the incoming branch', () => {
    const base = createDemoProject();
    const ours = structuredClone(base);
    const theirs = structuredClone(base);
    theirs.extras = { resolve: { colorScience: 'DaVinci YRGB Color Managed' } };

    const merged = completeMerge(mergeThreeWay(base, ours, theirs));
    expect(merged.extras).toEqual(theirs.extras);
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

  it('restores a surviving transition between its original neighbours', () => {
    const base = createDemoProject();
    const transition = base.transitions[0];
    const track = base.tracks.find(({ id }) => id === transition?.trackId);
    if (!transition || !track) throw new Error('Fixture transition missing');
    const ours = structuredClone(base);
    ours.transitions = ours.transitions.filter(({ id }) => id !== transition.id);
    const oursTrack = ours.tracks.find(({ id }) => id === track.id);
    if (!oursTrack) throw new Error('Fixture track missing');
    oursTrack.itemIds = oursTrack.itemIds.filter((id) => id !== transition.id);
    const theirs = structuredClone(base);
    const changed = theirs.transitions.find(({ id }) => id === transition.id);
    if (!changed) throw new Error('Fixture transition missing');
    changed.name = 'Long dissolve';

    const result = mergeThreeWay(base, ours, theirs);
    const conflict = result.conflicts.find(({ entityId, type }) => entityId === transition.id && type === 'delete-modify');
    if (!conflict) throw new Error('Expected transition conflict');
    const merged = completeMerge(resolveMerge(result, [{ conflictId: conflict.id, choice: 'theirs' }]));
    expect(merged.tracks.find(({ id }) => id === track.id)?.itemIds).toEqual(track.itemIds);
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
    base.gaps.push({ id: gapId, type: 'gap', trackId: track.id, durationFrames: 12, ...decorations() });
    track.itemIds.push(gapId);
    const [first, second, third, fourth] = track.itemIds;
    if (!first || !second || !third || !fourth) throw new Error('Fixture order missing');
    const ours = reduceCommand(base, { type: 'reorderTrack', trackId: track.id, itemIds: [second, first, third, fourth] });
    const theirs = reduceCommand(base, { type: 'reorderTrack', trackId: track.id, itemIds: [first, third, second, fourth] });

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

describe('keeping both branches', () => {
  it('widens a contested trim to every frame both cuts use', () => {
    const base = createDemoProject();
    const clip = base.clips[0];
    if (!clip) throw new Error('Fixture clip missing');
    const ours = reduceCommand(base, { type: 'trimClip', clipId: clip.id, start: 0, duration: 100 });
    const theirs = reduceCommand(base, { type: 'trimClip', clipId: clip.id, start: 24, duration: 144 });

    const result = mergeThreeWay(base, ours, theirs);
    const conflict = result.conflicts.find(({ fieldGroup }) => fieldGroup === 'sourceRange');
    if (!conflict) throw new Error('Expected a timing conflict');
    expect(combinePlan(conflict).kind).toBe('value');

    const resolved = resolveMerge(result, [{ conflictId: conflict.id, choice: 'both' }]);
    expect(resolved.conflicts).toEqual([]);
    expect(completeMerge(resolved).clips[0]?.sourceRange).toEqual({ start: 0, duration: 168 });
  });

  it('keeps footage that one branch cut and the other edited', () => {
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
    const conflict = result.conflicts.find(({ type }) => type === 'delete-modify');
    if (!conflict) throw new Error('Expected a delete-modify conflict');

    const merged = completeMerge(resolveMerge(result, [{ conflictId: conflict.id, choice: 'both' }]));
    expect(merged.clips.find(({ id }) => id === clip.id)?.preset).toBe('mono');
    expect(merged.tracks[0]?.itemIds).toEqual(base.tracks[0]?.itemIds);
  });

  it('keeps every item from both running orders', () => {
    const base = createDemoProject();
    const track = base.tracks[0];
    if (!track) throw new Error('Fixture track missing');
    const gapId = deterministicUuid(`${track.id}:gap`);
    base.gaps.push({ id: gapId, type: 'gap', trackId: track.id, durationFrames: 12, ...decorations() });
    track.itemIds.push(gapId);
    const [first, second, third, fourth] = track.itemIds;
    if (!first || !second || !third || !fourth) throw new Error('Fixture order missing');
    const ours = reduceCommand(base, { type: 'reorderTrack', trackId: track.id, itemIds: [second, first, third, fourth] });
    const theirs = reduceCommand(base, { type: 'reorderTrack', trackId: track.id, itemIds: [first, third, second, fourth] });

    const result = mergeThreeWay(base, ours, theirs);
    const conflict = result.conflicts.find(({ type }) => type === 'order');
    if (!conflict) throw new Error('Expected an order conflict');

    const merged = completeMerge(resolveMerge(result, [{ conflictId: conflict.id, choice: 'both' }]));
    expect(merged.tracks[0]?.itemIds).toHaveLength(4);
    expect([...merged.tracks[0]?.itemIds ?? []].sort()).toEqual([first, second, third, fourth].sort());
  });

  it('keeps both takes when the branches point one clip at different footage', () => {
    const base = createDemoProject();
    const clip = base.clips[0];
    const [, interviewAsset, musicAsset] = base.assets;
    if (!clip || !interviewAsset || !musicAsset) throw new Error('Fixture is incomplete');
    const withAsset = (assetId: string) => {
      const next = structuredClone(base);
      const target = next.clips.find(({ id }) => id === clip.id);
      if (!target) throw new Error('Fixture clip missing');
      target.assetId = assetId;
      return next;
    };

    const result = mergeThreeWay(base, withAsset(interviewAsset.id), withAsset(musicAsset.id));
    const conflict = result.conflicts.find(({ fieldGroup }) => fieldGroup === 'assetId');
    if (!conflict) throw new Error('Expected a footage conflict');
    expect(combinePlan(conflict).kind).toBe('duplicate');

    const merged = completeMerge(resolveMerge(result, [{ conflictId: conflict.id, choice: 'both' }]));
    const track = merged.tracks[0];
    if (!track) throw new Error('Merged track missing');
    expect(track.itemIds).toHaveLength(4);
    expect(track.itemIds[0]).toBe(clip.id);
    const duplicate = merged.clips.find(({ id }) => id === track.itemIds[1]);
    expect(merged.clips.find(({ id }) => id === clip.id)?.assetId).toBe(interviewAsset.id);
    expect(duplicate?.assetId).toBe(musicAsset.id);
    expect(duplicate?.trackId).toBe(track.id);
  });

  it('refuses to invent a combination for a single-value field', () => {
    const base = createDemoProject();
    const clip = base.clips[0];
    if (!clip) throw new Error('Fixture clip missing');
    const ours = reduceCommand(base, { type: 'setClipGain', clipId: clip.id, gainDb: -3 });
    const theirs = reduceCommand(base, { type: 'setClipGain', clipId: clip.id, gainDb: -9 });

    const result = mergeThreeWay(base, ours, theirs);
    const conflict = result.conflicts[0];
    if (!conflict) throw new Error('Expected a level conflict');
    expect(combinePlan(conflict).kind).toBe('unavailable');
    expect(() => resolveMerge(result, [{ conflictId: conflict.id, choice: 'both' }]))
      .toThrow(/Cannot keep both sides/u);
  });

  it('merges two orders without losing or duplicating an identity', () => {
    expect(mergeOrders(['b', 'a', 'c'], ['a', 'c', 'b'])).toEqual(['b', 'a', 'c']);
    expect(mergeOrders(['a', 'b'], ['a', 'x', 'b', 'y'])).toEqual(['a', 'x', 'b', 'y']);
  });
});

describe('conflict briefs', () => {
  it('names the audio track and both timestamps behind a timing conflict', () => {
    const base = createDemoProject();
    const voice = base.clips.find(({ name }) => name === 'Interview VO');
    if (!voice) throw new Error('Fixture audio clip missing');
    const ours = reduceCommand(base, { type: 'trimClip', clipId: voice.id, start: 240, duration: 200 });
    const theirs = reduceCommand(base, { type: 'trimClip', clipId: voice.id, start: 260, duration: 244 });

    const result = mergeThreeWay(base, ours, theirs);
    const conflict = result.conflicts.find(({ fieldGroup }) => fieldGroup === 'sourceRange');
    if (!conflict) throw new Error('Expected a timing conflict');
    const brief = describeConflict(conflict, result.alternatives);

    expect(brief.category).toBe('timing');
    expect(brief.scope).toBe('audio');
    expect(brief.trackName).toBe('A1');
    expect(brief.current.summary).toContain('00:00:10:00');
    expect(brief.incoming.summary).toContain('00:00:10:20');
    expect(brief.combination.available).toBe(true);
  });

  it('explains why a level conflict cannot be combined', () => {
    const base = createDemoProject();
    const clip = base.clips[0];
    if (!clip) throw new Error('Fixture clip missing');
    const result = mergeThreeWay(
      base,
      reduceCommand(base, { type: 'setClipGain', clipId: clip.id, gainDb: -3 }),
      reduceCommand(base, { type: 'setClipGain', clipId: clip.id, gainDb: -9 }),
    );
    const conflict = result.conflicts[0];
    if (!conflict) throw new Error('Expected a level conflict');
    const brief = describeConflict(conflict, result.alternatives);

    expect(brief.category).toBe('level');
    expect(brief.scope).toBe('video');
    expect(brief.current.summary).toBe('-3 dB');
    expect(brief.combination.available).toBe(false);
  });
});

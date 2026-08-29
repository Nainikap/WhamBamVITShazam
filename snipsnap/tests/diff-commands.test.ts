import { describe, expect, it } from 'vitest';
import { reduceCommand } from '../src/commands';
import { applySemanticHunks, semanticDiff, StaleHunkError } from '../src/diff';
import { createDemoProject, projectDigest, type Project } from '../src/domain';

describe('commands and semantic staging', () => {
  it('emits human semantic hunks with atomic trim ranges', () => {
    const base = createDemoProject();
    const clip = base.clips[0];
    if (!clip) throw new Error('Fixture clip missing');
    const working = reduceCommand(base, { type: 'trimClip', clipId: clip.id, start: 12, duration: 120 });
    const hunks = semanticDiff(base, working);

    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toEqual(expect.objectContaining({
      entityId: clip.id,
      fieldGroup: 'sourceRange',
      message: 'Trimmed clip Intro',
      before: { start: 0, duration: 144 },
      after: { start: 12, duration: 120 },
    }));
  });

  it('stages only selected semantic edits into a complete validated snapshot', () => {
    const head = createDemoProject();
    const first = head.clips[0];
    const second = head.clips[1];
    if (!first || !second) throw new Error('Fixture clips missing');
    let working = reduceCommand(head, { type: 'trimClip', clipId: first.id, start: 24, duration: 100 });
    working = reduceCommand(working, { type: 'setClipPreset', clipId: second.id, preset: 'warm' });
    const hunks = semanticDiff(head, working);
    const trim = hunks.find(({ entityId }) => entityId === first.id);
    if (!trim) throw new Error('Trim hunk missing');

    const index = applySemanticHunks(head, working, [trim.id], projectDigest(head));
    expect(index.clips[0]?.sourceRange).toEqual({ start: 24, duration: 100 });
    expect(index.clips[1]?.preset).toBe('none');
    expect(semanticDiff(index, working)).toHaveLength(1);
  });

  it('rejects stale hunk application', () => {
    const head = createDemoProject();
    const clip = head.clips[0];
    if (!clip) throw new Error('Fixture clip missing');
    const working = reduceCommand(head, { type: 'setClipGain', clipId: clip.id, gainDb: -6 });
    const hunk = semanticDiff(head, working)[0];
    if (!hunk) throw new Error('Gain hunk missing');
    const changedIndex = reduceCommand(head, { type: 'setClipPreset', clipId: clip.id, preset: 'cool' });

    expect(() => applySemanticHunks(changedIndex, working, [hunk.id], projectDigest(head)))
      .toThrow(StaleHunkError);
  });

  it('rejects commands that create invalid source timing', () => {
    const project = createDemoProject();
    const clip = project.clips[0];
    if (!clip) throw new Error('Fixture clip missing');
    expect(() => reduceCommand(project, { type: 'trimClip', clipId: clip.id, start: 470, duration: 20 }))
      .toThrow(/exceeds its asset duration/u);
  });

  it('requires reorder commands to preserve the exact item set', () => {
    const project = createDemoProject();
    const track = project.tracks[0];
    if (!track) throw new Error('Fixture track missing');
    expect(() => reduceCommand(project, { type: 'reorderTrack', trackId: track.id, itemIds: [track.itemIds[0] as string] }))
      .toThrow(/every existing track item/u);
  });

  it('represents track order as one atomic semantic hunk', () => {
    const project = createDemoProject();
    const track = project.tracks[0];
    if (!track) throw new Error('Fixture track missing');
    const working = reduceCommand(project, {
      type: 'reorderTrack',
      trackId: track.id,
      itemIds: [...track.itemIds].reverse(),
    });
    expect(semanticDiff(project, working)).toEqual([
      expect.objectContaining({ operation: 'reorder', fieldGroup: 'itemIds', entityId: track.id }),
    ]);
  });

  it('tracks every editor change, not only cuts', () => {
    const base = createDemoProject();
    const head = structuredClone(base) as Project;
    const clip = head.clips[0];
    const track = head.tracks[0];
    const transition = head.transitions[0];
    const sequence = head.sequences[0];
    if (!clip || !track || !transition || !sequence) throw new Error('Fixture is incomplete');
    clip.enabled = false;
    clip.color = 'Orange';
    clip.markers = [{ name: 'Fix', color: 'RED', start: 2, duration: 1, comment: 'regrade', extras: {} }];
    clip.effects = [{ name: 'Blur', schema: 'Effect.1', parameters: { amount: 2 } }];
    clip.extras = { Resolve_OTIO: { Retime: 'Freeze' } };
    track.enabled = false;
    transition.transitionType = 'SMPTE_Wipe';
    transition.inOffsetFrames = 24;
    sequence.globalStartFrame = 3600;
    sequence.markers = [{ name: 'Act two', color: 'GREEN', start: 100, duration: 0, comment: '', extras: {} }];
    head.extras = { Resolve_OTIO: { ColourScience: 'DaVinci YRGB' } };

    const fields = semanticDiff(base, head).map(({ entityType, fieldGroup }) => `${entityType}.${fieldGroup}`);
    expect(fields).toEqual(expect.arrayContaining([
      'clip.enabled', 'clip.color', 'clip.markers', 'clip.effects', 'clip.extras',
      'track.enabled',
      'transition.transitionType', 'transition.inOffsetFrames',
      'sequence.globalStartFrame', 'sequence.markers',
      'project.extras',
    ]));
  });

  it('reports no change when nothing was edited', () => {
    expect(semanticDiff(createDemoProject(), createDemoProject())).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { reduceCommand } from '../src/commands';
import { applySemanticHunks, semanticDiff, StaleHunkError } from '../src/diff';
import { createDemoProject, decorations, deterministicUuid, projectDigest, validateProject, type Project } from '../src/domain';

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
      message: 'Trimmed both ends of clip Intro',
      before: { start: 0, duration: 144 },
      after: { start: 12, duration: 120 },
    }));
  });

  it('represents a blade cut as one atomic, accurately named change', () => {
    const base = createDemoProject();
    const clip = base.clips[0];
    const track = base.tracks.find(({ id }) => id === clip?.trackId);
    if (!clip || !track) throw new Error('Fixture clip missing');
    const working = structuredClone(base);
    const firstHalf = working.clips.find(({ id }) => id === clip.id);
    if (!firstHalf) throw new Error('Fixture clip missing');
    firstHalf.sourceRange.duration = 72;
    const secondId = deterministicUuid(`${clip.id}:split:72`);
    working.clips.push({
      ...structuredClone(firstHalf),
      id: secondId,
      sourceRange: { start: 72, duration: 72 },
    });
    const workingTrack = working.tracks.find(({ id }) => id === track.id);
    if (!workingTrack) throw new Error('Fixture track missing');
    workingTrack.itemIds.splice(workingTrack.itemIds.indexOf(clip.id) + 1, 0, secondId);
    validateProject(working);

    const hunks = semanticDiff(base, working);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toMatchObject({
      entityType: 'clip',
      entityId: clip.id,
      fieldGroup: 'split',
      message: 'Split clip Intro into 2 clips',
      parts: expect.arrayContaining([
        expect.objectContaining({ operation: 'modify', fieldGroup: 'sourceRange' }),
        expect.objectContaining({ operation: 'add', fieldGroup: 'entity' }),
      ]),
    });
    expect(applySemanticHunks(base, working, [hunks[0]?.id as string], projectDigest(base))).toEqual(working);

    const reverse = semanticDiff(working, base);
    expect(reverse).toHaveLength(1);
    expect(reverse[0]).toMatchObject({ fieldGroup: 'split', message: 'Joined 2 clips into Intro' });
    expect(applySemanticHunks(working, base, [reverse[0]?.id as string], projectDigest(working))).toEqual(base);
  });

  it('groups a new track, clip, and media asset into one valid staged change', () => {
    const base = createDemoProject();
    const working = structuredClone(base);
    const sequence = working.sequences[0];
    if (!sequence) throw new Error('Fixture sequence missing');
    const trackId = deterministicUuid(`${sequence.id}:overlay-track`);
    const assetId = deterministicUuid(`${base.id}:title-asset`);
    const clipId = deterministicUuid(`${trackId}:title`);
    working.assets.push({
      id: assetId,
      name: 'Title generator',
      fingerprint: 'a'.repeat(64),
      durationFrames: 48,
      extras: { generator: true },
    });
    working.clips.push({
      id: clipId,
      type: 'clip',
      trackId,
      name: 'Opening title',
      assetId,
      sourceRange: { start: 0, duration: 48 },
      gainDb: 0,
      preset: 'none',
      color: null,
      ...decorations(),
    });
    working.tracks.push({
      id: trackId,
      sequenceId: sequence.id,
      name: 'V2',
      kind: 'video',
      itemIds: [clipId],
      ...decorations(),
    });
    sequence.trackIds.push(trackId);
    validateProject(working);

    const hunks = semanticDiff(base, working);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toMatchObject({
      entityType: 'track',
      fieldGroup: 'structure',
      message: 'Added track V2 with 1 timeline item',
    });
    expect(applySemanticHunks(base, working, [hunks[0]?.id as string], projectDigest(base))).toEqual(working);
    const reverse = semanticDiff(working, base);
    expect(reverse).toHaveLength(1);
    expect(reverse[0]).toMatchObject({
      entityType: 'track',
      fieldGroup: 'structure',
      message: 'Deleted track V2 with 1 timeline item',
    });
    expect(applySemanticHunks(working, base, [reverse[0]?.id as string], projectDigest(working))).toEqual(base);
  });

  it('names end trims with their exact frame delta', () => {
    const base = createDemoProject();
    const clip = base.clips[0];
    if (!clip) throw new Error('Fixture clip missing');
    const working = reduceCommand(base, { type: 'trimClip', clipId: clip.id, start: 0, duration: 120 });
    expect(semanticDiff(base, working)[0]?.message).toBe('Trimmed end of clip Intro by 24 frames');
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
      expect.objectContaining({
        operation: 'modify',
        fieldGroup: 'timelinePosition',
        message: 'Repositioned 2 clips on the timeline',
        parts: [expect.objectContaining({ operation: 'reorder', fieldGroup: 'itemIds', entityId: track.id })],
      }),
    ]);
  });

  it('shows linked video and audio moves separately while keeping audio streams atomic', () => {
    const projectId = deterministicUuid('linked-move-project');
    const sequenceId = deterministicUuid('linked-move-sequence');
    const assetId = deterministicUuid('linked-move-asset');
    const trackIds = [0, 1, 2].map((index) => deterministicUuid(`linked-move-track-${index}`));
    const clipIds = trackIds.map((_, index) => deterministicUuid(`linked-move-clip-${index}`));
    const gapIds = trackIds.map((_, index) => deterministicUuid(`linked-move-gap-${index}`));
    const prefixGapId = deterministicUuid('linked-move-prefix-gap');
    const base = validateProject({
      schemaVersion: 1,
      id: projectId,
      name: 'Linked Move',
      sequences: [{
        id: sequenceId,
        name: 'Main',
        fps: { numerator: 25, denominator: 1 },
        width: 1920,
        height: 1080,
        trackIds,
        globalStartFrame: 0,
        markers: [],
        extras: {},
      }],
      tracks: trackIds.map((id, index) => ({
        id,
        sequenceId,
        name: index === 0 ? 'V1' : `A${index}`,
        kind: index === 0 ? 'video' as const : 'audio' as const,
        itemIds: index === 2
          ? [prefixGapId, gapIds[index] as string, clipIds[index] as string]
          : [gapIds[index] as string, clipIds[index] as string],
        ...decorations(),
      })),
      assets: [{
        id: assetId,
        name: 'big-buck-bunny-sample.mp4',
        fingerprint: 'a'.repeat(64),
        durationFrames: 251,
        extras: {},
      }],
      clips: clipIds.map((id, index) => ({
        id,
        type: 'clip' as const,
        trackId: trackIds[index] as string,
        name: 'big-buck-bunny-sample.mp4',
        assetId,
        sourceRange: { start: 0, duration: 233 },
        gainDb: 0,
        preset: 'none' as const,
        color: null,
        ...decorations(),
      })),
      gaps: gapIds.map((id, index) => ({
        id,
        type: 'gap' as const,
        trackId: trackIds[index] as string,
        durationFrames: index === 2 ? 28 : 177,
        ...decorations(),
      })).concat([{
        id: prefixGapId,
        type: 'gap' as const,
        trackId: trackIds[2] as string,
        durationFrames: 149,
        ...decorations(),
      }]),
      transitions: [],
      captions: [],
      extras: {},
    });
    const working = structuredClone(base);
    const firstGap = working.gaps.find(({ id }) => id === gapIds[0]);
    const secondGap = working.gaps.find(({ id }) => id === gapIds[1]);
    if (!firstGap || !secondGap) throw new Error('Linked move fixture gaps are missing');
    firstGap.durationFrames -= 28;
    secondGap.durationFrames -= 28;
    working.gaps = working.gaps.filter(({ id }) => id !== gapIds[2]);
    const thirdTrack = working.tracks.find(({ id }) => id === trackIds[2]);
    if (!thirdTrack) throw new Error('Linked move fixture track is missing');
    thirdTrack.itemIds = thirdTrack.itemIds.filter((id) => id !== gapIds[2]);
    // Simulate the legacy Kdenlive adapter changing an item's generated ID
    // when removal of the preceding gap shifted its playlist index.
    const thirdClip = working.clips.find(({ id }) => id === clipIds[2]);
    if (!thirdClip) throw new Error('Linked move fixture clip is missing');
    const rewrittenClipId = deterministicUuid('linked-move-rewritten-clip');
    thirdTrack.itemIds = thirdTrack.itemIds.map((id) => id === thirdClip.id ? rewrittenClipId : id);
    thirdClip.id = rewrittenClipId;
    validateProject(working);

    const hunks = semanticDiff(base, working);
    expect(hunks).toHaveLength(2);
    expect(hunks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        entityType: 'clip',
        operation: 'modify',
        fieldGroup: 'timelinePosition',
        message: 'Moved clip big-buck-bunny-sample.mp4 28 frames earlier',
        parts: [expect.objectContaining({
          entityType: 'gap',
          operation: 'modify',
          entityId: gapIds[0],
        })],
      }),
      expect.objectContaining({
        entityType: 'clip',
        operation: 'modify',
        fieldGroup: 'timelinePosition',
        message: 'Moved audio clip big-buck-bunny-sample.mp4 28 frames earlier across 2 tracks',
        parts: expect.arrayContaining([
          expect.objectContaining({ entityType: 'clip', operation: 'add' }),
          expect.objectContaining({ entityType: 'clip', operation: 'delete' }),
          expect.objectContaining({ entityType: 'gap', operation: 'modify' }),
          expect.objectContaining({ entityType: 'gap', operation: 'delete' }),
        ]),
      }),
    ]));
    const video = hunks.find(({ message }) => message.startsWith('Moved clip'));
    const audio = hunks.find(({ message }) => message.startsWith('Moved audio clip'));
    if (!video || !audio) throw new Error('Expected separate video and audio move hunks');
    const videoOnly = applySemanticHunks(base, working, [video.id], projectDigest(base));
    expect(videoOnly.gaps.find(({ id }) => id === gapIds[0])?.durationFrames).toBe(149);
    expect(videoOnly.gaps.find(({ id }) => id === gapIds[1])?.durationFrames).toBe(177);
    const audioOnly = applySemanticHunks(base, working, [audio.id], projectDigest(base));
    expect(audioOnly.gaps.find(({ id }) => id === gapIds[0])?.durationFrames).toBe(177);
    expect(audioOnly.gaps.find(({ id }) => id === gapIds[1])?.durationFrames).toBe(149);
    expect(applySemanticHunks(base, working, hunks.map(({ id }) => id), projectDigest(base))).toEqual(working);

    const reverse = semanticDiff(working, base);
    expect(reverse.map(({ message }) => message)).toEqual(expect.arrayContaining([
      'Moved clip big-buck-bunny-sample.mp4 28 frames later',
      'Moved audio clip big-buck-bunny-sample.mp4 28 frames later across 2 tracks',
    ]));
    expect(applySemanticHunks(working, base, reverse.map(({ id }) => id), projectDigest(working))).toEqual(base);
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

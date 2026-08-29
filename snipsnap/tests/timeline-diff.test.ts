import { describe, expect, it } from 'vitest';
import { reduceCommand } from '../src/commands';
import { createDemoProject, decorations, deterministicUuid, projectDigest, type Project } from '../src/domain';
import { buildPreviewPlan, buildTimelineDiff } from '../src/preview';

function plan(project: Project, commitId: string) {
  return buildPreviewPlan(project, commitId, commitId, projectDigest(project), {});
}

function diff(base: Project, head: Project) {
  return buildTimelineDiff(plan(base, 'b'.repeat(40)), plan(head, 'c'.repeat(40)));
}

function lane(result: ReturnType<typeof diff>, kind: 'video' | 'audio' | 'caption') {
  const track = result.tracks.find((candidate) => candidate.kind === kind);
  if (!track) throw new Error(`Expected a ${kind} lane`);
  return track;
}

describe('timeline diff', () => {
  it('reports an unchanged snapshot as unchanged on every lane', () => {
    const result = diff(createDemoProject(), createDemoProject());

    expect(result.counts).toMatchObject({ added: 0, removed: 0, modified: 0, unchanged: 6, addedFrames: 0, removedFrames: 0 });
    expect(result.tracks.map(({ kind, change }) => `${kind}:${change}`))
      .toEqual(['video:unchanged', 'audio:unchanged', 'caption:unchanged']);
  });

  it('marks a retimed video clip as modified and records both timestamps', () => {
    const base = createDemoProject();
    const clip = base.clips[0];
    if (!clip) throw new Error('Fixture clip missing');
    const head = reduceCommand(base, { type: 'trimClip', clipId: clip.id, start: 12, duration: 96 });

    const video = lane(diff(base, head), 'video');
    const trimmed = video.segments[0];
    expect(trimmed?.change).toBe('modified');
    expect(trimmed?.timingChanged).toBe(true);
    expect(trimmed?.changedFields).toContain('trim');
    expect(trimmed?.before).toMatchObject({ sourceStart: 0, duration: 144 });
    expect(trimmed?.after).toMatchObject({ sourceStart: 12, duration: 96 });
    // The clip after it slides earlier, so its position changed even though its trim did not.
    expect(video.segments.find(({ name }) => name === 'Interview'))
      .toMatchObject({ change: 'modified', changedFields: ['position'] });
    expect(video.counts).toMatchObject({ added: 0, removed: 0, modified: 3, unchanged: 0 });
  });

  it('marks new audio footage as added and cut audio footage as removed', () => {
    const base = createDemoProject();
    const audioTrack = base.tracks.find(({ kind }) => kind === 'audio');
    const music = base.clips.find(({ name }) => name === 'Music Bed');
    const asset = base.assets[1];
    if (!audioTrack || !music || !asset) throw new Error('Fixture audio missing');

    const head = structuredClone(base) as Project;
    const headTrack = head.tracks.find(({ id }) => id === audioTrack.id);
    if (!headTrack) throw new Error('Head audio track missing');
    const addedId = deterministicUuid('test:added-audio');
    head.clips = head.clips.filter(({ id }) => id !== music.id);
    head.clips.push({
      id: addedId,
      type: 'clip',
      trackId: audioTrack.id,
      name: 'Room Tone',
      assetId: asset.id,
      sourceRange: { start: 0, duration: 240 },
      gainDb: -18,
      preset: 'none',
      color: null,
      ...decorations(),
    });
    headTrack.itemIds = [addedId, ...headTrack.itemIds.filter((id) => id !== music.id)];

    const audio = lane(diff(base, head), 'audio');
    expect(audio.segments.map(({ name, change }) => `${name}:${change}`))
      .toEqual(['Music Bed:removed', 'Room Tone:added', 'Interview VO:unchanged']);
    expect(audio.counts).toMatchObject({ added: 1, removed: 1, modified: 0, unchanged: 1 });
    expect(audio.change).toBe('modified');
  });

  it('keeps a removed item in the lane so the comparison stays continuous', () => {
    const base = createDemoProject();
    const interview = base.clips.find(({ name }) => name === 'Interview');
    const videoTrack = base.tracks.find(({ kind }) => kind === 'video');
    if (!interview || !videoTrack) throw new Error('Fixture video missing');

    const head = structuredClone(base) as Project;
    head.clips = head.clips.filter(({ id }) => id !== interview.id);
    const headTrack = head.tracks.find(({ id }) => id === videoTrack.id);
    if (!headTrack) throw new Error('Head video track missing');
    headTrack.itemIds = headTrack.itemIds.filter((id) => id !== interview.id);
    head.captions = head.captions.map((caption) => ({ ...caption, range: { start: 0, duration: 96 } }));

    const video = lane(diff(base, head), 'video');
    expect(video.segments.map(({ name, change, laneDuration }) => ({ name, change, laneDuration })))
      .toEqual([
        { name: 'Intro', change: 'unchanged', laneDuration: 144 },
        { name: 'Cross Dissolve', change: 'unchanged', laneDuration: 24 },
        { name: 'Interview', change: 'removed', laneDuration: 360 },
      ]);
    expect(video.segments[2]?.after).toBeUndefined();
    expect(video.segments[2]?.before).toMatchObject({ timelineStart: 144, duration: 360 });
  });

  it('separates a level change from a timing change', () => {
    const base = createDemoProject();
    const voice = base.clips.find(({ name }) => name === 'Interview VO');
    if (!voice) throw new Error('Fixture audio clip missing');
    const head = reduceCommand(base, { type: 'setClipGain', clipId: voice.id, gainDb: -9 });

    const changed = lane(diff(base, head), 'audio').segments.find(({ name }) => name === 'Interview VO');
    expect(changed?.change).toBe('modified');
    expect(changed?.changedFields).toEqual(['gain']);
    expect(changed?.timingChanged).toBe(false);
  });

  it('reports a reordered lane as modified positions rather than adds and removes', () => {
    const base = createDemoProject();
    const track = base.tracks.find(({ kind }) => kind === 'video');
    if (!track) throw new Error('Fixture video track missing');
    const head = reduceCommand(base, { type: 'reorderTrack', trackId: track.id, itemIds: [...track.itemIds].reverse() });

    const video = lane(diff(base, head), 'video');
    expect(video.counts).toMatchObject({ added: 0, removed: 0, modified: 3, unchanged: 0 });
    expect(video.segments.every(({ timingChanged }) => timingChanged)).toBe(true);
  });

  it('reports a whole lane that only one commit has', () => {
    const base = createDemoProject();
    const head = structuredClone(base) as Project;
    const audioTrack = head.tracks.find(({ kind }) => kind === 'audio');
    if (!audioTrack) throw new Error('Fixture audio track missing');
    head.clips = head.clips.filter(({ trackId }) => trackId !== audioTrack.id);
    head.tracks = head.tracks.filter(({ id }) => id !== audioTrack.id);
    head.sequences = head.sequences.map((sequence) => ({
      ...sequence,
      trackIds: sequence.trackIds.filter((id) => id !== audioTrack.id),
    }));

    const audio = lane(diff(base, head), 'audio');
    expect(audio.change).toBe('removed');
    expect(audio.segments.every(({ change }) => change === 'removed')).toBe(true);
  });

  it('shows the frames a trim removed instead of colouring the whole clip', () => {
    const base = createDemoProject();
    const clip = base.clips.find(({ name }) => name === 'Interview');
    if (!clip) throw new Error('Fixture clip missing');
    // Keep the head, drop the last 60 frames of source.
    const head = reduceCommand(base, { type: 'trimClip', clipId: clip.id, start: 240, duration: 300 });

    const trimmed = lane(diff(base, head), 'video').segments.find(({ name }) => name === 'Interview');
    expect(trimmed?.removedFrames).toBe(60);
    expect(trimmed?.addedFrames).toBe(0);
    expect(trimmed?.parts).toEqual([
      { change: 'kept', laneStart: 168, laneDuration: 300, contentStart: 240 },
      { change: 'removed', laneStart: 468, laneDuration: 60, contentStart: 540 },
    ]);
  });

  it('shows the frames a longer trim added as new footage', () => {
    const base = createDemoProject();
    const clip = base.clips.find(({ name }) => name === 'Interview');
    if (!clip) throw new Error('Fixture clip missing');
    // Pull the in point 48 frames earlier and hold 24 frames longer.
    const head = reduceCommand(base, { type: 'trimClip', clipId: clip.id, start: 192, duration: 432 });

    const extended = lane(diff(base, head), 'video').segments.find(({ name }) => name === 'Interview');
    expect(extended?.addedFrames).toBe(72);
    expect(extended?.removedFrames).toBe(0);
    expect(extended?.parts.map(({ change, laneDuration, contentStart }) => ({ change, laneDuration, contentStart })))
      .toEqual([
        { change: 'added', laneDuration: 48, contentStart: 192 },
        { change: 'kept', laneDuration: 360, contentStart: 240 },
        { change: 'added', laneDuration: 24, contentStart: 600 },
      ]);
  });

  it('counts every added and removed frame across the whole comparison', () => {
    const base = createDemoProject();
    const interview = base.clips.find(({ name }) => name === 'Interview');
    const music = base.clips.find(({ name }) => name === 'Music Bed');
    if (!interview || !music) throw new Error('Fixture clips missing');
    let head = reduceCommand(base, { type: 'trimClip', clipId: interview.id, start: 240, duration: 300 });
    head = reduceCommand(head, { type: 'trimClip', clipId: music.id, start: 0, duration: 288 });

    const result = diff(base, head);
    expect(result.counts.removedFrames).toBe(60);
    expect(result.counts.addedFrames).toBe(48);
  });

  it('reports a disabled clip, new markers, and new effects as changes', () => {
    const base = createDemoProject();
    const head = structuredClone(base) as Project;
    const clip = head.clips[0];
    if (!clip) throw new Error('Fixture clip missing');
    clip.enabled = false;
    clip.markers = [{ name: 'Check', color: 'BLUE', start: 4, duration: 1, comment: '', extras: {} }];
    clip.effects = [{ name: 'Blur', schema: 'Effect.1', parameters: { amount: 3 } }];

    const changed = lane(diff(base, head), 'video').segments[0];
    expect(changed?.change).toBe('modified');
    expect(changed?.changedFields).toEqual(expect.arrayContaining(['enabled', 'markers', 'effects']));
    expect(changed?.timingChanged).toBe(false);
    expect(changed?.addedFrames).toBe(0);
  });
});

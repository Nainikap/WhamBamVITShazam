import { describe, expect, it } from 'vitest';
import { createDemoProject, decorations, deterministicUuid, projectDigest } from '../src/domain';
import { buildPreviewPlan } from '../src/preview';

function planFor(project = createDemoProject(), availability: Record<string, { available: boolean; mediaUrl?: string }> = {}) {
  return buildPreviewPlan(project, 'HEAD', 'a'.repeat(40), projectDigest(project), availability);
}

describe('preview plan', () => {
  it('compiles an immutable commit snapshot into ordered playable segments', () => {
    const project = createDemoProject();
    const [intro, interview, music] = project.assets;
    if (!intro || !interview || !music) throw new Error('Fixture assets missing');
    const plan = planFor(project, {
      [intro.fingerprint]: { available: true, mediaUrl: 'snipsnap-media://asset/project/intro' },
      [interview.fingerprint]: { available: false },
      [music.fingerprint]: { available: false },
    });

    expect(plan.commitId).toBe('a'.repeat(40));
    expect(plan.segments.map(({ kind, timelineStart, duration }) => ({ kind, timelineStart, duration }))).toEqual([
      { kind: 'clip', timelineStart: 0, duration: 144 },
      // The dissolve overlaps its neighbours instead of occupying its own time.
      { kind: 'transition', timelineStart: 132, duration: 24 },
      { kind: 'clip', timelineStart: 144, duration: 360 },
    ]);
    expect(plan.totalFrames).toBe(504);
    expect(plan.segments[0]?.available).toBe(true);
    expect(plan.missingAssets).toEqual([
      { fingerprint: interview.fingerprint, name: interview.name },
      { fingerprint: music.fingerprint, name: music.name },
    ]);
  });

  it('lays out every video, audio, and caption lane in sequence order', () => {
    const plan = planFor();

    expect(plan.tracks.map(({ name, kind }) => `${name}:${kind}`)).toEqual(['V1:video', 'A1:audio', 'Captions:caption']);
    const audio = plan.tracks.find(({ kind }) => kind === 'audio');
    expect(audio?.segments.map(({ name, timelineStart, duration, gainDb }) => ({ name, timelineStart, duration, gainDb }))).toEqual([
      { name: 'Music Bed', timelineStart: 0, duration: 240, gainDb: -12 },
      { name: 'Interview VO', timelineStart: 240, duration: 264, gainDb: -3 },
    ]);
    expect(audio?.totalFrames).toBe(504);
    expect(plan.videoTrackName).toBe('V1');
  });

  it('positions captions at their absolute sequence range rather than a running offset', () => {
    const captions = planFor().tracks.find(({ kind }) => kind === 'caption');
    expect(captions?.segments).toEqual([expect.objectContaining({ timelineStart: 72, duration: 96, kind: 'caption' })]);
  });

  it('continues through the highest visible clip when an upper video track outlasts V1', () => {
    const project = createDemoProject();
    const sequence = project.sequences[0];
    const overlayAsset = project.assets.find(({ name }) => name === 'interview.mov');
    if (!sequence || !overlayAsset) throw new Error('Fixture video is missing');
    const trackId = deterministicUuid(`${sequence.id}:video:2`);
    const gapId = deterministicUuid(`${trackId}:gap`);
    const clipId = deterministicUuid(`${trackId}:overlay`);
    sequence.trackIds.splice(1, 0, trackId);
    project.tracks.push({
      id: trackId,
      sequenceId: sequence.id,
      name: 'V2',
      kind: 'video',
      itemIds: [gapId, clipId],
      ...decorations(),
    });
    project.gaps.push({
      id: gapId,
      type: 'gap',
      trackId,
      durationFrames: 124,
      ...decorations(),
    });
    project.clips.push({
      id: clipId,
      type: 'clip',
      trackId,
      name: 'Video 2',
      assetId: overlayAsset.id,
      sourceRange: { start: 10, duration: 380 },
      gainDb: 0,
      preset: 'none',
      color: null,
      ...decorations(),
    });

    const plan = planFor(project, {
      [project.assets[0]?.fingerprint ?? '']: { available: true, mediaUrl: 'snipsnap-media://asset/project/video-1' },
      [overlayAsset.fingerprint]: { available: true, mediaUrl: 'snipsnap-media://asset/project/video-2' },
    });

    expect(plan.totalFrames).toBe(504);
    expect(plan.segments.map(({ name, timelineStart, duration, sourceStart }) => ({
      name, timelineStart, duration, sourceStart,
    }))).toEqual([
      { name: 'Intro', timelineStart: 0, duration: 124, sourceStart: 0 },
      { name: 'Video 2', timelineStart: 124, duration: 380, sourceStart: 10 },
    ]);
  });
});

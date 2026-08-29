import { describe, expect, it } from 'vitest';
import { createDemoProject, projectDigest } from '../src/domain';
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
    expect(plan.segments.map(({ timelineStart, duration }) => ({ timelineStart, duration }))).toEqual([
      { timelineStart: 0, duration: 144 },
      { timelineStart: 144, duration: 360 },
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
});

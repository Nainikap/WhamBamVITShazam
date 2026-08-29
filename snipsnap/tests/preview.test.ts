import { describe, expect, it } from 'vitest';
import { createDemoProject, projectDigest } from '../src/domain';
import { buildPreviewPlan } from '../src/preview';

describe('preview plan', () => {
  it('compiles an immutable commit snapshot into ordered playable segments', () => {
    const project = createDemoProject();
    const firstAsset = project.assets[0];
    const secondAsset = project.assets[1];
    if (!firstAsset || !secondAsset) throw new Error('Fixture assets missing');
    const plan = buildPreviewPlan(project, 'HEAD', 'a'.repeat(40), projectDigest(project), {
      [firstAsset.fingerprint]: { available: true, mediaUrl: 'snipsnap-media://asset/project/first' },
      [secondAsset.fingerprint]: { available: false },
    });

    expect(plan.commitId).toBe('a'.repeat(40));
    expect(plan.segments.map(({ timelineStart, duration }) => ({ timelineStart, duration }))).toEqual([
      { timelineStart: 0, duration: 144 },
      { timelineStart: 144, duration: 360 },
    ]);
    expect(plan.totalFrames).toBe(504);
    expect(plan.segments[0]?.available).toBe(true);
    expect(plan.missingAssets).toEqual([{ fingerprint: secondAsset.fingerprint, name: secondAsset.name }]);
  });
});

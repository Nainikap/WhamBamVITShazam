import { describe, expect, it } from 'vitest';
import { exportKdenliveOtio, importKdenliveProject, importKdenliveOtio } from '../src/adapters/kdenlive';
import { KDENLIVE_NATIVE_FIXTURE } from './fixtures/kdenlive-native';

describe('Kdenlive native project adapter', () => {
  it('reads the active cut timeline in Kdenlive OTIO track order', () => {
    const imported = importKdenliveProject(KDENLIVE_NATIVE_FIXTURE, {
      sourceIdentity: '/edit/project/sample.kdenlive',
      fallbackName: 'sample',
    });

    expect(imported.project).toMatchObject({
      name: 'sample',
      sequences: [{
        name: 'Main sequence',
        fps: { numerator: 25, denominator: 1 },
        width: 1920,
        height: 1080,
      }],
      tracks: [
        { name: 'V1', kind: 'video' },
        { name: 'Voice', kind: 'audio' },
      ],
    });
    expect(imported.project.gaps.map(({ durationFrames }) => durationFrames)).toEqual([25, 10]);
    expect(imported.project.clips.map(({ name, sourceRange }) => ({ name, sourceRange }))).toEqual([
      { name: 'shot.mp4', sourceRange: { start: 10, duration: 50 } },
      { name: 'voice.wav', sourceRange: { start: 5, duration: 25 } },
    ]);
    expect(Object.values(imported.mediaLinks)).toEqual([
      '/edit/project/media/shot.mp4',
      '/edit/project/voice.wav',
    ]);
    expect(imported.project.sequences[0]?.markers).toEqual([
      expect.objectContaining({ start: 30, comment: 'Review', extras: { kdenlive: { type: 1 } } }),
    ]);
    expect(imported.project.clips[0]?.markers).toEqual([
      expect.objectContaining({ start: 5, duration: 3, comment: 'Take two' }),
    ]);
  });

  it('generates a valid Kdenlive OTIO handoff from a native save', () => {
    const native = importKdenliveProject(KDENLIVE_NATIVE_FIXTURE);
    const exported = exportKdenliveOtio(native.project, { mediaLinks: native.mediaLinks });
    const roundTrip = importKdenliveOtio(exported.contents);

    expect(roundTrip.project.tracks.map(({ kind }) => kind)).toEqual(['video', 'audio']);
    expect(roundTrip.project.clips.map(({ sourceRange }) => sourceRange)).toEqual([
      { start: 10, duration: 50 },
      { start: 5, duration: 25 },
    ]);
  });

  it('rejects XML document type declarations', () => {
    expect(() => importKdenliveProject('<!DOCTYPE mlt><mlt/>')).toThrow(/document type/u);
  });
});

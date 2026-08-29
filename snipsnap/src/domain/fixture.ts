import { deterministicUuid, digestText } from './canonical';
import { validateProject, type Project } from './model';

export function createDemoProject(name = 'Launch Cut'): Project {
  const projectId = deterministicUuid(`project:${name}`);
  const sequenceId = deterministicUuid(`${projectId}:sequence`);
  const videoTrackId = deterministicUuid(`${sequenceId}:video:1`);
  const captionTrackId = deterministicUuid(`${sequenceId}:caption:1`);
  const introAssetId = deterministicUuid(`${projectId}:asset:intro`);
  const interviewAssetId = deterministicUuid(`${projectId}:asset:interview`);
  const introClipId = deterministicUuid(`${videoTrackId}:intro`);
  const interviewClipId = deterministicUuid(`${videoTrackId}:interview`);
  const captionId = deterministicUuid(`${captionTrackId}:caption`);

  return validateProject({
    schemaVersion: 1,
    id: projectId,
    name,
    sequences: [{
      id: sequenceId,
      name: 'Main Timeline',
      fps: { numerator: 24, denominator: 1 },
      width: 1920,
      height: 1080,
      trackIds: [videoTrackId, captionTrackId],
    }],
    tracks: [
      { id: videoTrackId, sequenceId, name: 'V1', kind: 'video', itemIds: [introClipId, interviewClipId] },
      { id: captionTrackId, sequenceId, name: 'Captions', kind: 'caption', itemIds: [captionId] },
    ],
    assets: [
      { id: introAssetId, name: 'intro.mov', fingerprint: digestText('media:intro.mov'), durationFrames: 480 },
      { id: interviewAssetId, name: 'interview.mov', fingerprint: digestText('media:interview.mov'), durationFrames: 2400 },
    ],
    clips: [
      { id: introClipId, type: 'clip', trackId: videoTrackId, name: 'Intro', assetId: introAssetId, sourceRange: { start: 0, duration: 144 }, gainDb: 0, preset: 'none' },
      { id: interviewClipId, type: 'clip', trackId: videoTrackId, name: 'Interview', assetId: interviewAssetId, sourceRange: { start: 240, duration: 360 }, gainDb: 0, preset: 'none' },
    ],
    gaps: [],
    captions: [
      { id: captionId, type: 'caption', trackId: captionTrackId, text: 'Ship the story, not the files.', range: { start: 72, duration: 96 }, style: 'subtitle' },
    ],
  });
}

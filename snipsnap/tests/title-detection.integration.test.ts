import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exportOtio, importOtio } from '../src/adapters/otio';
import { reconcileImportedProject } from '../src/application';
import { semanticDiff } from '../src/diff';
import { buildPreviewPlan, buildTimelineDiff } from '../src/preview';
import { projectDigest, type Project } from '../src/domain';

const RATE = 40;
const TIMELINE_FRAMES = 289;
const TITLE_START = 96;
const TITLE_FRAMES = 72;

function time(value: number) {
  return { OTIO_SCHEMA: 'RationalTime.1', value, rate: RATE };
}

function range(start: number, duration: number) {
  return { OTIO_SCHEMA: 'TimeRange.1', start_time: time(start), duration: time(duration) };
}

function sourceClip() {
  return {
    OTIO_SCHEMA: 'Clip.2',
    name: 'Screen Recording.mov',
    source_range: range(0, TIMELINE_FRAMES),
    media_reference: {
      OTIO_SCHEMA: 'ExternalReference.1',
      name: 'Screen Recording.mov',
      target_url: 'file:///Users/editor/Movies/Screen Recording.mov',
      available_range: range(0, TIMELINE_FRAMES),
    },
    metadata: {},
  };
}

/** Resolve writes a Text+ generator as a clip with no media behind it. */
function titleClip(text: string) {
  return {
    OTIO_SCHEMA: 'Clip.2',
    name: text,
    source_range: range(0, TITLE_FRAMES),
    media_reference: {
      OTIO_SCHEMA: 'MissingReference.1',
      name: text,
      available_range: null,
    },
    metadata: { Resolve_OTIO: { 'Effect Name': 'Text+' } },
  };
}

function gap(duration: number) {
  return { OTIO_SCHEMA: 'Gap.1', name: 'Gap', source_range: range(0, duration), metadata: {} };
}

function timeline(children: unknown[]) {
  return {
    OTIO_SCHEMA: 'Timeline.1',
    name: 'Timeline 1',
    global_start_time: time(0),
    tracks: {
      OTIO_SCHEMA: 'Stack.1',
      name: 'tracks',
      children,
      metadata: {},
    },
    metadata: {},
  };
}

const videoTrack = (name: string, children: unknown[]) => ({
  OTIO_SCHEMA: 'Track.1', name, kind: 'Video', children, metadata: {},
});

describe('a title added over part of a timeline', () => {
  let root: string;

  beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), 'snipsnap-title-')); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  const before = () => importOtio(timeline([videoTrack('V1', [sourceClip()])]));
  const after = () => importOtio(timeline([
    videoTrack('V1', [sourceClip()]),
    // The title sits in the middle, with the rest of the lane empty.
    videoTrack('V2', [
      gap(TITLE_START),
      titleClip('RAVI KISHAN GOAT'),
      gap(TIMELINE_FRAMES - TITLE_START - TITLE_FRAMES),
    ]),
  ]));

  /** OTIO's own schema for a generator, which some editors use for a title. */
  const generatorTitle = (text: string) => ({
    OTIO_SCHEMA: 'Clip.2',
    name: text,
    source_range: range(0, TITLE_FRAMES),
    media_reference: {
      OTIO_SCHEMA: 'GeneratorReference.1',
      name: text,
      generator_kind: 'Text',
      parameters: { text },
      available_range: null,
    },
    metadata: {},
  });

  it('treats a title as a generator rather than as footage that has gone missing', () => {
    const imported = after();
    const title = imported.project.clips.find((clip) => clip.name === 'RAVI KISHAN GOAT');
    const asset = imported.project.assets.find(({ id }) => id === title?.assetId);
    expect(asset?.extras.generator).toBe(true);

    const plan = buildPreviewPlan(imported.project, 'a'.repeat(40), 'a'.repeat(40), projectDigest(imported.project), {});
    const overlay = plan.tracks.find((track) => track.name === 'V2');
    expect(overlay?.segments.find((segment) => segment.name === 'RAVI KISHAN GOAT')?.isGenerator).toBe(true);
    // The footage is offline in this plan; the title is not, because it has no file.
    expect(plan.missingAssets.map(({ name }) => name)).toEqual(['Screen Recording.mov']);
  });

  it('reads a generator reference the same way as a missing one', () => {
    const imported = importOtio(timeline([
      videoTrack('V1', [sourceClip()]),
      videoTrack('V2', [gap(TITLE_START), generatorTitle('RAVI KISHAN GOAT'), gap(TIMELINE_FRAMES - TITLE_START - TITLE_FRAMES)]),
    ]));
    expect(imported.unsupported).toEqual([]);
    const title = imported.project.clips.find((clip) => clip.name === 'RAVI KISHAN GOAT');
    expect(title?.sourceRange).toEqual({ start: 0, duration: TITLE_FRAMES });
    expect(imported.project.assets.find(({ id }) => id === title?.assetId)?.extras.generator).toBe(true);
  });

  it('imports the title as its own clip rather than dropping it', () => {
    const imported = after();
    expect(imported.unsupported).toEqual([]);
    const title = imported.project.clips.find((clip) => clip.name === 'RAVI KISHAN GOAT');
    expect(title).toBeDefined();
    expect(title?.sourceRange).toEqual({ start: 0, duration: TITLE_FRAMES });
    // The generator has no file behind it, so nothing is linked for it.
    expect(imported.mediaLinks[imported.project.assets.find(({ id }) => id === title?.assetId)?.fingerprint ?? '']).toBeUndefined();
  });

  it('reports a new title track as one atomic, accurately named addition', () => {
    const base = before().project;
    const head = reconcileImportedProject(base, after().project);
    const hunks = semanticDiff(base, head);

    expect(hunks.filter(({ operation }) => operation === 'delete')).toEqual([]);
    expect(hunks).toEqual([
      expect.objectContaining({
        entityType: 'track',
        fieldGroup: 'structure',
        message: 'Added track V2 with 3 timeline items',
        parts: expect.arrayContaining([
          expect.objectContaining({ entityType: 'asset', operation: 'add' }),
          expect.objectContaining({ entityType: 'clip', operation: 'add' }),
          expect.objectContaining({ entityType: 'track', operation: 'add' }),
        ]),
      }),
    ]);
  });

  it('marks only the frames the title covers, not the whole timeline', () => {
    const base = before().project;
    const head = reconcileImportedProject(base, after().project);
    const plan = (project: Project, commit: string) =>
      buildPreviewPlan(project, commit, commit, projectDigest(project), {});
    const diff = buildTimelineDiff(plan(base, 'a'.repeat(40)), plan(head, 'b'.repeat(40)));

    const source = diff.tracks.find((track) => track.name === 'V1');
    const overlay = diff.tracks.find((track) => track.name === 'V2');
    // The footage underneath is untouched.
    expect(source?.change).toBe('unchanged');
    expect(overlay?.change).toBe('added');

    const title = overlay?.segments.find((segment) => segment.name === 'RAVI KISHAN GOAT');
    expect(title?.change).toBe('added');
    expect(title?.addedFrames).toBe(TITLE_FRAMES);
    // It starts after the leading gap and ends before the trailing one, so the
    // lane shows a slice rather than a full-width band.
    expect(title?.laneStart).toBe(TITLE_START);
    expect(title?.laneDuration).toBe(TITLE_FRAMES);
    expect(overlay?.laneFrames).toBe(TIMELINE_FRAMES);
    expect(TITLE_FRAMES).toBeLessThan(TIMELINE_FRAMES);
  });

  it('survives the round trip back out to Resolve', () => {
    const head = after();
    const exported = exportOtio(head.project, { mediaLinks: head.mediaLinks });
    const reimported = importOtio(exported).project;
    expect(semanticDiff(head.project, reconcileImportedProject(head.project, reimported))).toEqual([]);
    expect(exported).toContain('RAVI KISHAN GOAT');
    // It leaves as a reference that admits it has no file, not a dead URL.
    const written = JSON.parse(exported) as { tracks: { children: Array<{ children: Array<Record<string, string>> }> } };
    const overlay = written.tracks.children[1]?.children[1] as unknown as {
      media_references: { DEFAULT_MEDIA: { OTIO_SCHEMA: string; target_url?: string } };
    };
    expect(overlay.media_references.DEFAULT_MEDIA.OTIO_SCHEMA).toBe('MissingReference.1');
    expect(overlay.media_references.DEFAULT_MEDIA.target_url).toBeUndefined();
    expect(exported).not.toContain('"generator"');
  });
});

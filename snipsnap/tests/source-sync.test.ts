import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { importOtio } from '../src/adapters/otio';
import { reconcileImportedProject } from '../src/application/source-sync';
import { semanticDiff } from '../src/diff';

const fixture = readFileSync(path.join(__dirname, 'fixtures', 'resolve-basic.otio'), 'utf8');

function withoutVideoGitMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutVideoGitMetadata);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    key === 'metadata' ? {} : withoutVideoGitMetadata(child),
  ]));
}

describe('Resolve source synchronization', () => {
  it('preserves stable clip identities when Resolve rewrites and reorders OTIO', () => {
    const clean = withoutVideoGitMetadata(JSON.parse(fixture) as unknown) as Record<string, unknown>;
    const base = importOtio(clean).project;
    const changed = structuredClone(clean) as {
      tracks: { children: Array<{ children: Array<{ name?: string; source_range?: { duration: { value: number } } }> }> };
    };
    const videoTrack = changed.tracks.children[0];
    if (!videoTrack || videoTrack.children.length < 2) throw new Error('Fixture requires two video items');
    const first = videoTrack.children[0];
    if (!first?.source_range) throw new Error('Fixture clip range missing');
    first.source_range.duration.value -= 1;
    videoTrack.children.reverse();

    const reconciled = reconcileImportedProject(base, importOtio(changed).project);
    const baseIds = new Map(base.clips.map((clip) => [clip.name, clip.id]));
    expect(reconciled.clips.map((clip) => [clip.name, clip.id])).toEqual(
      expect.arrayContaining([...baseIds].map(([name, id]) => [name, id])),
    );
    const hunks = semanticDiff(base, reconciled);
    expect(hunks.some(({ operation }) => operation === 'modify')).toBe(true);
    expect(hunks.filter(({ entityType }) => entityType === 'clip').every(({ operation }) => operation !== 'add' && operation !== 'delete')).toBe(true);
  });
});

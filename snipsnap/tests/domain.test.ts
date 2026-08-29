import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  createDemoProject,
  deterministicUuid,
  projectDigest,
  rational,
  validateProject,
} from '../src/domain';

describe('canonical timeline model', () => {
  it('produces the same canonical state regardless of object key insertion order', () => {
    const project = createDemoProject();
    const reversed = Object.fromEntries(Object.entries(project).reverse());

    expect(canonicalJson(validateProject(reversed))).toBe(canonicalJson(project));
    expect(projectDigest(validateProject(reversed))).toBe(projectDigest(project));
  });

  it('normalizes strings to NFC', () => {
    const project = createDemoProject('Cafe\u0301 cut');
    expect(project.name).toBe('Café cut');
    expect(canonicalJson(project)).toContain('Café cut');
    expect(canonicalJson(project)).not.toContain('Café cut');
  });

  it('rejects captions that extend beyond their containing sequence', () => {
    const project = createDemoProject();
    const caption = project.captions[0];
    if (!caption) throw new Error('Demo fixture must contain a caption');
    caption.range = { start: 500, duration: 10 };
    expect(() => validateProject(project)).toThrow(/exceeds its sequence duration/u);
  });

  it('rejects clips that exceed immutable asset duration', () => {
    const project = createDemoProject();
    const firstClip = project.clips[0];
    if (!firstClip) throw new Error('Demo fixture must contain a clip');
    firstClip.sourceRange.duration = 9999;
    expect(() => validateProject(project)).toThrow(/exceeds its asset duration/u);
  });

  it('derives stable valid UUIDs from arbitrary input', () => {
    fc.assert(fc.property(fc.string(), (seed) => {
      const first = deterministicUuid(seed);
      expect(first).toBe(deterministicUuid(seed));
      expect(first).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u);
    }));
  });

  it('reduces rational frame rates exactly', () => {
    expect(rational(24000, 1001)).toEqual({ numerator: 24000, denominator: 1001 });
    expect(rational(48, 2)).toEqual({ numerator: 24, denominator: 1 });
  });
});

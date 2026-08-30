import { describe, expect, it } from 'vitest';
import { errorMessage } from '../src/renderer/error-message';

describe('renderer error messages', () => {
  it('summarizes IPC-wrapped validation issues instead of rendering raw JSON', () => {
    const issues = JSON.stringify([{
      code: 'too_small',
      message: 'Number must be greater than 0',
      path: ['tracks', 'children', 2, 'available_range', 'duration', 'rate'],
    }]);

    expect(errorMessage(new Error(
      `Error invoking remote method 'kdenlive:import-otio': Error: ${issues}`,
    ))).toBe(
      'The selected timeline is invalid at tracks.children.2.available_range.duration.rate: Number must be greater than 0',
    );
  });

  it('bounds unexpected messages so a failure cannot cover the workspace', () => {
    expect(errorMessage(new Error('x'.repeat(1_000)))).toHaveLength(360);
    expect(errorMessage(new Error('x'.repeat(1_000)))).toMatch(/…$/u);
  });
});

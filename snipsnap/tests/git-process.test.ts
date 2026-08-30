import { describe, expect, it } from 'vitest';
import { gitProcessIsolation } from '../src/git/process';

describe('Git process isolation', () => {
  it('detaches Git from the inherited Windows console while preserving hidden execution', () => {
    expect(gitProcessIsolation('win32')).toEqual({
      shell: false,
      windowsHide: true,
      detached: true,
    });
  });

  it('does not create detached process groups on Unix', () => {
    expect(gitProcessIsolation('linux').detached).toBe(false);
    expect(gitProcessIsolation('darwin').detached).toBe(false);
  });
});

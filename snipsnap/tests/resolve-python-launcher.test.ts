import { describe, expect, it } from 'vitest';
import { resolvePythonInvocation } from '../src/application';

describe('Resolve Python launcher', () => {
  it('uses the windowless Python launcher on Windows', () => {
    expect(resolvePythonInvocation('win32')).toEqual({ command: 'pyw', prefix: ['-3'] });
  });

  it('uses the console-neutral Python executable on Unix platforms', () => {
    expect(resolvePythonInvocation('linux')).toEqual({ command: 'python3', prefix: [] });
    expect(resolvePythonInvocation('darwin')).toEqual({ command: 'python3', prefix: [] });
  });
});

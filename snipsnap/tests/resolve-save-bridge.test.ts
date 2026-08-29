import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const script = path.resolve(__dirname, '../../resolve/SnipSnapSaveBridge.py');

describe('Resolve save-marker bridge script', () => {
  it('uses the persisted project save marker and an atomic OTIO handoff', () => {
    const contents = readFileSync(script, 'utf8');
    expect(contents).toContain('lastModifiedDate');
    expect(contents).toContain('os.replace(temporary, output_path)');
    expect(contents).not.toContain('debounce');
    expect(contents).not.toContain('--watch');
  });

  it('is valid Python when Python is available', () => {
    const python = process.platform === 'win32' ? 'py' : 'python3';
    const args = process.platform === 'win32' ? ['-3', '-m', 'py_compile', script] : ['-m', 'py_compile', script];
    const result = spawnSync(python, args, { encoding: 'utf8' });
    if (result.error && 'code' in result.error && result.error.code === 'ENOENT') return;
    expect(result.status, result.stderr).toBe(0);
  });
});

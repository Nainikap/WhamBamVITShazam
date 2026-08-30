import { afterEach, describe, expect, it } from 'vitest';
import { defaultKdenliveBinary, kdenliveLaunchPlan } from '../src/application';

describe('Kdenlive launcher', () => {
  afterEach(() => {
    delete process.env.SNIPSNAP_KDENLIVE_BINARY;
  });

  it('passes one literal file argument without a shell', () => {
    process.env.SNIPSNAP_KDENLIVE_BINARY = '/opt/Kden Live/bin/kdenlive';
    expect(kdenliveLaunchPlan('/tmp/cut;touch pwned.otio')).toEqual({
      command: '/opt/Kden Live/bin/kdenlive',
      args: ['/tmp/cut;touch pwned.otio'],
      options: { shell: false, detached: true, stdio: 'ignore' },
    });
  });

  it('finds standard Windows installs and falls back to a PATH-safe executable name', () => {
    const environment = {
      ProgramFiles: 'C:\\Program Files',
      LOCALAPPDATA: 'C:\\Users\\Editor\\AppData\\Local',
    };
    const installed = 'C:\\Program Files\\kdenlive\\bin\\kdenlive.exe';
    expect(defaultKdenliveBinary('win32', environment, (candidate) => candidate === installed)).toBe(installed);
    expect(defaultKdenliveBinary('win32', environment, () => false)).toBe('kdenlive.exe');
  });

  it('uses native Linux and macOS application locations without changing file arguments', () => {
    expect(defaultKdenliveBinary('linux', {}, (candidate) => candidate === '/usr/bin/kdenlive'))
      .toBe('/usr/bin/kdenlive');
    expect(defaultKdenliveBinary('darwin', {}, (candidate) => candidate.startsWith('/Applications/Kdenlive')))
      .toBe('/Applications/Kdenlive.app/Contents/MacOS/kdenlive');
  });
});

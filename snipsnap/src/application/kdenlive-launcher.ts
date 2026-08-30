import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

export interface KdenliveLaunchPlan {
  command: string;
  args: string[];
  options: {
    shell: false;
    detached: true;
    stdio: 'ignore';
  };
}

export function defaultKdenliveBinary(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  exists: (candidate: string) => boolean = existsSync,
): string {
  if (environment.SNIPSNAP_KDENLIVE_BINARY) return environment.SNIPSNAP_KDENLIVE_BINARY;
  const candidates = platform === 'win32'
    ? [
      environment.ProgramFiles && path.win32.join(environment.ProgramFiles, 'kdenlive', 'bin', 'kdenlive.exe'),
      environment.ProgramFiles && path.win32.join(environment.ProgramFiles, 'Kdenlive', 'bin', 'kdenlive.exe'),
      environment.LOCALAPPDATA && path.win32.join(environment.LOCALAPPDATA, 'Programs', 'Kdenlive', 'bin', 'kdenlive.exe'),
    ]
    : platform === 'darwin'
      ? ['/Applications/kdenlive.app/Contents/MacOS/kdenlive', '/Applications/Kdenlive.app/Contents/MacOS/kdenlive']
      : ['/usr/bin/kdenlive', '/usr/local/bin/kdenlive'];
  return candidates.filter((candidate): candidate is string => Boolean(candidate)).find(exists)
    ?? (platform === 'win32' ? 'kdenlive.exe' : 'kdenlive');
}

export function kdenliveLaunchPlan(): KdenliveLaunchPlan {
  return {
    command: defaultKdenliveBinary(),
    // Kdenlive's positional argument opens a native .kdenlive document. An
    // .otio argument is instead added to the bin as a clip, so OTIO must be
    // imported through File > OpenTimelineIO Import.
    args: [],
    options: { shell: false, detached: true, stdio: 'ignore' },
  };
}

export async function launchKdenlive(): Promise<void> {
  const plan = kdenliveLaunchPlan();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(plan.command, plan.args, plan.options);
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

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

export function kdenliveLaunchPlan(filePath: string): KdenliveLaunchPlan {
  if (!filePath) throw new Error('Kdenlive handoff path is required');
  return {
    command: defaultKdenliveBinary(),
    args: [filePath],
    options: { shell: false, detached: true, stdio: 'ignore' },
  };
}

export async function launchKdenlive(filePath: string): Promise<void> {
  const plan = kdenliveLaunchPlan(filePath);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(plan.command, plan.args, plan.options);
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

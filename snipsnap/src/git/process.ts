import { spawn } from 'node:child_process';

export interface GitResult {
  stdout: string;
  stderr: string;
}

export class GitError extends Error {
  constructor(
    message: string,
    readonly args: readonly string[],
    readonly exitCode: number,
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

export interface GitOptions {
  input?: string;
  env?: NodeJS.ProcessEnv;
}

const ALLOWED_GIT_ENVIRONMENT = new Set([
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
]);

function isolatedGitEnvironment(overrides: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.toUpperCase().startsWith('GIT_')) delete environment[key];
  }
  Object.assign(environment, {
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'Never',
  });
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (ALLOWED_GIT_ENVIRONMENT.has(key) && value !== undefined) environment[key] = value;
  }
  return environment;
}

export function runGit(repoPath: string, args: readonly string[], options: GitOptions = {}): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', repoPath, ...args], {
      shell: false,
      windowsHide: true,
      env: isolatedGitEnvironment(options.env),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      const output = Buffer.concat(stdout).toString('utf8');
      const errorOutput = Buffer.concat(stderr).toString('utf8');
      if (code === 0) resolve({ stdout: output, stderr: errorOutput });
      else reject(new GitError(`git ${args[0] ?? ''} failed: ${errorOutput.trim()}`, args, code ?? -1, errorOutput));
    });
    child.stdin.end(options.input);
  });
}

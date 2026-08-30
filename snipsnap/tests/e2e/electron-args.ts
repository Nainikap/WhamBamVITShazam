export function packagedElectronArgs(appPath: string): string[] {
  return process.platform === 'linux'
    ? [
      ...(process.env.CI === 'true' ? ['--no-sandbox'] : []),
      '--ozone-platform=x11',
      '--disable-gpu',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      appPath,
    ]
    : [appPath];
}

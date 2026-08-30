export function packagedElectronArgs(appPath: string): string[] {
  return process.platform === 'linux'
    ? [
      '--ozone-platform=x11',
      '--disable-gpu',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      appPath,
    ]
    : [appPath];
}

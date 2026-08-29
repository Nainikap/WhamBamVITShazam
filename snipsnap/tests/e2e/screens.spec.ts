import { _electron as electron, test, type Page } from '@playwright/test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectService, ResolveLibrary, resolveProjectId } from '../../src/application';
import { exportOtio } from '../../src/adapters/otio';
import { createDemoProject, type Project } from '../../src/domain';

const MEDIA = path.resolve(__dirname, '../../../deliverables/ravi_kishan_otio/ravi_kishan_first_10_seconds.mp4');
const SHOTS = path.resolve(__dirname, '../../../.screens');

function packagedAppPath(): string {
  const packageRoot = path.resolve('out', `SnipSnap-${process.platform}-${process.arch}`);
  return path.join(packageRoot, 'SnipSnap.app', 'Contents', 'Resources', 'app.asar');
}

function linkedOtio(project: Project): string {
  const mediaLinks = Object.fromEntries(project.assets.map(({ fingerprint }) => [fingerprint, `file://${MEDIA}`]));
  return exportOtio(project, { mediaLinks });
}

async function seedResolveProject(root: string, name: string, timeline: string): Promise<string> {
  const folder = path.join(root, name);
  await mkdir(folder, { recursive: true });
  const drp = path.join(folder, `${name}.drp`);
  await writeFile(drp, 'DaVinci Resolve project archive');
  await writeFile(path.join(folder, `${timeline}.otio`), linkedOtio(createDemoProject(name)));
  await writeFile(path.join(root, 'manifest.json'), JSON.stringify({
    version: 1,
    generatedAt: new Date().toISOString(),
    resolveVersion: '19.1',
    projects: [],
  }));
  return drp;
}

test('capture screens', async () => {
  test.setTimeout(240_000);
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'snipsnap-shots-'));
  const dataRoot = path.join(workspace, 'data');
  const resolveRoot = path.join(workspace, 'resolve');
  await mkdir(dataRoot, { recursive: true });
  await mkdir(resolveRoot, { recursive: true });

  await seedResolveProject(resolveRoot, 'Tutorial Series Q3', 'Episode 04');
  await seedResolveProject(resolveRoot, 'Brand Spot v2', 'Hero 30s');
  const launchDrp = await seedResolveProject(resolveRoot, 'Ravi Kishan Launch Cut', 'Launch Cut v4');

  const service = new ProjectService(dataRoot, new ResolveLibrary([resolveRoot]));
  const launchId = resolveProjectId(launchDrp);
  await service.openResolveProjectById(launchId);
  await service.openResolveProjectById(resolveProjectId(path.join(resolveRoot, 'Brand Spot v2', 'Brand Spot v2.drp')));

  const project = createDemoProject('Ravi Kishan Launch Cut');
  const intro = project.clips[0];
  const interview = project.clips.find(({ name }) => name === 'Interview');
  const music = project.clips.find(({ name }) => name === 'Music Bed');
  const voice = project.clips.find(({ name }) => name === 'Interview VO');
  if (!intro || !interview || !music || !voice) throw new Error('Fixture clips missing');

  const stageAll = async () => {
    const state = await service.status(launchId);
    return service.stage(launchId, state.unstaged.map(({ id }) => id), state.indexDigest);
  };

  let status = await service.status(launchId);
  status = await service.edit(launchId, { type: 'trimClip', clipId: intro.id, start: 0, duration: 108 }, status.workspaceVersion);
  status = await stageAll();
  status = await service.commit(launchId, 'Tighten the intro to two beats', status.headCommit);

  status = await service.edit(launchId, { type: 'setClipGain', clipId: voice.id, gainDb: -1 }, status.workspaceVersion);
  status = await stageAll();
  status = await service.commit(launchId, 'Lift the interview VO', status.headCommit);

  await service.createBranch(launchId, 'colour-pass');
  await service.checkout(launchId, 'colour-pass', false);
  status = await service.status(launchId);
  status = await service.edit(launchId, { type: 'setClipPreset', clipId: interview.id, preset: 'warm' }, status.workspaceVersion);
  status = await service.edit(launchId, { type: 'trimClip', clipId: interview.id, start: 240, duration: 300 }, status.workspaceVersion);
  status = await service.edit(launchId, { type: 'setClipGain', clipId: music.id, gainDb: -24 }, status.workspaceVersion);
  status = await stageAll();
  status = await service.commit(launchId, 'Warm grade and a tighter interview', status.headCommit);

  await service.checkout(launchId, 'main', false);
  status = await service.status(launchId);
  status = await service.edit(launchId, { type: 'setClipPreset', clipId: interview.id, preset: 'cool' }, status.workspaceVersion);
  status = await service.edit(launchId, { type: 'trimClip', clipId: interview.id, start: 216, duration: 396 }, status.workspaceVersion);
  status = await service.edit(launchId, { type: 'setClipGain', clipId: music.id, gainDb: -6 }, status.workspaceVersion);
  status = await stageAll();
  await service.commit(launchId, 'Cool grade for the launch cut', status.headCommit);

  // Bring the Resolve export back in line with the committed cut, so opening
  // the project does not report a pending re-import.
  const settled = await service.status(launchId);
  await writeFile(
    path.join(resolveRoot, 'Ravi Kishan Launch Cut', 'Launch Cut v4.otio'),
    linkedOtio(settled.project),
  );

  const application = await electron.launch({
    args: [packagedAppPath()],
    env: { ...process.env, SNIPSNAP_DATA_ROOT: dataRoot, SNIPSNAP_RESOLVE_ROOT: resolveRoot },
  });
  const page: Page = await application.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(SHOTS, '1-dashboard.png') });

  await page.getByRole('button', { name: 'Open Ravi Kishan Launch Cut' }).click();
  await page.waitForTimeout(1800);
  await page.screenshot({ path: path.join(SHOTS, '2-editor.png') });

  await page.getByRole('button', { name: 'See diff' }).click();
  await page.waitForTimeout(1800);
  await page.screenshot({ path: path.join(SHOTS, '3-diff.png') });

  await page.getByRole('button', { name: 'Close comparison' }).click();
  await page.getByLabel('Merge source branch').selectOption('colour-pass');
  await page.getByRole('button', { name: /Merge into/u }).click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(SHOTS, '4-merge-conflicts.png') });

  await application.close();
});

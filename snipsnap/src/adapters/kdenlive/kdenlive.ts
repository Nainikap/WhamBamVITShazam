import { z } from 'zod';
import {
  exportOtio,
  importOtio,
  ZERO_RATE_MEDIA_REASON,
  type OtioExportOptions,
  type UnsupportedContent,
} from '../otio';
import { validateProject, type Extras, type Project } from '../../domain';

export const KdenliveFeatureSchema = z.enum([
  'tracks',
  'clips',
  'gaps',
  'source-ranges',
  'media-references',
  'markers',
  'marker-semantics',
  'transitions',
  'captions',
  'effects',
  'audio-gain',
  'look-presets',
  'generators',
  'disabled-items',
  'color-labels',
  'editor-metadata',
  'unsupported-otio',
]);

export const KdenliveLossSchema = z.object({
  feature: KdenliveFeatureSchema,
  support: z.enum(['best-effort', 'not-portable']),
  count: z.number().int().positive(),
  message: z.string().min(1),
}).strict();

export const KdenliveInterchangeReportSchema = z.object({
  version: z.literal(1),
  editor: z.literal('kdenlive'),
  format: z.literal('otio'),
  supported: z.array(KdenliveFeatureSchema),
  losses: z.array(KdenliveLossSchema),
}).strict();

export type KdenliveInterchangeReport = z.infer<typeof KdenliveInterchangeReportSchema>;

export interface KdenliveImportResult {
  project: Project;
  mediaLinks: Record<string, string>;
  unsupported: UnsupportedContent[];
  report: KdenliveInterchangeReport;
}

export interface KdenliveExportResult {
  contents: string;
  report: KdenliveInterchangeReport;
}

const PORTABLE_FEATURES: z.infer<typeof KdenliveFeatureSchema>[] = [
  'tracks', 'clips', 'gaps', 'source-ranges', 'media-references', 'markers',
];

function hasExtras(extras: Extras): boolean {
  return Object.keys(extras).some((key) => key !== 'generator');
}

export function assessKdenliveCompatibility(projectInput: Project): KdenliveInterchangeReport {
  const project = validateProject(projectInput);
  const decorated = [
    ...project.tracks,
    ...project.clips,
    ...project.gaps,
    ...project.transitions,
    ...project.captions,
  ];
  const losses: KdenliveInterchangeReport['losses'] = [];
  const add = (
    feature: z.infer<typeof KdenliveFeatureSchema>,
    support: 'best-effort' | 'not-portable',
    count: number,
    message: string,
  ) => {
    if (count > 0) losses.push({ feature, support, count, message });
  };

  add(
    'marker-semantics',
    'best-effort',
    decorated.reduce((count, entity) => count + entity.markers.length, 0),
    'Kdenlive shares clip markers between instances while OTIO stores them per timeline instance.',
  );
  add(
    'transitions',
    'best-effort',
    project.transitions.length,
    'Kdenlive does not document transition fidelity through OTIO; verify every imported transition.',
  );
  add(
    'captions',
    'not-portable',
    project.captions.length,
    'OTIO has no portable native caption schema, so SnipSnap captions are metadata-only in Kdenlive.',
  );
  add(
    'effects',
    'not-portable',
    decorated.reduce((count, entity) => count + entity.effects.length, 0),
    'Arbitrary editor effects and their parameters are not portable through this Kdenlive OTIO slice.',
  );
  add(
    'audio-gain',
    'best-effort',
    project.clips.filter(({ gainDb }) => gainDb !== 0).length,
    'Per-clip audio gain is stored in SnipSnap metadata and may need to be recreated in Kdenlive.',
  );
  add(
    'look-presets',
    'not-portable',
    project.clips.filter(({ preset }) => preset !== 'none').length,
    'SnipSnap preview looks and Resolve colour work are not editable Kdenlive effects.',
  );
  add(
    'generators',
    'not-portable',
    project.assets.filter(({ extras }) => extras.generator === true).length,
    'Editor generators have no portable media reference and must be recreated or baked.',
  );
  add(
    'disabled-items',
    'best-effort',
    decorated.filter(({ enabled }) => !enabled).length,
    'Disabled state is represented in OTIO but is not guaranteed to survive Kdenlive interchange.',
  );
  add(
    'color-labels',
    'best-effort',
    project.clips.filter(({ color }) => color !== null).length,
    'Clip colour labels are editor decoration and may be remapped or omitted by Kdenlive.',
  );
  add(
    'editor-metadata',
    'best-effort',
    Number(hasExtras(project.extras))
      + project.sequences.filter(({ extras }) => hasExtras(extras)).length
      + decorated.filter(({ extras }) => hasExtras(extras)).length
      + project.assets.filter(({ extras }) => hasExtras(extras)).length,
    'Editor-specific metadata is preserved in OTIO where possible but has no shared editing semantics.',
  );

  return KdenliveInterchangeReportSchema.parse({
    version: 1,
    editor: 'kdenlive',
    format: 'otio',
    supported: PORTABLE_FEATURES,
    losses,
  });
}

export function importKdenliveOtio(input: string | unknown): KdenliveImportResult {
  const imported = importOtio(input);
  const report = assessKdenliveCompatibility(imported.project);
  const normalizedRateCount = imported.unsupported
    .filter(({ reason }) => reason === ZERO_RATE_MEDIA_REASON).length;
  const unsupportedCount = imported.unsupported.length - normalizedRateCount;
  if (normalizedRateCount > 0) {
    report.losses.push({
      feature: 'source-ranges',
      support: 'best-effort',
      count: normalizedRateCount,
      message: 'Kdenlive exported media availability at rate 0; SnipSnap used the valid clip source rate.',
    });
  }
  if (unsupportedCount > 0) {
    report.losses.push({
      feature: 'unsupported-otio',
      support: 'not-portable',
      count: unsupportedCount,
      message: 'The Kdenlive export contains OTIO objects outside SnipSnap\'s canonical subset.',
    });
  }
  return {
    ...imported,
    report: KdenliveInterchangeReportSchema.parse(report),
  };
}

export function exportKdenliveOtio(
  project: Project,
  options: OtioExportOptions = {},
): KdenliveExportResult {
  return {
    contents: exportOtio(project, options),
    report: assessKdenliveCompatibility(project),
  };
}

import { SaxesParser } from 'saxes';
import {
  decorations,
  deterministicUuid,
  digestText,
  rational,
  validateProject,
  type Asset,
  type Clip,
  type Gap,
  type Marker,
  type Project,
  type Rational,
  type Track,
} from '../../domain';
import type { UnsupportedContent } from '../otio';
import { assessKdenliveCompatibility, type KdenliveInterchangeReport } from './kdenlive';

interface XmlNode {
  name: string;
  attributes: Record<string, string>;
  properties: Record<string, string>;
  children: XmlNode[];
  text: string;
}

interface NativeImportOptions {
  /** Stable machine-local identity of the native project, never stored in Git. */
  sourceIdentity?: string;
  fallbackName?: string;
}

export interface KdenliveNativeImportResult {
  project: Project;
  mediaLinks: Record<string, string>;
  unsupported: UnsupportedContent[];
  report: KdenliveInterchangeReport;
}

const MAX_XML_BYTES = 64 * 1024 * 1024;
const MAX_XML_NODES = 500_000;
const MAX_XML_DEPTH = 256;

function parseXml(contents: string): XmlNode {
  // UTF-16 code units bound memory without importing Node into this pure adapter.
  if (contents.length > MAX_XML_BYTES) {
    throw new Error('Kdenlive project is too large to import safely');
  }
  const stack: XmlNode[] = [];
  let root: XmlNode | undefined;
  let nodes = 0;
  let parseError: Error | undefined;
  const parser = new SaxesParser({ xmlns: false });
  parser.on('doctype', () => {
    parseError = new Error('Kdenlive project XML must not contain a document type declaration');
    throw parseError;
  });
  parser.on('error', (error) => {
    parseError = error;
  });
  parser.on('opentag', (tag) => {
    nodes += 1;
    if (nodes > MAX_XML_NODES) throw new Error('Kdenlive project contains too many XML nodes');
    if (stack.length >= MAX_XML_DEPTH) throw new Error('Kdenlive project XML is nested too deeply');
    const node: XmlNode = {
      name: tag.name,
      attributes: { ...tag.attributes },
      properties: {},
      children: [],
      text: '',
    };
    const parent = stack.at(-1);
    if (parent) parent.children.push(node);
    else if (root) throw new Error('Kdenlive project XML has multiple roots');
    else root = node;
    stack.push(node);
  });
  const appendText = (text: string) => {
    const current = stack.at(-1);
    if (current) current.text += text;
  };
  parser.on('text', appendText);
  parser.on('cdata', appendText);
  parser.on('closetag', () => {
    const node = stack.pop();
    const parent = stack.at(-1);
    if (node?.name === 'property' && parent && node.attributes.name) {
      parent.properties[node.attributes.name] = node.text.trim();
    }
  });
  try {
    parser.write(contents).close();
  } catch (error) {
    throw parseError ?? error;
  }
  if (parseError) throw parseError;
  if (!root || root.name !== 'mlt') throw new Error('Expected a Kdenlive MLT project');
  return root;
}

function directChildren(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter((child) => child.name === name);
}

function finitePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function projectRate(root: XmlNode): Rational {
  const profile = directChildren(root, 'profile')[0];
  return rational(
    finitePositiveInteger(profile?.attributes.frame_rate_num, 24),
    finitePositiveInteger(profile?.attributes.frame_rate_den, 1),
  );
}

function positionFrames(value: string | undefined, fps: Rational): number {
  if (!value) return 0;
  if (/^\d+$/u.test(value)) return Number(value);
  const match = /^(\d+):(\d{2}):(\d{2})(?:([.:])(\d+))?$/u.exec(value);
  if (!match) throw new Error(`Unsupported MLT time value: ${value}`);
  const [, hours = '0', minutes = '0', seconds = '0', separator = '.', fraction = '0'] = match;
  const wholeSeconds = Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
  const wholeFrames = Math.round(wholeSeconds * fps.numerator / fps.denominator);
  return separator === ':'
    ? wholeFrames + Number(fraction)
    : wholeFrames + Math.round((fraction ? Number(`0.${fraction}`) : 0) * fps.numerator / fps.denominator);
}

function inclusiveDuration(node: XmlNode, fps: Rational): number {
  const start = positionFrames(node.attributes.in, fps);
  const end = positionFrames(node.attributes.out, fps);
  return Math.max(1, end - start + 1);
}

function durationFrames(value: string | undefined, fps: Rational): number {
  return Math.max(1, positionFrames(value, fps));
}

function cleanUuid(value: string | undefined, fallback: string): string {
  const candidate = value?.replace(/^\{|\}$/gu, '');
  return candidate && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(candidate)
    ? candidate.toLowerCase()
    : deterministicUuid(fallback);
}

function basename(value: string): string {
  const clean = value.split(/[?#]/u)[0] ?? value;
  return clean.split(/[\\/]/u).filter(Boolean).at(-1) ?? 'external-media';
}

function resolveResource(root: string, resource: string): string {
  if (!resource || /^(?:[a-z]+:|[a-z]:[\\/]|\/)/iu.test(resource)) return resource;
  const separator = /^[a-z]:/iu.test(root) || root.includes('\\') ? '\\' : '/';
  return `${root.replace(/[\\/]+$/u, '')}${separator}${resource.replace(/^[\\/]+/u, '')}`;
}

function markersFromJson(value: string | undefined, offset = 0): Marker[] {
  if (!value) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((entry): Marker[] => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const marker = entry as Record<string, unknown>;
    if (!Number.isSafeInteger(marker.pos) || (marker.pos as number) < offset) return [];
    const type = Number.isSafeInteger(marker.type) ? marker.type as number : 0;
    const duration = Number.isSafeInteger(marker.duration) && (marker.duration as number) >= 0
      ? marker.duration as number
      : 0;
    return [{
      name: '',
      color: 'RED',
      start: marker.pos as number - offset,
      duration,
      comment: typeof marker.comment === 'string' ? marker.comment.normalize('NFC') : 'Marker',
      extras: { kdenlive: { type } },
    }];
  });
}

function nativeUnsupported(root: XmlNode): UnsupportedContent[] {
  const unsupported: UnsupportedContent[] = [];
  const filters = [
    ...root.children.filter(({ name }) => name === 'filter'),
    ...root.children.flatMap((node) => directChildren(node, 'filter')),
  ].filter((filter) => filter.properties.internal_added === undefined).length;
  const userTransitions = root.children
    .filter(({ name }) => name === 'tractor')
    .flatMap((tractor) => directChildren(tractor, 'transition'))
    .filter((transition) => transition.properties.internal_added === undefined).length;
  if (filters > 0) unsupported.push({
    path: 'mlt.filter',
    schema: 'MLT.Filter',
    reason: `${filters} Kdenlive/MLT filter${filters === 1 ? '' : 's'} remain in the native project but are not portable to OTIO`,
  });
  if (userTransitions > 0) unsupported.push({
    path: 'mlt.transition',
    schema: 'MLT.Transition',
    reason: `${userTransitions} Kdenlive composition${userTransitions === 1 ? '' : 's'} remain in the native project but are not portable to OTIO`,
  });
  return unsupported;
}

/**
 * Read the cut-only subset Kdenlive itself exposes through OTIO from its saved
 * MLT XML document. This intentionally does not claim effects/compositions.
 */
export function importKdenliveProject(
  contents: string,
  options: NativeImportOptions = {},
): KdenliveNativeImportResult {
  const root = parseXml(contents);
  const fps = projectRate(root);
  const profile = directChildren(root, 'profile')[0];
  const nodesById = new Map(root.children
    .filter(({ attributes }) => Boolean(attributes.id))
    .map((node) => [node.attributes.id ?? '', node]));
  const mainBin = nodesById.get(root.attributes.producer || 'main_bin');
  const activeTimelineId = mainBin?.properties['kdenlive:docproperties.activetimeline']
    ?? root.children.find((node) => node.name === 'tractor' && node.properties['kdenlive:uuid'])?.attributes.id;
  const sequenceTractor = activeTimelineId ? nodesById.get(activeTimelineId) : undefined;
  if (!sequenceTractor || sequenceTractor.name !== 'tractor') {
    throw new Error('Kdenlive project has no readable active timeline');
  }

  const sourceIdentity = options.sourceIdentity ?? activeTimelineId ?? 'kdenlive-project';
  const sequenceId = cleanUuid(
    sequenceTractor.properties['kdenlive:uuid'] ?? activeTimelineId,
    `${sourceIdentity}:sequence`,
  );
  const projectId = deterministicUuid(`kdenlive-native:${sourceIdentity}`);
  const timelineName = sequenceTractor.properties['kdenlive:clipname'] || options.fallbackName || 'Kdenlive Timeline';
  const trackTractors = directChildren(sequenceTractor, 'track')
    .map(({ attributes }) => nodesById.get(attributes.producer ?? ''))
    .filter((node): node is XmlNode => Boolean(node && node.name === 'tractor'));
  const audioTracks: XmlNode[] = [];
  const videoTracks: XmlNode[] = [];
  for (const tractor of trackTractors) {
    const contentTrack = directChildren(tractor, 'track')[0];
    if (!contentTrack) continue;
    if (contentTrack.attributes.hide === 'video' || tractor.properties['kdenlive:audio_track'] === '1') {
      audioTracks.unshift(tractor);
    } else {
      videoTracks.push(tractor);
    }
  }
  const orderedTracks = [...videoTracks, ...audioTracks];
  if (orderedTracks.length === 0) throw new Error('Kdenlive active timeline has no readable tracks');

  const assetsByFingerprint = new Map<string, Asset>();
  const mediaLinks: Record<string, string> = {};
  const tracks: Track[] = [];
  const clips: Clip[] = [];
  const gaps: Gap[] = [];
  orderedTracks.forEach((trackTractor, trackIndex) => {
    const contentTrack = directChildren(trackTractor, 'track')[0];
    if (!contentTrack) return;
    const kind: Track['kind'] = contentTrack.attributes.hide === 'video'
      || trackTractor.properties['kdenlive:audio_track'] === '1' ? 'audio' : 'video';
    const trackId = deterministicUuid(`${sourceIdentity}:track:${trackTractor.attributes.id ?? trackIndex}:${kind}`);
    const playlist = nodesById.get(contentTrack.attributes.producer ?? '');
    if (!playlist || playlist.name !== 'playlist') return;
    const itemIds: string[] = [];
    const clipOccurrences = new Map<string, number>();
    playlist.children.forEach((item, itemIndex) => {
      if (item.name === 'blank') {
        const duration = durationFrames(item.attributes.length, fps);
        const id = deterministicUuid(`${trackId}:gap:${itemIndex}`);
        gaps.push({ id, type: 'gap', trackId, durationFrames: duration, ...decorations() });
        itemIds.push(id);
        return;
      }
      if (item.name !== 'entry') return;
      const producer = nodesById.get(item.attributes.producer ?? '');
      if (!producer || (producer.name !== 'chain' && producer.name !== 'producer')) return;
      const rawResource = producer.properties['kdenlive:originalurl']
        || producer.properties.resource
        || '';
      const resource = resolveResource(root.attributes.root ?? '', rawResource);
      const generated = !resource || ['color', 'kdenlivetitle', 'qtext'].includes(producer.properties.mlt_service ?? '');
      const fingerprint = digestText((resource || `${sourceIdentity}:${producer.attributes.id}`).normalize('NFC'));
      const assetId = cleanUuid(
        producer.properties['kdenlive:control_uuid'],
        `asset:${fingerprint}`,
      );
      const start = positionFrames(item.attributes.in, fps);
      const duration = inclusiveDuration(item, fps);
      const producerLength = finitePositiveInteger(producer.properties.length, start + duration);
      const name = producer.properties['kdenlive:clipname'] || basename(resource || 'Kdenlive generator');
      let asset = assetsByFingerprint.get(fingerprint);
      if (!asset) {
        asset = {
          id: assetId,
          name,
          fingerprint,
          durationFrames: Math.max(1, producerLength, start + duration),
          extras: generated ? { generator: true } : {},
        };
        assetsByFingerprint.set(fingerprint, asset);
      } else {
        asset.durationFrames = Math.max(asset.durationFrames, producerLength, start + duration);
      }
      if (!generated) mediaLinks[fingerprint] = resource;
      // Kdenlive's entry/bin ID survives gap insertion and playlist movement.
      // The item index does not, so it must only disambiguate otherwise
      // identical legacy entries rather than define clip identity.
      const nativeClipKey = `${item.properties['kdenlive:id']
        ?? producer.properties['kdenlive:id']
        ?? producer.attributes.id
        ?? name}:${start}`;
      const occurrence = clipOccurrences.get(nativeClipKey) ?? 0;
      clipOccurrences.set(nativeClipKey, occurrence + 1);
      const id = deterministicUuid(`${trackId}:clip:${nativeClipKey}:${occurrence}`);
      clips.push({
        id,
        type: 'clip',
        trackId,
        name,
        assetId: asset.id,
        sourceRange: { start, duration },
        gainDb: 0,
        preset: 'none',
        color: null,
        ...decorations(),
        markers: markersFromJson(producer.properties['kdenlive:markers'], start),
      });
      itemIds.push(id);
    });
    tracks.push({
      id: trackId,
      sequenceId,
      name: trackTractor.properties['kdenlive:track_name'] || `${kind.toUpperCase()} ${trackIndex + 1}`,
      kind,
      itemIds,
      ...decorations(),
    });
  });

  const project = validateProject({
    schemaVersion: 1,
    id: projectId,
    name: options.fallbackName || timelineName,
    sequences: [{
      id: sequenceId,
      name: timelineName,
      fps,
      width: finitePositiveInteger(profile?.attributes.width, 1920),
      height: finitePositiveInteger(profile?.attributes.height, 1080),
      trackIds: tracks.map(({ id }) => id),
      globalStartFrame: 0,
      markers: markersFromJson(sequenceTractor.properties['kdenlive:sequenceproperties.guides']),
      extras: {},
    }],
    tracks,
    assets: [...assetsByFingerprint.values()],
    clips,
    gaps,
    transitions: [],
    captions: [],
    extras: {
      kdenlive: {
        documentVersion: mainBin?.properties['kdenlive:docproperties.version'] ?? '',
        applicationVersion: mainBin?.properties['kdenlive:docproperties.kdenliveversion'] ?? '',
      },
    },
  });
  return {
    project,
    mediaLinks,
    unsupported: nativeUnsupported(root),
    report: assessKdenliveCompatibility(project),
  };
}

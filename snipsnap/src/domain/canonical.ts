import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { validateProject, type Project } from './model';

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function normalize(value: unknown): JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.normalize('NFC');
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalize(item)]),
    );
  }
  throw new TypeError(`Cannot canonicalize ${typeof value}`);
}

export function canonicalJson(project: Project): string {
  return `${JSON.stringify(normalize(validateProject(project)))}\n`;
}

export function digestText(value: string): string {
  return bytesToHex(sha256(utf8ToBytes(value)));
}

export function projectDigest(project: Project): string {
  return digestText(canonicalJson(project));
}

export function deterministicUuid(seed: string): string {
  const bytes = sha256(utf8ToBytes(seed)).slice(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytesToHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function cloneProject(project: Project): Project {
  return validateProject(JSON.parse(canonicalJson(project)) as unknown);
}

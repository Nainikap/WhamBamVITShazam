import { framesToTimecode } from '../domain';

export { framesToTimecode };

export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return 'unknown';
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return 'just now';
  const scales: Array<[number, string]> = [[604800, 'w'], [86400, 'd'], [3600, 'h'], [60, 'min']];
  const scale = scales.find(([size]) => seconds >= size);
  if (!scale) return 'just now';
  const [size, unit] = scale;
  const value = Math.floor(seconds / size);
  if (unit === 'w' && value > 5) {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(then));
  }
  return `${value}${unit} ago`;
}

export function absoluteTime(iso: string): string {
  const value = new Date(iso);
  return Number.isFinite(value.getTime())
    ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(value)
    : 'unknown';
}

export function durationLabel(frames: number, fps: number): string {
  const totalSeconds = fps > 0 ? Math.round(frames / fps) : 0;
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}:${(totalSeconds % 60).toString().padStart(2, '0')}`;
}

export function frameRateLabel(fps: number): string {
  return `${fps.toFixed(3).replace(/\.?0+$/u, '')} fps`;
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

export function authorName(author: string): string {
  return author.replace(/\s*<[^>]*>\s*$/u, '').trim() || author;
}

import type { Rational } from './model';

function gcd(left: number, right: number): number {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b !== 0) [a, b] = [b, a % b];
  return a || 1;
}

export function rational(numerator: number, denominator = 1): Rational {
  if (!Number.isInteger(numerator) || !Number.isInteger(denominator) || numerator <= 0 || denominator <= 0) {
    throw new RangeError('Frame rate must contain positive integers');
  }
  const divisor = gcd(numerator, denominator);
  return { numerator: numerator / divisor, denominator: denominator / divisor };
}

export function rateToRational(rate: number): Rational {
  if (!Number.isFinite(rate) || rate <= 0) throw new RangeError('OTIO rate must be positive');
  const known: Array<[number, Rational]> = [
    [23.976, rational(24000, 1001)],
    [29.97, rational(30000, 1001)],
    [59.94, rational(60000, 1001)],
  ];
  const match = known.find(([candidate]) => Math.abs(rate - candidate) < 0.0005);
  if (match) return match[1];
  if (Number.isInteger(rate)) return rational(rate);
  return rational(Math.round(rate * 1_000_000), 1_000_000);
}

export function rationalToRate(value: Rational): number {
  return value.numerator / value.denominator;
}

export function convertFrames(value: number, fromRate: number, to: Rational): number {
  if (!Number.isInteger(value)) throw new RangeError('Frame values must be integers');
  return Math.round((value / fromRate) * rationalToRate(to));
}

export function framesToTimecode(frame: number, rate: number): string {
  const fps = Number.isFinite(rate) && rate > 0 ? rate : 1;
  const rounded = Math.max(1, Math.round(fps));
  const safeFrame = Math.max(0, Math.floor(frame));
  const totalSeconds = Math.floor(safeFrame / fps);
  const parts = [Math.floor(totalSeconds / 3600), Math.floor(totalSeconds / 60) % 60, totalSeconds % 60];
  return `${parts.map((value) => value.toString().padStart(2, '0')).join(':')}:${(safeFrame % rounded).toString().padStart(2, '0')}`;
}

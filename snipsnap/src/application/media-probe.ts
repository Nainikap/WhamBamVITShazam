import { open } from 'node:fs/promises';
import { rational, type Rational } from '../domain';

const MAX_MOOV_BYTES = 64 * 1024 * 1024;

export interface VideoFormat {
  fps: Rational;
  width: number;
  height: number;
  frames: number;
}

interface Atom {
  type: string;
  start: number;
  end: number;
}

/**
 * Read an ISO base media file (MP4, MOV, M4V) far enough to learn its frame
 * rate and frame size. Resolve does not record either in its project database,
 * and guessing them would move every timestamp in the timeline.
 */
class BoxReader {
  constructor(private readonly bytes: Buffer) {}

  children(start: number, end: number): Atom[] {
    const atoms: Atom[] = [];
    let cursor = start;
    while (cursor + 8 <= end) {
      let size = this.bytes.readUInt32BE(cursor);
      const type = this.bytes.toString('latin1', cursor + 4, cursor + 8);
      let header = 8;
      if (size === 1) {
        if (cursor + 16 > end) break;
        const large = this.bytes.readBigUInt64BE(cursor + 8);
        if (large > BigInt(Number.MAX_SAFE_INTEGER)) break;
        size = Number(large);
        header = 16;
      } else if (size === 0) {
        size = end - cursor;
      }
      if (size < header || cursor + size > end) break;
      atoms.push({ type, start: cursor + header, end: cursor + size });
      cursor += size;
    }
    return atoms;
  }

  find(atoms: Atom[], type: string): Atom | undefined {
    return atoms.find((atom) => atom.type === type);
  }

  /** Media header: the track's clock and how long it runs on it. */
  mediaHeader(atom: Atom): { timescale: number; duration: number } | null {
    const version = this.bytes.readUInt8(atom.start);
    if (version === 1) {
      if (atom.start + 32 > atom.end) return null;
      return {
        timescale: this.bytes.readUInt32BE(atom.start + 20),
        duration: Number(this.bytes.readBigUInt64BE(atom.start + 24)),
      };
    }
    if (atom.start + 20 > atom.end) return null;
    return {
      timescale: this.bytes.readUInt32BE(atom.start + 12),
      duration: this.bytes.readUInt32BE(atom.start + 16),
    };
  }

  trackHeader(atom: Atom): { width: number; height: number } | null {
    const version = this.bytes.readUInt8(atom.start);
    // Width and height sit after the display matrix, which the longer 64-bit
    // timestamps of a version 1 header push back by twelve bytes.
    const offset = atom.start + (version === 1 ? 88 : 76);
    if (offset + 8 > atom.end) return null;
    return {
      // Fixed-point 16.16 values.
      width: Math.round(this.bytes.readUInt32BE(offset) / 65_536),
      height: Math.round(this.bytes.readUInt32BE(offset + 4) / 65_536),
    };
  }

  /** Time-to-sample: how many frames there are and how long each one lasts. */
  sampleTable(atom: Atom): { samples: number; delta: number } | null {
    if (atom.start + 8 > atom.end) return null;
    const entries = this.bytes.readUInt32BE(atom.start + 4);
    let samples = 0;
    let delta = 0;
    for (let index = 0; index < entries; index += 1) {
      const offset = atom.start + 8 + index * 8;
      if (offset + 8 > atom.end) break;
      const count = this.bytes.readUInt32BE(offset);
      const step = this.bytes.readUInt32BE(offset + 4);
      samples += count;
      if (delta === 0 && step > 0) delta = step;
    }
    return samples > 0 && delta > 0 ? { samples, delta } : null;
  }
}

/**
 * Locate the movie header by stepping over the top-level boxes. QuickTime
 * writes it after the media data, which in a long clip is hundreds of
 * megabytes in, so the file is never read whole.
 */
async function readMoov(handle: Awaited<ReturnType<typeof open>>, size: number): Promise<Buffer | null> {
  const header = Buffer.alloc(16);
  let offset = 0;
  while (offset + 8 <= size) {
    const { bytesRead } = await handle.read(header, 0, 16, offset);
    if (bytesRead < 8) return null;
    let boxSize = header.readUInt32BE(0);
    const type = header.toString('latin1', 4, 8);
    let headerSize = 8;
    if (boxSize === 1) {
      if (bytesRead < 16) return null;
      const large = header.readBigUInt64BE(8);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      boxSize = Number(large);
      headerSize = 16;
    } else if (boxSize === 0) {
      boxSize = size - offset;
    }
    if (boxSize < headerSize) return null;
    if (type === 'moov') {
      const length = Math.min(boxSize - headerSize, MAX_MOOV_BYTES);
      const bytes = Buffer.alloc(length);
      await handle.read(bytes, 0, length, offset + headerSize);
      return bytes;
    }
    offset += boxSize;
  }
  return null;
}

export async function probeVideo(filePath: string): Promise<VideoFormat | null> {
  let handle;
  try {
    handle = await open(filePath, 'r');
    const { size } = await handle.stat();
    const bytes = await readMoov(handle, size);
    if (!bytes) return null;
    const reader = new BoxReader(bytes);

    for (const trak of reader.children(0, bytes.length).filter(({ type }) => type === 'trak')) {
      const inTrak = reader.children(trak.start, trak.end);
      const mdia = reader.find(inTrak, 'mdia');
      const tkhd = reader.find(inTrak, 'tkhd');
      if (!mdia || !tkhd) continue;
      const inMdia = reader.children(mdia.start, mdia.end);
      const mdhd = reader.find(inMdia, 'mdhd');
      const minf = reader.find(inMdia, 'minf');
      if (!mdhd || !minf) continue;
      const inMinf = reader.children(minf.start, minf.end);
      // A video track is the one carrying a video media header.
      if (!reader.find(inMinf, 'vmhd')) continue;
      const stbl = reader.find(inMinf, 'stbl');
      const header = reader.mediaHeader(mdhd);
      const size2d = reader.trackHeader(tkhd);
      if (!stbl || !header || !size2d || header.timescale <= 0) continue;
      const stts = reader.find(reader.children(stbl.start, stbl.end), 'stts');
      const table = stts ? reader.sampleTable(stts) : null;
      if (!table) continue;
      return {
        fps: rational(header.timescale, table.delta),
        width: size2d.width,
        height: size2d.height,
        frames: table.samples,
      };
    }
    return null;
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

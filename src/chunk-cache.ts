import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { EnergyPeak, TranscriptItem } from './types';

/** One scanned chunk's raw material, in chunk-relative seconds. */
export interface ChunkData {
  items: TranscriptItem[];
  peaks: EnergyPeak[];
}

/**
 * Transcript + loudness peaks per (source, chunk range), kept on disk. Transcription is the slow,
 * paid part of a scan, so a retried, resumed or re-prompted job over the same video reuses it
 * instead of sending the audio to AssemblyAI again.
 */
export class ChunkCache {
  constructor(private readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
  }

  key(sourceKey: string, startSec: number, endSec: number): string {
    return crypto.createHash('sha1').update(`${sourceKey}|${startSec.toFixed(3)}|${endSec.toFixed(3)}`).digest('hex');
  }

  get(key: string): ChunkData | null {
    const file = this.file(key);
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(data?.items) || !Array.isArray(data?.peaks)) return null;
      const now = new Date();
      fs.utimesSync(file, now, now); // sweep() ages entries by last use
      return data;
    } catch {
      return null;
    }
  }

  /** Best effort — a failed write only costs a re-transcription later. */
  set(key: string, data: ChunkData): void {
    const file = this.file(key);
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, file);
    } catch {
      try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    }
  }

  /** Deletes entries not used for `maxAgeMs`. */
  sweep(maxAgeMs: number): void {
    const cutoff = Date.now() - maxAgeMs;
    let names: string[] = [];
    try { names = fs.readdirSync(this.dir); } catch { return; }
    for (const name of names) {
      const p = path.join(this.dir, name);
      try {
        if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { force: true });
      } catch { /* ignore */ }
    }
  }

  private file(key: string): string {
    return path.join(this.dir, `${key}.json`);
  }
}

import { spawn } from 'child_process';
import { EnergyPeak } from './types';

// Exact same constants as LiveAudioEnergyService
const FRAME_SEC = 0.5;
const ANALYSIS_RATE = 16000;
const PEAK_OVER_MEDIAN_DB = 6;
const MIN_PEAK_SEC = 1.0;
const PEAK_MERGE_GAP_SEC = 1.5;
const MAX_PEAKS = 8;
const ANALYZE_TIMEOUT_MS = 60_000;
const SILENCE_DB = -90;

export class VideoAudioEnergyService {
  /**
   * Loudness peaks of videoPath, or of [startSec, startSec+durationSec) when given. Peak times are
   * relative to the analysed range. Never throws — [] means "no energy evidence".
   */
  async analyzeChunk(videoPath: string, startSec?: number, durationSec?: number): Promise<EnergyPeak[]> {
    try {
      const frames = await this.readRmsFrames(videoPath, startSec, durationSec);
      if (frames.length < 4) return [];
      return this.findPeaks(frames);
    } catch {
      return [];
    }
  }

  // Mirrors LiveAudioEnergyService.readRmsFrames exactly — same filter chain, same ametadata trick
  private readRmsFrames(videoPath: string, startSec?: number, durationSec?: number): Promise<number[]> {
    const samplesPerFrame = Math.round(ANALYSIS_RATE * FRAME_SEC);
    return new Promise((resolve, reject) => {
      const proc = spawn('ffmpeg', [
        '-hide_banner',
        '-nostats',
        ...(startSec !== undefined ? ['-ss', String(startSec)] : []),
        '-i', videoPath,
        ...(durationSec !== undefined ? ['-t', String(durationSec)] : []),
        '-vn',
        '-af',
        `aresample=${ANALYSIS_RATE},asetnsamples=n=${samplesPerFrame}:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-`,
        '-f', 'null',
        '-',
      ], { stdio: ['ignore', 'pipe', 'pipe'] });

      let out = '';
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* ignore */ }
        finish(() => reject(new Error('astats timed out')));
      }, ANALYZE_TIMEOUT_MS);

      proc.stdout.on('data', (d) => { out += d.toString(); });
      proc.on('error', (e) => finish(() => reject(e)));
      proc.on('exit', (code) => {
        finish(() => {
          if (code !== 0 && !out) {
            reject(new Error(`ffmpeg astats exited ${code}`));
            return;
          }
          const frames: number[] = [];
          for (const line of out.split('\n')) {
            const m = line.match(/lavfi\.astats\.Overall\.RMS_level=(-?[\d.]+|-?inf|nan)/i);
            if (!m) continue;
            const raw = m[1].toLowerCase();
            if (raw === 'nan') continue;
            const val = raw.includes('inf') ? SILENCE_DB : Number(raw);
            frames.push(Number.isFinite(val) ? Math.max(SILENCE_DB, val) : SILENCE_DB);
          }
          resolve(frames);
        });
      });
    });
  }

  // Mirrors LiveAudioEnergyService.findPeaks exactly
  private findPeaks(frames: number[]): EnergyPeak[] {
    const sorted = [...frames].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const threshold = median + PEAK_OVER_MEDIAN_DB;

    const runs: { startIdx: number; endIdx: number; peakDb: number }[] = [];
    let cur: { startIdx: number; endIdx: number; peakDb: number } | null = null;
    for (let i = 0; i < frames.length; i++) {
      if (frames[i] >= threshold) {
        if (cur) {
          cur.endIdx = i;
          cur.peakDb = Math.max(cur.peakDb, frames[i]);
        } else {
          cur = { startIdx: i, endIdx: i, peakDb: frames[i] };
        }
      } else if (cur) {
        runs.push(cur);
        cur = null;
      }
    }
    if (cur) runs.push(cur);
    if (runs.length === 0) return [];

    const merged: typeof runs = [];
    for (const run of runs) {
      const prev = merged[merged.length - 1];
      if (prev && (run.startIdx - prev.endIdx) * FRAME_SEC <= PEAK_MERGE_GAP_SEC) {
        prev.endIdx = run.endIdx;
        prev.peakDb = Math.max(prev.peakDb, run.peakDb);
      } else {
        merged.push({ ...run });
      }
    }

    const peaks: EnergyPeak[] = [];
    for (const run of merged) {
      const startSec = run.startIdx * FRAME_SEC;
      const endSec = (run.endIdx + 1) * FRAME_SEC;
      if (endSec - startSec < MIN_PEAK_SEC) continue;
      peaks.push({
        atSec: (startSec + endSec) / 2,
        startSec,
        endSec,
        prominenceDb: run.peakDb - median,
        relative: 0,
      });
    }
    if (peaks.length === 0) return [];

    const maxProm = Math.max(...peaks.map((p) => p.prominenceDb));
    for (const p of peaks) p.relative = maxProm > 0 ? p.prominenceDb / maxProm : 0;

    return peaks
      .sort((a, b) => b.prominenceDb - a.prominenceDb)
      .slice(0, MAX_PEAKS)
      .sort((a, b) => a.startSec - b.startSec);
  }
}

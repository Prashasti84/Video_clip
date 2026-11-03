/**
 * diagnose.ts — runs each pipeline step and prints exactly what fails
 * Usage: npx ts-node --project tsconfig.json diagnose.ts <youtube-url-or-mp4>
 */
import * as dotenv from 'dotenv';
dotenv.config();

import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import axios from 'axios';
import { VideoIngestService } from './src/video-ingest.service';
import { VideoAudioEnergyService } from './src/video-audio-energy.service';
import { VideoScorerService } from './src/video-scorer.service';

const SOURCE = process.argv[2] || 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const PROMPT = process.argv[3] || 'funny moments and reactions';
const JOB_ID = 'diag-' + Date.now();

async function step(name: string, fn: () => Promise<void>) {
  process.stdout.write(`\n[${name}] ... `);
  const t = Date.now();
  try {
    await fn();
    console.log(`✅  ${Date.now() - t}ms`);
  } catch (e: any) {
    console.log(`❌  FAILED: ${e?.message}`);
    process.exit(1);
  }
}

async function main() {
  console.log(`\n==== Video Clip Diagnostic ====`);
  console.log(`Source : ${SOURCE}`);
  console.log(`Prompt : ${PROMPT}`);
  console.log(`JobId  : ${JOB_ID}`);

  // ── 1. Tools ─────────────────────────────────────────
  await step('ffmpeg', () => new Promise((res, rej) => {
    const p = spawn('ffmpeg', ['-version'], { stdio: 'pipe' });
    p.on('exit', c => c === 0 ? res() : rej(new Error('ffmpeg not found or errored')));
    p.on('error', rej);
  }));

  await step('yt-dlp', () => new Promise((res, rej) => {
    const p = spawn('yt-dlp', ['--version'], { stdio: 'pipe' });
    p.on('exit', c => c === 0 ? res() : rej(new Error('yt-dlp not found')));
    p.on('error', rej);
  }));

  // ── 2. Ingest ────────────────────────────────────────
  const ingest = new VideoIngestService();
  let totalDurationSec = 0;
  let videoDir = '';
  await step('ingest (download + segment)', async () => {
    const result = await ingest.prepareVideo(JOB_ID, SOURCE);
    totalDurationSec = result.totalDurationSec;
    videoDir = result.dir;
    console.log(`\n    Duration: ${(totalDurationSec/60).toFixed(1)} min`);
    const segs = fs.readdirSync(videoDir).filter(f => f.endsWith('.ts'));
    console.log(`    Segments: ${segs.length}`);
  });

  // ── 3. Extract first chunk ────────────────────────────
  let chunkPath = '';
  await step('extract chunk (0–60s)', async () => {
    chunkPath = await ingest.extractClip(JOB_ID, 0, Math.min(60, totalDurationSec));
    const stat = fs.statSync(chunkPath);
    console.log(`\n    Chunk: ${chunkPath} (${(stat.size/1024).toFixed(0)} KB)`);
  });

  // ── 4. Extract audio ─────────────────────────────────
  let audioBuf: Buffer | null = null;
  await step('extract audio (ffmpeg)', async () => {
    audioBuf = await new Promise<Buffer | null>((resolve) => {
      const chunks: Buffer[] = [];
      const proc = spawn('ffmpeg', [
        '-i', chunkPath, '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', 'pipe:1',
      ], { stdio: ['ignore', 'pipe', 'ignore'] });
      proc.stdout.on('data', (d) => chunks.push(d));
      proc.on('error', () => resolve(null));
      proc.on('exit', (code) => {
        if (code === 0 && chunks.length > 0) resolve(Buffer.concat(chunks));
        else resolve(null);
      });
    });
    if (!audioBuf) throw new Error('ffmpeg audio extraction returned null');
    console.log(`\n    Audio buffer: ${(audioBuf.length/1024).toFixed(0)} KB`);
  });

  // ── 5. AssemblyAI ────────────────────────────────────
  const aaiKey = process.env.ASSEMBLYAI_API_KEY ?? '';
  if (!aaiKey) {
    console.log('\n[AssemblyAI] ⚠️  ASSEMBLYAI_API_KEY not set — skipping transcription test');
  } else {
    await step('AssemblyAI upload', async () => {
      const r = await axios.post('https://api.assemblyai.com/v2/upload', audioBuf!, {
        headers: { authorization: aaiKey, 'content-type': 'application/octet-stream' },
        maxBodyLength: Infinity,
      });
      console.log(`\n    Upload URL: ${r.data.upload_url?.slice(0,60)}...`);
    });
  }

  // ── 6. Energy analysis ───────────────────────────────
  const energySvc = new VideoAudioEnergyService();
  let peaks: any[] = [];
  await step('audio energy analysis', async () => {
    peaks = await energySvc.analyzeChunk(chunkPath);
    console.log(`\n    Peaks found: ${peaks.length}`);
    peaks.slice(0, 3).forEach(p =>
      console.log(`      ${p.startSec.toFixed(1)}s–${p.endSec.toFixed(1)}s  prominence=${p.prominenceDb.toFixed(1)}dB  relative=${p.relative.toFixed(2)}`)
    );
  });

  // ── 7. Gemini scorer ─────────────────────────────────
  const geminiKey = process.env.GEMINI_API_KEY ?? '';
  if (!geminiKey) {
    console.log('\n[Gemini] ⚠️  GEMINI_API_KEY not set — skipping scorer test');
  } else {
    const scorer = new VideoScorerService(geminiKey);
    await step('Gemini scorer (empty transcript → energy fallback)', async () => {
      const moments = await scorer.findChunkMoments(
        { text: '', items: [] },
        PROMPT,
        undefined,
        3,
        Math.min(60, totalDurationSec),
        0.5,
        peaks,
      );
      console.log(`\n    Moments returned: ${moments.length}`);
      moments.forEach(m =>
        console.log(`      score=${m.score.toFixed(2)} ${m.start.toFixed(1)}s–${m.end.toFixed(1)}s "${m.caption}"`)
      );
    });
  }

  // ── 8. ffmpeg render ─────────────────────────────────
  const outPath = path.join(path.dirname(chunkPath), 'diag-out.mp4');
  await step('ffmpeg render clip (0–15s)', () => new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', [
      '-y', '-ss', '0', '-i', chunkPath, '-t', '15',
      '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2',
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
      '-c:a', 'aac', '-b:a', '128k', outPath,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    proc.stderr.on('data', d => { err += d.toString(); });
    proc.on('error', reject);
    proc.on('exit', code => {
      if (code === 0 && fs.existsSync(outPath)) {
        const sz = fs.statSync(outPath).size;
        console.log(`\n    Output: ${outPath} (${(sz/1024).toFixed(0)} KB)`);
        resolve();
      } else {
        reject(new Error(`ffmpeg exited ${code}: ${err.slice(-300)}`));
      }
    });
  }));

  console.log('\n==== All steps passed ====\n');
  ingest.cleanup(JOB_ID);
}

main().catch(e => { console.error('\n❌  Fatal:', e.message); process.exit(1); });

/**
 * Smoke-test / integration runner for VideoClipService.
 * Run: npx ts-node test-run.ts
 *
 * Prerequisites:
 *   - ffmpeg + ffprobe in PATH
 *   - yt-dlp in PATH
 *   - GEMINI_API_KEY in .env (required)
 *   - ASSEMBLYAI_API_KEY in .env (optional — enables real transcription)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';

// Load .env from the same directory as this script
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([^#=\s]+)\s*=\s*(.*)\s*$/);
    if (m) process.env[m[1]] = m[2].trim();
  }
}

import { VideoClipService } from './src';
import { TranscriptResult } from './src/types';

// ---------- CONFIGURE ----------
const SOURCE_URL = 'https://youtu.be/UJCvR6IjpOM';
const PROMPT = 'motivational speech with inspiring music and uplifting message';
const ASPECT_RATIO = '16:9';   // '16:9' | '9:16' | '1:1'
const CHUNK_LENGTH_SEC = 300;  // 5-minute chunks
const CLIP_BUDGET = 3;
const CLIP_OUTPUT_SEC = 30;    // target clip length (cut points snap to pauses in speech)
// --------------------------------

// Real AssemblyAI transcription — used when ASSEMBLYAI_API_KEY is set.
async function assemblyAiTranscribe(audioBuf: Buffer): Promise<TranscriptResult | null> {
  const apiKey = process.env.ASSEMBLYAI_API_KEY;
  if (!apiKey) return null;

  const upload = await new Promise<string>((resolve, reject) => {
    const req = https.request(
      { hostname: 'api.assemblyai.com', path: '/v2/upload', method: 'POST',
        headers: { authorization: apiKey, 'content-type': 'application/octet-stream', 'content-length': audioBuf.length } },
      (res) => {
        let body = '';
        res.on('data', (d) => { body += d; });
        res.on('end', () => {
          try { resolve(JSON.parse(body).upload_url); } catch { reject(new Error('upload parse fail')); }
        });
      },
    );
    req.on('error', reject);
    req.end(audioBuf);
  });

  const createRes = await new Promise<any>((resolve, reject) => {
    const body = JSON.stringify({ audio_url: upload, word_boost: [], language_detection: true });
    const req = https.request(
      { hostname: 'api.assemblyai.com', path: '/v2/transcript', method: 'POST',
        headers: { authorization: apiKey, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
      (res) => {
        let b = '';
        res.on('data', (d) => { b += d; });
        res.on('end', () => { try { resolve(JSON.parse(b)); } catch { reject(new Error('create parse fail')); } });
      },
    );
    req.on('error', reject);
    req.end(body);
  });

  const transcriptId = createRes.id;
  if (!transcriptId) throw new Error('No transcript ID from AssemblyAI');

  // Poll until done (max 5 min)
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const poll = await new Promise<any>((resolve, reject) => {
      const req = https.request(
        { hostname: 'api.assemblyai.com', path: `/v2/transcript/${transcriptId}`, method: 'GET',
          headers: { authorization: apiKey } },
        (res) => {
          let b = '';
          res.on('data', (d) => { b += d; });
          res.on('end', () => { try { resolve(JSON.parse(b)); } catch { reject(new Error('poll parse fail')); } });
        },
      );
      req.on('error', reject);
      req.end();
    });
    if (poll.status === 'completed') {
      const items = (poll.words || []).map((w: any) => ({
        start_time: (w.start || 0) / 1000,
        end_time: (w.end || 0) / 1000,
        content: w.text || '',
      }));
      return { text: poll.text || '', items };
    }
    if (poll.status === 'error') throw new Error(`AssemblyAI error: ${poll.error}`);
  }
  throw new Error('AssemblyAI transcript timed out after 5 min');
}

// Stub transcription — produces a realistic fake transcript spanning the full chunk duration.
// This lets Gemini at least find moments via hint_start/hint_end even without real speech.
function stubTranscribe(chunkDurationSec: number): TranscriptResult {
  // Build words spaced evenly across the chunk so timestamps are valid for any duration.
  const words = [
    'this', 'is', 'a', 'motivational', 'speech', 'with', 'inspiring', 'music',
    'and', 'uplifting', 'message', 'believe', 'in', 'yourself', 'you', 'can',
    'do', 'anything', 'never', 'give', 'up', 'keep', 'going', 'forward',
    'success', 'comes', 'to', 'those', 'who', 'persist',
  ];
  const interval = chunkDurationSec / words.length;
  const items = words.map((w, i) => ({
    start_time: i * interval,
    end_time: (i + 1) * interval,
    content: w,
  }));
  return { text: words.join(' '), items };
}

async function main() {
  const geminiApiKey = process.env.GEMINI_API_KEY;
  if (!geminiApiKey) {
    console.error('ERROR: set GEMINI_API_KEY in .env first');
    process.exit(1);
  }

  const hasRealTranscription = !!process.env.ASSEMBLYAI_API_KEY;
  console.log(`Transcription: ${hasRealTranscription ? 'AssemblyAI (real)' : 'stub (fake words, timestamps only)'}`);
  if (!hasRealTranscription) {
    console.log('  Add ASSEMBLYAI_API_KEY=<key> to .env for real speech recognition.\n');
  }

  const svc = new VideoClipService({
    geminiApiKey,

    transcribeAudio: async (buf) => {
      if (hasRealTranscription) {
        try {
          return await assemblyAiTranscribe(buf);
        } catch (e: any) {
          console.warn(`  [transcribe] AssemblyAI failed: ${e?.message} — falling back to stub`);
        }
      }
      // Stub: fake words spread over one chunk (audio is mp3, so no header-derived duration).
      return stubTranscribe(CHUNK_LENGTH_SEC);
    },

    // Clips are rendered by the built-in renderer into ./output/<jobId>/.
    outputDir: path.join(__dirname, 'output'),

    chargeCredits: async (orgId, amount) => {
      console.log(`  [credits] charging ${amount} credits to org ${orgId}`);
      return true;
    },

    onOutput: (clip) => {
      console.log(`\n✓ Output #${clip.clipNo}:`);
      console.log(`  size:    ${clip.width}x${clip.height}, ${(clip.sizeBytes / 1024 / 1024).toFixed(1)} MB`);
      console.log(`  range:   ${clip.startSec.toFixed(1)}s – ${clip.endSec.toFixed(1)}s`);
      console.log(`  score:   ${clip.matchScore.toFixed(2)}`);
      console.log(`  caption: ${clip.caption ?? '(none)'}`);
      console.log(`  file:    ${clip.outputPath}`);
    },
  });

  console.log(`Starting clip job...`);
  console.log(`  source: ${SOURCE_URL}`);
  console.log(`  prompt: ${PROMPT}`);
  console.log(`  aspect: ${ASPECT_RATIO}, budget: ${CLIP_BUDGET}, chunk: ${CHUNK_LENGTH_SEC}s\n`);

  const jobId = await svc.start('test-org', {
    sourceUrl: SOURCE_URL,
    prompt: PROMPT,
    aspectRatio: ASPECT_RATIO,
    clipBudget: CLIP_BUDGET,
    chunkLengthSec: CHUNK_LENGTH_SEC,
    clipOutputSec: CLIP_OUTPUT_SEC,
  });

  console.log(`Job ID: ${jobId}`);

  await new Promise<void>((resolve) => {
    const iv = setInterval(() => {
      const job = svc.getJob(jobId);
      if (!job) { clearInterval(iv); resolve(); return; }
      console.log(`[poll] status=${job.status}  chunk=${job.currentChunkIndex}  emitted=${job.clipsEmitted}/${job.clipBudget}`);
      if (['done', 'failed', 'stopped'].includes(job.status)) {
        clearInterval(iv);
        if (job.status === 'failed') console.error(`\nJob failed: ${job.errorMessage}`);
        else console.log(`\nJob ${job.status}. Total outputs: ${job.outputs.length}`);
        resolve();
      }
    }, 3_000);
  });
}

main().catch((e) => { console.error(e); process.exit(1); });

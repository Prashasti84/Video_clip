import * as dotenv from 'dotenv';
dotenv.config();

import express, { Request, Response } from 'express';
import cors from 'cors';
import * as crypto from 'crypto';
import * as path from 'path';
import * as fs from 'fs';
import { AsyncLocalStorage } from 'async_hooks';
import axios from 'axios';
import { VideoClipService, VideoClipRendererService } from './src/index';
import { TranscriptResult } from './src/types';

const app  = express();
const PORT = Number(process.env.PORT) || 3737;
const ASSEMBLYAI_API_KEY = process.env.ASSEMBLYAI_API_KEY ?? '';

const CLIPS_DIR = path.join(process.cwd(), 'temp', 'clips-out');
const UPLOAD_DIR = path.join(process.cwd(), 'temp', 'uploads');
/** Job state, so jobs survive a server restart (running ones are resumed on start). */
const JOBS_DIR = path.join(process.cwd(), 'temp', 'jobs');
fs.mkdirSync(CLIPS_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/** Browser uploads: size cap, how long an unused upload is kept, and accepted containers. 16 GB fits a 3h 1080p video. */
const MAX_UPLOAD_BYTES = (Number(process.env.MAX_UPLOAD_MB) || 16384) * 1024 * 1024;
const UPLOAD_TTL_MS = 6 * 60 * 60 * 1000;
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.m4v', '.mkv', '.webm', '.avi', '.wmv', '.flv', '.mpeg', '.mpg', '.ts', '.3gp']);
/** Server-side file paths as a source are a local-dev convenience only — they let a caller read any file. */
const ALLOW_LOCAL_PATHS = process.env.ALLOW_LOCAL_PATHS === '1';
/** Password for the whole app (dashboard, API, clip files). Required in production — a public URL spends the API keys' credits. */
const APP_PASSWORD = process.env.APP_PASSWORD ?? '';
if (!APP_PASSWORD && process.env.NODE_ENV === 'production') {
  console.error('[Server] APP_PASSWORD is not set — refusing to start a public server without a password.');
  process.exit(1);
}

/** Opens clip files only (?key=…), for <video> / <img> tags that can't send headers. Derived, so a shared clip link never reveals the password. */
const MEDIA_KEY = APP_PASSWORD ? crypto.createHmac('sha256', APP_PASSWORD).update('clips-out').digest('hex') : '';

// Before the password check, so cross-site preflights (dashboard hosted on Vercel) are answered.
app.use(cors());

// Same-site dashboard: HTTP Basic auth — the browser asks once and sends it with every request; any username works.
// Dashboard on another site: it sends `Authorization: Bearer <URI-encoded password>` itself.
if (APP_PASSWORD) {
  const digest = (s: string) => crypto.createHash('sha256').update(s).digest();
  // Hashing both sides gives equal-length buffers, so the comparison is constant-time.
  const matches = (given: string, secret: string) => crypto.timingSafeEqual(digest(given), digest(secret));
  app.use((req: Request, res: Response, next) => {
    const auth = String(req.get('authorization') ?? '');
    const sp = auth.indexOf(' ');
    const scheme = sp < 0 ? auth : auth.slice(0, sp);
    const value = sp < 0 ? '' : auth.slice(sp + 1);
    let given = '';
    try {
      if (scheme === 'Basic') given = Buffer.from(value, 'base64').toString().split(':').slice(1).join(':');
      if (scheme === 'Bearer') given = decodeURIComponent(value);
    } catch { /* malformed — stays '' */ }
    if (matches(given, APP_PASSWORD)) return next();
    if (req.method === 'GET' && req.path.startsWith('/clips-out/') && matches(String(req.query.key ?? ''), MEDIA_KEY)) return next();
    // No Basic challenge for a Bearer caller, so a cross-site dashboard asks in its own prompt rather than the browser's.
    if (scheme !== 'Bearer') res.set('WWW-Authenticate', 'Basic realm="Video Clip", charset="UTF-8"');
    res.status(401).json({ error: 'Password required' });
  });
}

app.use(express.json());

// Serve generated clip files directly
app.use('/clips-out', express.static(CLIPS_DIR));
// Serve the dashboard (only the dashboard — not the project's source files)
app.get(['/', '/dashboard.html'], (_req: Request, res: Response) => {
  res.sendFile(path.join(process.cwd(), 'dashboard.html'));
});

// ── transcribeAudio: AssemblyAI REST ────────────────────────────────────────
const assembly = axios.create({
  baseURL: 'https://api.assemblyai.com/v2',
  headers: { authorization: ASSEMBLYAI_API_KEY },
  timeout: 60_000,
});
/** Chunk audio is 32 kbps mp3 (VideoIngestService.extractAudio) — bytes → seconds. */
const AUDIO_BYTES_PER_SEC = 4000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retries network errors, timeouts, 429 and 5xx with backoff (honouring Retry-After); 4xx fail at once. */
async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 5): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e: any) {
      const status: number | undefined = e?.response?.status;
      const transient = !status || status === 429 || status >= 500;
      if (!transient || i >= attempts - 1) throw e;
      const retryAfter = Number(e?.response?.headers?.['retry-after']) * 1000;
      const wait = Math.min(60_000, retryAfter > 0 ? retryAfter : 2_000 * 2 ** i);
      console.log(`[Server] AssemblyAI ${label} failed (${status ?? e?.code ?? e?.message}) — retrying in ${Math.round(wait / 1000)}s.`);
      await sleep(wait);
    }
  }
}

async function transcribeAudio(buf: Buffer): Promise<TranscriptResult | null> {
  if (!ASSEMBLYAI_API_KEY) return null;
  try {
    // 1. Upload audio buffer
    const uploadRes = await withRetry('upload', () => assembly.post('/upload', buf, {
      headers: { 'content-type': 'application/octet-stream' },
      maxBodyLength: Infinity,
      timeout: 180_000,
    }));
    const audioUrl: string = uploadRes.data.upload_url;

    // 2. Submit transcript job
    const submitRes = await withRetry('submit', () => assembly.post('/transcript', { audio_url: audioUrl, word_boost: [] }));
    const transcriptId: string = submitRes.data.id;

    // 3. Poll until done. Longer chunks take longer — allow 5 min, or more for long audio.
    const maxWaitMs = Math.max(5 * 60_000, (180 + (buf.length / AUDIO_BYTES_PER_SEC) * 0.6) * 1000);
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      await sleep(3000);
      const pollRes = await withRetry('poll', () => assembly.get(`/transcript/${transcriptId}`));
      const { status, text, words, error } = pollRes.data;
      if (status === 'completed') {
        const items = (words ?? []).map((w: any) => ({
          start_time: w.start / 1000,
          end_time:   w.end   / 1000,
          content:    w.text,
        }));
        return { text: text ?? '', items };
      }
      if (status === 'error') {
        // Silence / music is a valid result, not a failure worth retrying.
        if (/no spoken audio|does not appear to contain audio|audio duration/i.test(String(error))) return { text: '', items: [] };
        console.error(`[transcribeAudio] AssemblyAI transcript error: ${error}`);
        return null;
      }
    }
    console.error(`[transcribeAudio] AssemblyAI did not finish within ${Math.round(maxWaitMs / 60_000)} min — giving up on this attempt.`);
    return null;
  } catch (e: any) {
    console.error('[transcribeAudio] AssemblyAI error:', e?.response?.data?.error ?? e?.message);
    return null;
  }
}

// ── chargeCredits: stub always approves ─────────────────────────────────────
async function chargeCredits(_orgId: string, _amount: number) {
  return true;
}

const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? '';
if (!GEMINI_API_KEY)  console.warn('[server] WARNING: GEMINI_API_KEY not set');
if (!ASSEMBLYAI_API_KEY) console.warn('[server] WARNING: ASSEMBLYAI_API_KEY not set — transcription disabled, every chunk will be skipped (same as LiveCut)');

// Per-job log buffer so the dashboard can read real server logs. Also appended to
// temp/jobs/<jobId>.log, so a job's Activity history survives a server restart.
const jobLogs = new Map<string, string[]>();
fs.mkdirSync(JOBS_DIR, { recursive: true });
const logFile = (jobId: string) => path.join(JOBS_DIR, `${jobId}.log`);

function logsFor(jobId: string): string[] {
  let lines = jobLogs.get(jobId);
  if (!lines) {
    try { lines = fs.readFileSync(logFile(jobId), 'utf8').split('\n').filter(Boolean); } catch { lines = []; }
    jobLogs.set(jobId, lines);
  }
  return lines;
}

// Stores the line for the dashboard; prints it only when it didn't already come through the
// console interceptor below. Printing via the intercepted console.log here recursed forever on
// any line matching the interceptor's tag filter.
function jobLog(jobId: string, msg: string, print = true) {
  logsFor(jobId).push(msg);
  try { fs.appendFileSync(logFile(jobId), msg.replace(/\n/g, ' ') + '\n'); } catch { /* the in-memory copy still works */ }
  if (print) _origLog(`[${jobId.slice(0,8)}] ${msg}`);
}

// Intercept console.log/error so all [Process]/[Scorer]/[Ingest] lines appear in the dashboard
// activity panel of the job that printed them. Every job runs inside jobContext (runInContext
// below), so the right job is known even when several run at once.
const jobContext = new AsyncLocalStorage<string>();
const _origLog   = console.log.bind(console);
const _origError = console.error.bind(console);
console.log = (...args: any[]) => {
  _origLog(...args);
  const jobId = jobContext.getStore();
  if (jobId) {
    const line = args.map(a => (typeof a === 'string' ? a : String(a))).join(' ');
    if (/\[(Process|Scorer|Ingest|Output|Render|Server)\]/.test(line)) {
      jobLog(jobId, line, false);
    }
  }
};
console.error = (...args: any[]) => {
  _origError(...args);
  const jobId = jobContext.getStore();
  if (jobId) {
    const line = args.map(a => (typeof a === 'string' ? a : String(a))).join(' ');
    jobLog(jobId, `[ERROR] ${line}`, false);
  }
};

// A stray rejection must not take down the server (and every running job with it).
process.on('unhandledRejection', (e: any) => console.error('[Server] Unhandled rejection:', e?.stack ?? e));

const renderer = new VideoClipRendererService();
const clipService = new VideoClipService({
  geminiApiKey: GEMINI_API_KEY,
  transcribeAudio,
  chargeCredits,
  // Rendered files land in CLIPS_DIR/<jobId>/ and are served by the /clips-out static route.
  outputDir: CLIPS_DIR,
  publishFile: async (localPath) =>
    '/clips-out/' + path.relative(CLIPS_DIR, localPath).split(path.sep).join('/'),
  onOutput: (output) => {
    jobLog(output.jobId, `[Output] Clip #${output.clipNo} ready → ${output.outputPath} (${output.width}×${output.height}, score ${output.matchScore.toFixed(2)})`);
  },
  stateDir: JOBS_DIR,
  runInContext: (jobId, run) => jobContext.run(jobId, run),
});

// ── Uploads ──────────────────────────────────────────────────────────────────
// Stored as temp/uploads/<uploadId><ext>; the id is a UUID so it can never escape the folder.
interface UploadInfo { path: string; fileName: string; sizeBytes: number; durationSec: number }
const uploads = new Map<string, UploadInfo>();
const UPLOAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function findUpload(uploadId: string): UploadInfo | null {
  if (!UPLOAD_ID_RE.test(uploadId)) return null;
  const known = uploads.get(uploadId);
  if (known && fs.existsSync(known.path)) return known;
  // Survives a server restart: the file is still on disk even though the map is empty.
  const file = fs.readdirSync(UPLOAD_DIR).find((f) => f.startsWith(uploadId));
  return file ? { path: path.join(UPLOAD_DIR, file), fileName: file, sizeBytes: 0, durationSec: 0 } : null;
}

function sweepUploads() {
  const cutoff = Date.now() - UPLOAD_TTL_MS;
  for (const f of fs.readdirSync(UPLOAD_DIR)) {
    const p = path.join(UPLOAD_DIR, f);
    try {
      if (fs.statSync(p).mtimeMs < cutoff) {
        fs.rmSync(p, { force: true });
        uploads.delete(f.slice(0, 36));
      }
    } catch { /* ignore */ }
  }
}
sweepUploads();
setInterval(sweepUploads, 30 * 60 * 1000).unref();

// POST /uploads — raw request body is the video file; X-File-Name carries its (URI-encoded) name.
// Streamed straight to disk, so the size of the file never matters for memory.
app.post('/uploads', (req: Request, res: Response) => {
  let fileName = 'upload.mp4';
  try { fileName = decodeURIComponent(String(req.get('x-file-name') || fileName)); } catch { /* keep default */ }
  fileName = path.basename(fileName).replace(/[\u0000-\u001f]/g, '').slice(0, 200) || 'upload.mp4';
  const ext = path.extname(fileName).toLowerCase();
  if (!VIDEO_EXTS.has(ext)) {
    return res.status(415).json({ error: `Unsupported file type "${ext || 'none'}" — upload a video (mp4, mov, mkv, webm…).` });
  }
  if (Number(req.get('content-length')) > MAX_UPLOAD_BYTES) {
    return res.status(413).json({ error: `File is larger than the ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB upload limit.` });
  }

  const uploadId = crypto.randomUUID();
  const filePath = path.join(UPLOAD_DIR, uploadId + ext);
  const out = fs.createWriteStream(filePath);
  let received = 0;
  let settled = false;
  const fail = (status: number, error: string) => {
    if (settled) return;
    settled = true;
    req.unpipe(out);
    out.destroy();
    fs.rm(filePath, { force: true }, () => {});
    if (!res.headersSent) res.status(status).json({ error });
  };

  req.on('data', (chunk: Buffer) => {
    received += chunk.length;
    if (received > MAX_UPLOAD_BYTES) {
      fail(413, 'File is larger than the upload limit.');
      req.destroy();
    }
  });
  req.on('close', () => { if (!req.complete) fail(400, 'Upload was interrupted.'); });
  out.on('error', (e) => fail(500, `Could not save the upload: ${e.message}`));
  out.on('finish', async () => {
    if (settled) return;
    if (received === 0) return fail(400, 'The file is empty.');
    try {
      const probe = await renderer.probe(filePath);
      if (!probe.hasVideo) return fail(415, 'This file has no video track.');
      if (!(probe.durationSec > 1)) return fail(415, 'The video is empty or too short to clip.');
      settled = true;
      const info: UploadInfo = { path: filePath, fileName, sizeBytes: received, durationSec: probe.durationSec };
      uploads.set(uploadId, info);
      console.log(`[Server] Upload ${uploadId.slice(0, 8)} saved — ${fileName} (${(received / 1024 / 1024).toFixed(1)} MB, ${probe.durationSec.toFixed(0)}s)`);
      res.json({ uploadId, fileName, sizeBytes: received, durationSec: probe.durationSec, width: probe.width, height: probe.height });
    } catch {
      fail(415, 'Could not read this file as a video.');
    }
  });
  req.pipe(out);
});

// DELETE /uploads/:id — discard an upload the user removed (a running job keeps its own hard link)
app.delete('/uploads/:id', (req: Request, res: Response) => {
  const info = findUpload(String(req.params.id));
  if (info) fs.rmSync(info.path, { force: true });
  uploads.delete(String(req.params.id));
  res.json({ ok: !!info });
});

// ── Routes ───────────────────────────────────────────────────────────────────

// POST /jobs — start a new clip job from { uploadId } or { sourceUrl: http(s) link }
app.post('/jobs', async (req: Request, res: Response) => {
  try {
    const { orgId = 'default', uploadId, sourceUrl, ...rest } = req.body ?? {};
    const dto: any = {
      prompt: rest.prompt,
      negativePrompt: rest.negativePrompt,
      aspectRatio: rest.aspectRatio,
      framing: rest.framing,
      clipBudget: rest.clipBudget,
      fillToTarget: rest.fillToTarget,
      chunkLengthSec: rest.chunkLengthSec,
      clipOutputSec: rest.clipOutputSec,
      sourceName: rest.sourceName,
    };
    if (!String(dto.prompt ?? '').trim()) return res.status(400).json({ error: 'prompt is required' });

    if (uploadId) {
      const upload = findUpload(String(uploadId));
      if (!upload) return res.status(404).json({ error: 'Upload not found — it may have expired. Upload the file again.' });
      dto.sourceUrl = upload.path;
      dto.sourceName = dto.sourceName || upload.fileName;
    } else {
      const src = String(sourceUrl ?? '').trim();
      if (!src) return res.status(400).json({ error: 'Provide a video link (sourceUrl) or upload a file (uploadId).' });
      if (!/^https?:\/\//i.test(src) && !ALLOW_LOCAL_PATHS) {
        return res.status(400).json({ error: 'sourceUrl must be an http(s) link — upload local files instead.' });
      }
      dto.sourceUrl = src;
    }

    const jobId = await clipService.start(String(orgId), dto);
    jobLog(jobId, `[Server] Job started — source: ${dto.sourceName || dto.sourceUrl}`);
    res.json({ jobId });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

// GET /jobs/:id — poll job state
app.get('/jobs/:id', (req: Request, res: Response) => {
  const id  = String(req.params.id);
  const job = clipService.getJob(id);
  if (!job) return res.status(404).json({ error: 'not found' });
  res.json({ ...job, serverLogs: logsFor(id) });
});

// GET /jobs — list all jobs for an org
app.get('/jobs', (req: Request, res: Response) => {
  const orgId = String(req.query.orgId ?? 'default');
  res.json(clipService.listJobs(orgId));
});

// DELETE /jobs/:id — stop + delete job
app.delete('/jobs/:id', (req: Request, res: Response) => {
  const id = String(req.params.id);
  const ok = clipService.deleteJob(id);
  jobLogs.delete(id);
  fs.rm(logFile(id), { force: true }, () => {});
  res.json({ ok });
});

// POST /jobs/:id/stop — stop without deleting
app.post('/jobs/:id/stop', (req: Request, res: Response) => {
  const ok = clipService.stop(String(req.params.id));
  res.json({ ok });
});

// POST /jobs/:id/retry — run a failed / stopped job again in place (clips already cut are kept)
app.post('/jobs/:id/retry', async (req: Request, res: Response) => {
  const id = String(req.params.id);
  try {
    await clipService.retry(id);
    jobLog(id, '[Server] Job restarted');
    res.json({ ok: true });
  } catch (e: any) {
    res.status(clipService.getJob(id) ? 409 : 404).json({ error: e?.message ?? String(e) });
  }
});

// GET /config — limits the dashboard should enforce before uploading, and the clip-file key
app.get('/config', (_req: Request, res: Response) => {
  res.json({ maxUploadBytes: MAX_UPLOAD_BYTES, ...(MEDIA_KEY ? { mediaKey: MEDIA_KEY } : {}) });
});

const resumed = clipService.resumeInterrupted();
for (const id of resumed) jobLog(id, '[Server] Server restarted — resuming this job');
// Activity logs of jobs the service has since forgotten (deleted / expired).
for (const name of fs.readdirSync(JOBS_DIR)) {
  if (name.endsWith('.log') && !clipService.getJob(name.slice(0, -4))) fs.rm(path.join(JOBS_DIR, name), { force: true }, () => {});
}

const server = app.listen(PORT, () => {
  console.log(`\n✅  Video Clip Server running at http://localhost:${PORT}`);
  console.log(`   Dashboard: http://localhost:${PORT}/dashboard.html`);
  console.log(`   Clips dir: ${CLIPS_DIR}`);
  console.log(`   Password:  ${APP_PASSWORD ? 'on' : 'off (set APP_PASSWORD to require one)'}`);
  if (resumed.length) console.log(`   Resumed ${resumed.length} job(s) interrupted by the last shutdown`);
  console.log('');
});
// Large uploads can take longer than Node's default 5-minute request timeout.
server.requestTimeout = 0;

// Save job state on the way out, so the next start resumes exactly where this one stopped.
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, () => {
    clipService.flush();
    process.exit(0);
  });
}

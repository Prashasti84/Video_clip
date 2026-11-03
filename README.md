# Video Clip Module

Standalone TypeScript module that cuts **pre-recorded videos** (YouTube VODs, any yt-dlp-compatible URL, or a file uploaded from the browser) into prompt-matched short **MP4 clips**.

Same architecture as LiveCut (`backend/src/livecut/`) but for offline video — no live stream buffer, no channel-poll loop.

## Architecture

```
VideoClipService             ← orchestrator (download → process → done)
  VideoIngestService         ← link: metadata + audio-only download, stream links for rendering;
                               file: hard-link; exact-range audio reads
  VideoProcessService        ← scan → select → cut          (port of live-watch.service.ts)
    VideoScorerService       ← Gemini moment selection      (port of live-window-scorer.service.ts)
    VideoAudioEnergyService  ← loudness peaks               (port of live-audio-energy.service.ts)
    VideoClipRendererService ← frame-accurate mp4 + poster frame (ffmpeg / ffprobe)
  theme-guidance.ts          ← SegmentAnalyzerService.buildThemeGuidance, verbatim
  gemini-models.ts           ← backend Gemini model ladder
```

## How a job runs

User pastes a URL or uploads a file, writes a prompt, picks **how many clips** (`clipBudget`, default 5) and **how long** (`clipOutputSec`, default 30):

0. **Ingest** — a link is **not downloaded as video**: yt-dlp fetches its metadata (`info.json`) and the **audio track only** (2h44m YouTube stream: 159 MB / ~40s instead of 5.2 GB / ~20 min). The scan needs nothing else, and each clip's picture is read straight from the remote stream for just its own seconds at render time. Sites that only offer combined files are downloaded whole (≤ 1080p), as before. Uploads are hard-linked.
1. **Scan** — the whole video, `chunkLengthSec` at a time. Each chunk is transcribed once and scored by Gemini. A moment is a whole beat — setup through payoff, up to the clip length — and the verbatim peak line is tracked separately. Each window overlaps the previous chunk (≥ 30s) so boundary moments are seen whole. Every match ≥ 0.60 becomes a candidate.
   - Chunks are transcribed `CLIP_SCAN_CONCURRENCY` at a time (default 6) and scored by Gemini `CLIP_SCORE_CONCURRENCY` at a time (default 4 — lower it if a free-tier key keeps hitting rate limits). A chunk is scored as soon as it and the chunk before it are transcribed. Chunk audio is 16 kHz mono 32 kbps mp3.
   - A chunk whose audio / transcription fails is retried after 5s and 20s, then skipped. When Gemini is unavailable the chunk is re-scored after 15s / 45s — unless every model is backed off for longer than 2 min (e.g. a used-up daily quota).
   - Each chunk's transcript is cached on disk (`temp/chunk-cache`, 7 days), keyed by the source (URL, or a content fingerprint for files) and the chunk range — a retried, resumed or re-prompted job over the same video doesn't pay for transcription again.
2. **Select** — all candidates are ranked across the **whole video** (theme score + energy bonus) and the best N are picked, at least 20s apart. Real matches that only lost on spacing get a second chance with a 3s gap before anything weaker is used. Loud-only candidates must pass `confirmEnergyMoment`.
   - Fewer real matches than N and `fillToTarget` on (default): the rest is filled with the closest available moments (`findBestMoments`), then loud / evenly spaced moments, and the timeline is re-packed if the clips only fit back-to-back. These are flagged `bestAvailable: true`.
   - `fillToTarget: false` ("Strong matches only"): only matches ≥ 0.75, may return fewer.
   - Capped by what physically fits (e.g. a 60s video holds two 30s clips).
   - If Gemini or transcription is down, nothing is filled with random footage — the job reports the error.
3. **Cut** — best first, 2 at a time (`CLIP_RENDER_CONCURRENCY`):
   - the clip is placed with ~65% of the spare time before the beat (viewers need the setup) and always keeps the peak line plus a short reaction;
   - both cut points snap (≤ 4s / 15% of the clip) to a pause in speech, preferring sentence ends — clips never start or stop mid-word, and never run into a neighbouring clip;
   - rendered frame-accurately (re-encode, not stream copy) to H.264/AAC at the requested aspect ratio — `framing: 'crop'` fills the frame, `'blur'` fits the whole picture over a blurred copy — 1080p for HD sources, else 720p, with short audio fades and only the first audio track;
   - the poster frame is taken at the peak line. A failed render is replaced by the next-best candidate; credits are charged only after a clip is rendered and published.
   - link sources render from the remote stream (≤ 1080p, H.264 preferred) with the downloaded audio track as the sound — ffmpeg range-seeks, so a clip 2.5h into a stream takes ~20s, frame-identical to cutting a local copy. If the stream can't be read (expired / refused link) the links are fetched fresh and the render retried; if that fails too, the full video is downloaded once and the remaining clips are cut from it.

If transcription failed for every chunk, or Gemini could not score any, the job ends `failed` (so it can be retried) instead of `done`.

## Reliability: restarts, retries, long videos

With `stateDir` set (the dev server uses `temp/jobs`):

- Job state is written there (every 2s, and at once when a clip is cut or the status changes).
- `resumeInterrupted()` restarts jobs a crash / restart cut off. Clips already cut are kept and count toward the budget, the prepared source is reused (a download is marked complete on disk, so a half-finished one is never mistaken for the video), and cached transcripts make the re-scan quick. A job interrupted 3 times is failed instead of resumed again.
- `retry(jobId)` re-runs a failed or stopped job in place, with the same rules. It waits for a stopping run to finish its current step first.
- A failed / stopped job keeps its source for 2h (for Retry); finished jobs are forgotten after 7 days.

Without `stateDir` jobs live in memory only, as before.

## Dependencies (runtime)

- `ffmpeg` + `ffprobe` in PATH
- `yt-dlp` in PATH (for URL sources)
- `@google/generative-ai`

Optional env: `APP_PASSWORD` (dev server — HTTP Basic auth on every route; required when `NODE_ENV=production`), `CLIP_SCAN_CONCURRENCY` (default 3), `CLIP_RENDER_CONCURRENCY` (default 2), `CLIP_X264_PRESET` (default `veryfast`), `CLIP_X264_CRF` (default 21), `FFMPEG_THREADS`.

## Usage

```typescript
import { VideoClipService } from './src';

const svc = new VideoClipService({
  geminiApiKey: process.env.GEMINI_API_KEY!,
  transcribeAudio: (mp3) => transcriptionService.transcribe(mp3),   // null = failure (chunk retried twice, then skipped)
  canAfford: async (orgId, amt) => (await credits.getCredits(orgId)).balanceCredits >= amt,
  chargeCredits: async (orgId, amt) => { await credits.reserveCredits(orgId, amt, 'video_clip'); return true; },
  outputDir: '/tmp/video-clip-out',                                 // default temp/clips-out
  publishFile: (localPath, kind, job) => storage.upload(localPath), // kind: 'clip' | 'thumb'
  onOutput: (o) => console.log(o.outputPath, o.width, o.height, o.caption),
  stateDir: '/var/lib/video-clip/jobs',                             // optional — survive restarts
  cacheDir: '/var/cache/video-clip',                                // default temp/chunk-cache; null = off
});
svc.resumeInterrupted();                                            // after a restart

const jobId = await svc.start('org-abc', {
  sourceUrl: 'https://www.youtube.com/watch?v=…',   // or an absolute local file path
  prompt: 'funny moments',
  aspectRatio: '9:16',         // '16:9' | '9:16' | '1:1'
  framing: 'blur',             // 'crop' (default) | 'blur'
  clipBudget: 5,               // how many clips to cut
  clipOutputSec: 30,           // target length; cuts snap to pauses so it varies a little
  fillToTarget: true,          // false = strong matches only (may return fewer)
  chunkLengthSec: 300,
});

svc.getJob(jobId);         // status, phase, threshold, downloadPct, outputs[], events[]
svc.stop(jobId);           // also cancels an in-flight download
await svc.retry(jobId);    // failed / stopped → run again, keeping the clips already cut
```

## Dev server (`npm run server`)

Serves `dashboard.html` at `http://localhost:3737` (`PORT` to change).

| Route | |
|---|---|
| `POST /uploads` | Raw video file as the request body, original name in the `X-File-Name` header (URI-encoded). Streamed to `temp/uploads/`, checked with ffprobe → `{ uploadId, fileName, sizeBytes, durationSec, width, height }`. Limit `MAX_UPLOAD_MB` (default 16384 — a 3h 1080p file is typically 4–8 GB). Unused uploads are deleted after 6h. |
| `DELETE /uploads/:id` | Discard an upload. A job already started from it keeps its own copy. |
| `POST /jobs` | `{ uploadId }` or `{ sourceUrl: "https://…" }` plus the job settings above. Server file paths are refused unless `ALLOW_LOCAL_PATHS=1`. |
| `GET /jobs/:id`, `GET /jobs`, `POST /jobs/:id/stop`, `DELETE /jobs/:id` | Poll / list / stop / delete. |
| `POST /jobs/:id/retry` | Run a failed / stopped job again, keeping its clips. 409 with a reason if it can't. |
| `GET /config` | `{ maxUploadBytes, mediaKey? }` — the dashboard checks file size against it before uploading; `mediaKey` (only with `APP_PASSWORD`) opens clip files via `?key=`. |

Jobs and their Activity logs are kept in `temp/jobs/`; on start the server resumes any job the last shutdown interrupted. Ctrl+C saves state before exiting. The dashboard re-lists the org's jobs from the server after a page reload, shows **Reconnecting…** while the server is unreachable (and won't silently fall back to demo jobs), and offers **Retry** / **Resume** on failed / stopped jobs.

## Deploying (Railway / Render / Fly.io)

The server can't run on Vercel — serverless functions can't run ffmpeg / yt-dlp, multi-minute jobs or multi-GB uploads. The `Dockerfile` builds one image with Node 22, ffmpeg and yt-dlp and runs `node dist/server.js` (dashboard + API on one URL).

1. Push the repo to GitHub (`.env`, `temp/`, `node_modules/` are git- and docker-ignored).
2. Railway → **New Project → Deploy from GitHub repo**. The Dockerfile is picked up automatically.
3. **Variables**: `GEMINI_API_KEY`, `ASSEMBLYAI_API_KEY`, `APP_PASSWORD` (required — the server refuses to start in production without it), optionally `MAX_UPLOAD_MB` (e.g. `2048`).
4. **Volume** mounted at `/app/temp` — otherwise jobs, clips and the transcript cache are wiped on every redeploy.
5. **Settings → Networking → Generate Domain**. Open it; the browser asks for the password once (any username).

YouTube often blocks cloud IPs ("Sign in to confirm you're not a bot"); uploads are unaffected.

### Dashboard on Vercel (optional)

The server above is still required — Vercel only hosts the dashboard page. `vercel.json` skips `npm install` / `tsc` and runs `vercel-build.js`, which writes `public/index.html` from `dashboard.html`.

1. Vercel → import the repo. Leave Framework Preset, Build Command and Output Directory on their defaults (`vercel.json` sets them).
2. **Environment Variables**: `VIDEO_CLIP_API_URL` = the server's https URL (e.g. `https://video-clip.up.railway.app`). Unset → demo mode.
3. Redeploy. The dashboard asks for `APP_PASSWORD` once (kept in the browser) and sends it as `Authorization: Bearer …`; `<video>` / `<img>` tags load clips with `?key=` — a key derived from the password that opens `/clips-out/` files only (`GET /config` → `mediaKey`).

## Wiring into the NestJS backend (when ready)

1. Create `backend/src/video-clip/video-clip.module.ts` that imports this module's services.
2. Register it in `app.module.ts` (same pattern as `LivecutModule`).
3. Add Prisma models `VideoClipJob`, `VideoClipOutput` (mirrors `LiveSession`, `LiveClip`).
4. Expose via `VideoClipController` at `/video-clip/jobs`.

> The user instruction says **do not touch existing backend files** — this README is here for when that restriction is lifted.

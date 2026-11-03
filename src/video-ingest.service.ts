import { ChildProcess, spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ClipSource } from './video-clip-renderer.service';

const TEMP_ROOT = path.join(process.cwd(), 'temp', 'videoclip');
/** Quality cap for the picture — clips are rendered at up to 1080p, so nothing above that is read. */
const MAX_VIDEO_HEIGHT = 1080;
/** Written next to the source once it is complete — a source without it is a partial download. */
const MARKER_FILE = 'source.json';
/** yt-dlp metadata of a link source: stream URLs for rendering, reused by the audio download. */
const INFO_FILE = 'info.json';
/** Stream URLs expire (YouTube: ~6h) — metadata older than this is fetched again before rendering. */
const INFO_MAX_AGE_MS = 3 * 60 * 60 * 1000;
/** A refresh this recent is reused, so concurrent renders that all hit an expired link refresh once. */
const REFRESH_REUSE_MS = 60_000;
const METADATA_TIMEOUT_MS = 2 * 60_000;
/** Bytes hashed from each end of a local file to identify its content (hashing all of a 5 GB file is too slow). */
const FINGERPRINT_BYTES = 1024 * 1024;
/** Protocols ffmpeg can seek in directly (byte ranges / HLS segments). */
const STREAMABLE = new Set(['https', 'http', 'm3u8', 'm3u8_native']);

export interface PreparedVideo {
  dir: string;
  /**
   * What the scan reads audio from. 'video': the whole video (an upload, or a link with no
   * separate audio stream). 'audio': only the audio track of a link — the picture of each clip is
   * streamed from the link at render time, so a 3h video never has to be downloaded.
   */
  sourcePath: string;
  kind: 'video' | 'audio';
  /** The link, for 'audio' sources. */
  pageUrl?: string;
  totalDurationSec: number;
  /** Identifies the source's content across jobs (chunk-cache key). */
  sourceKey: string;
}

/**
 * Gets a job's source onto disk once and exposes exact time-range reads.
 *
 * Links are scanned from their AUDIO alone (tens of MB instead of GBs); each clip's picture is then
 * read straight from the remote stream for just its own few seconds (ffmpeg range-seeks). If that
 * stream can't be read even with fresh links, the full video is downloaded as a last resort.
 *
 * Every chunk / moment is read at its absolute offset from the source file — no concat-of-segments
 * extract, whose start padding would shift every chunk-relative timestamp.
 *
 * A prepared source is marked complete on disk, so a job resumed after a server restart or retried
 * after a failure reuses it instead of downloading again.
 */
export class VideoIngestService {
  private readonly jobs = new Map<string, PreparedVideo>();
  /** Running yt-dlp / metadata processes per job — a stop kills them all. */
  private readonly procs = new Map<string, Set<ChildProcess>>();
  /** Jobs stopped since their last prepareVideo — their processes' exits are cancellations, not errors. */
  private readonly stopped = new Set<string>();
  private readonly refreshes = new Map<string, { at: number; promise: Promise<any> }>();
  private readonly fullDownloads = new Map<string, Promise<string>>();

  async prepareVideo(jobId: string, sourceUrl: string, onProgress?: (pct: number) => void): Promise<PreparedVideo> {
    this.stopped.delete(jobId);
    const existing = this.jobs.get(jobId);
    if (existing && fs.existsSync(existing.sourcePath)) return existing;

    const dir = path.join(TEMP_ROOT, jobId);
    fs.mkdirSync(dir, { recursive: true });

    const saved = this.readMarker(dir);
    if (saved) {
      console.log(`[Ingest] Reusing the source prepared earlier: ${saved.totalDurationSec.toFixed(1)}s`);
      this.jobs.set(jobId, saved);
      return saved;
    }
    // Anything here without a marker is a partial download / copy — yt-dlp (--no-part) would take it as complete.
    this.clearSource(dir);

    let result: PreparedVideo;
    if (/^https?:\/\//i.test(sourceUrl)) {
      result = await this.prepareLink(jobId, dir, sourceUrl, onProgress);
    } else if (this.isLocalPath(sourceUrl)) {
      if (!fs.existsSync(sourceUrl) || !fs.statSync(sourceUrl).isFile()) {
        throw new Error('The source file is no longer on the server — upload it again.');
      }
      const sourcePath = path.join(dir, `source${path.extname(sourceUrl).toLowerCase() || '.mp4'}`);
      this.linkOrCopy(sourceUrl, sourcePath);
      const totalDurationSec = await this.probeDuration(sourcePath);
      result = { dir, sourcePath, kind: 'video', totalDurationSec, sourceKey: `${this.fingerprint(sourcePath)}|${totalDurationSec.toFixed(2)}` };
    } else {
      throw new Error('Unsupported video source — use an http(s) link or an uploaded file.');
    }
    if (!(result.totalDurationSec > 1)) throw new Error('The video is empty or too short to clip.');
    console.log(`[Ingest] Source ready: ${result.totalDurationSec.toFixed(1)}s (${result.kind === 'audio' ? 'audio track only — clips stream their picture from the link' : 'full video'})`);

    this.writeMarker(result);
    this.jobs.set(jobId, result);
    return result;
  }

  /** Kills the job's in-flight downloads (job stopped / deleted). */
  abort(jobId: string): void {
    this.stopped.add(jobId);
    for (const proc of this.procs.get(jobId) ?? []) {
      try { proc.kill('SIGKILL'); } catch { /* already gone */ }
    }
  }

  getSourcePath(jobId: string): string {
    return this.prepared(jobId).sourcePath;
  }

  getSourceKey(jobId: string): string {
    return this.prepared(jobId).sourceKey;
  }

  getWorkDir(jobId: string): string {
    return this.prepared(jobId).dir;
  }

  /** True when the scan file has no picture and clips are streamed from the link instead. */
  isAudioOnly(jobId: string): boolean {
    return this.prepared(jobId).kind === 'audio';
  }

  /**
   * Where a clip's picture and sound are read from.
   *   'stream'   — the remote video stream (+ the local audio track) for link sources;
   *   'refresh'  — the same with freshly fetched stream links (they expire / get refused);
   *   'download' — the full video, downloaded once (shared by concurrent renders).
   * Uploads and fully downloaded sources always render from the local file.
   */
  async renderSource(jobId: string, mode: 'stream' | 'refresh' | 'download' = 'stream'): Promise<ClipSource> {
    const v = this.prepared(jobId);
    if (v.kind === 'video') return { video: v.sourcePath };
    const full = this.fullVideoPath(v.dir);
    if (full) return { video: full, audio: v.sourcePath };
    if (mode === 'download') return { video: await this.downloadFullVideo(jobId, v), audio: v.sourcePath };

    let info = this.readInfo(v.dir);
    if (mode === 'refresh' || !info || Date.now() - info.fetchedAt > INFO_MAX_AGE_MS) info = await this.refreshInfo(jobId, v);
    const f = this.pickVideoFormat(info.data);
    if (!f) throw new Error('The link has no video stream to cut clips from.');
    return { video: f.url, headers: f.http_headers ?? undefined, audio: v.sourcePath };
  }

  /**
   * Frame-accurate mp4 of [startSec, endSec) — re-encoded so the file starts exactly at startSec.
   * Only needed by tools (diagnose.ts); the pipeline itself reads the source directly.
   */
  async extractClip(jobId: string, startSec: number, endSec: number): Promise<string> {
    const info = this.prepared(jobId);
    const outPath = path.join(info.dir, `clip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`);
    await this.run([
      '-ss', String(startSec), '-i', info.sourcePath, '-t', String(endSec - startSec),
      '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-movflags', '+faststart', '-y', outPath,
    ], 'ffmpeg extract');
    return outPath;
  }

  /**
   * Audio of [startSec, endSec) as 16kHz mono 32kbps mp3 — plenty for speech recognition, and half
   * the upload of 64kbps (raw wav of a long chunk would exceed Whisper's 25MB upload cap).
   * Returns null when the range has no decodable audio.
   */
  async extractAudio(jobId: string, startSec: number, endSec: number): Promise<Buffer | null> {
    const info = this.jobs.get(jobId);
    if (!info) return null;
    const outPath = path.join(info.dir, `audio-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp3`);
    try {
      await this.run([
        '-ss', String(startSec), '-i', info.sourcePath, '-t', String(endSec - startSec),
        '-vn', '-ar', '16000', '-ac', '1', '-b:a', '32k', '-y', outPath,
      ], 'ffmpeg audio');
      return fs.existsSync(outPath) && fs.statSync(outPath).size > 0 ? fs.readFileSync(outPath) : null;
    } catch {
      return null;
    } finally {
      try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch { /* ignore */ }
    }
  }

  cleanup(jobId: string): void {
    this.abort(jobId);
    this.stopped.delete(jobId);
    const info = this.jobs.get(jobId);
    this.jobs.delete(jobId);
    this.refreshes.delete(jobId);
    this.fullDownloads.delete(jobId);
    const dir = info?.dir ?? path.join(TEMP_ROOT, jobId);
    setTimeout(() => {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }, 2_000);
  }

  /** Deletes the work folder of every job not in `keep` (finished long ago, deleted, or unknown after a restart). */
  sweep(keep: Set<string>): void {
    let names: string[] = [];
    try { names = fs.readdirSync(TEMP_ROOT); } catch { return; }
    for (const name of names) {
      if (!keep.has(name) && !this.procs.has(name)) this.cleanup(name);
    }
  }

  // ── Link sources ───────────────────────────────────────────────────────────

  /** Metadata, then the audio track only (or the whole file when the site has no separate audio). */
  private async prepareLink(jobId: string, dir: string, pageUrl: string, onProgress?: (pct: number) => void): Promise<PreparedVideo> {
    console.log(`[Ingest] Reading ${pageUrl}…`);
    const info = await this.fetchInfo(jobId, dir, pageUrl);
    if (info.is_live || info.live_status === 'is_live' || info.live_status === 'is_upcoming') {
      throw new Error('This stream is still live — wait for it to end (or use LiveCut) before clipping it.');
    }

    console.log('[Ingest] Downloading the audio track…');
    const file = await this.ytdlp(jobId, [
      '--load-info-json', path.join(dir, INFO_FILE),
      // Audio only when the site has it separately; otherwise the smallest full file up to 1080p.
      '-f', `ba[ext=m4a]/ba/b[height<=${MAX_VIDEO_HEIGHT}]/b`,
      '-o', path.join(dir, 'audio.%(ext)s'),
    ], dir, 'audio.', onProgress);

    const probe = await this.probe(file);
    const totalDurationSec = probe.durationSec;
    const sourceKey = `${info.extractor_key || 'url'}:${info.id || pageUrl}|${totalDurationSec.toFixed(2)}`;
    if (probe.hasVideo) {
      // The site only offers combined files, so the "audio" download is the whole video — use it.
      return { dir, sourcePath: file, kind: 'video', totalDurationSec, sourceKey };
    }
    if (!this.pickVideoFormat(info)) throw new Error('The link has no video stream to cut clips from.');
    return { dir, sourcePath: file, kind: 'audio', pageUrl, totalDurationSec, sourceKey };
  }

  /** yt-dlp metadata (formats + stream URLs), saved as info.json for the audio download and for rendering. */
  private async fetchInfo(jobId: string, dir: string, pageUrl: string): Promise<any> {
    const out = await this.capture('yt-dlp', [
      '--no-update', '--no-warnings', '--no-playlist', '--socket-timeout', '30', '-J', pageUrl,
    ], METADATA_TIMEOUT_MS, jobId);
    let info: any;
    try { info = JSON.parse(out); } catch { throw new Error('yt-dlp returned unreadable metadata for this link.'); }
    if (info?._type === 'playlist') throw new Error('That link is a playlist — paste the link of a single video.');
    const tmp = path.join(dir, `${INFO_FILE}.tmp`);
    fs.writeFileSync(tmp, out);
    fs.renameSync(tmp, path.join(dir, INFO_FILE));
    return info;
  }

  private readInfo(dir: string): { data: any; fetchedAt: number } | null {
    const file = path.join(dir, INFO_FILE);
    try {
      return { data: JSON.parse(fs.readFileSync(file, 'utf8')), fetchedAt: fs.statSync(file).mtimeMs };
    } catch {
      return null;
    }
  }

  private refreshInfo(jobId: string, v: PreparedVideo): Promise<{ data: any; fetchedAt: number }> {
    const recent = this.refreshes.get(jobId);
    if (recent && Date.now() - recent.at < REFRESH_REUSE_MS) return recent.promise;
    console.log('[Ingest] Fetching fresh stream links…');
    const promise = this.fetchInfo(jobId, v.dir, v.pageUrl!).then((data) => ({ data, fetchedAt: Date.now() }));
    this.refreshes.set(jobId, { at: Date.now(), promise });
    promise.catch(() => this.refreshes.delete(jobId));
    return promise;
  }

  /**
   * Best picture-only (or combined) format ffmpeg can seek in: up to 1080p, H.264 preferred (the
   * cheapest to decode), direct https preferred over HLS.
   */
  private pickVideoFormat(info: any): any | null {
    const formats: any[] = Array.isArray(info?.formats) ? info.formats : info?.url ? [info] : [];
    const usable = formats.filter((f) =>
      f?.url && f.vcodec !== 'none' && STREAMABLE.has(String(f.protocol || 'https')) && !(Number(f.height) > MAX_VIDEO_HEIGHT),
    );
    const score = (f: any) =>
      (Number(f.height) || 0) * 10 + (/^(avc1|h264)/i.test(String(f.vcodec)) ? 5 : 0) + (String(f.protocol).startsWith('http') ? 2 : 0);
    return usable.sort((a, b) => score(b) - score(a) || (Number(b.tbr) || 0) - (Number(a.tbr) || 0))[0] ?? null;
  }

  /** Last resort when the stream can't be read: download the picture (video-only, up to 1080p) once. */
  private downloadFullVideo(jobId: string, v: PreparedVideo): Promise<string> {
    let p = this.fullDownloads.get(jobId);
    if (!p) {
      const h = MAX_VIDEO_HEIGHT;
      p = (async () => {
        await this.refreshInfo(jobId, v);
        console.log('[Ingest] Streaming failed — downloading the full video instead (slower).');
        return this.ytdlp(jobId, [
          '--load-info-json', path.join(v.dir, INFO_FILE),
          '-f', `bv*[height<=${h}][vcodec^=avc1]/bv*[height<=${h}]/b[height<=${h}]/bv*/b`,
          '-o', path.join(v.dir, 'video.%(ext)s'),
        ], v.dir, 'video.');
      })();
      this.fullDownloads.set(jobId, p);
      p.catch(() => this.fullDownloads.delete(jobId));
    }
    return p;
  }

  /** The full video, if a fallback download of it finished (marked by its .done file). */
  private fullVideoPath(dir: string): string | null {
    const name = fs.readdirSync(dir).find((n) => n.startsWith('video.') && !/\.(part|ytdl|tmp|done)$/.test(n));
    return name && fs.existsSync(path.join(dir, `${name}.done`)) ? path.join(dir, name) : null;
  }

  private track(jobId: string, proc: ChildProcess) {
    let set = this.procs.get(jobId);
    if (!set) this.procs.set(jobId, (set = new Set()));
    set.add(proc);
  }

  private untrack(jobId: string, proc: ChildProcess) {
    const set = this.procs.get(jobId);
    set?.delete(proc);
    if (set && set.size === 0) this.procs.delete(jobId);
  }

  /**
   * Runs a yt-dlp download into `dir` and returns the file it wrote (the one whose name starts
   * with `prefix`). Progress 0–100 is reported when the download has a known size.
   */
  private ytdlp(jobId: string, args: string[], dir: string, prefix: string, onProgress?: (pct: number) => void): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn('yt-dlp', [
        '--no-update', '--no-part', '--quiet', '--no-warnings',
        // Progress lines only (still quiet otherwise), one per line so they can be parsed.
        '--progress', '--newline',
        '--no-playlist',
        '--socket-timeout', '30',
        '--retries', '10',
        '--fragment-retries', '10',
        '--concurrent-fragments', '8',
        ...args,
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      this.track(jobId, proc);

      proc.stdout.on('data', (d) => {
        for (const m of d.toString().matchAll(/\[download\]\s+(\d+(?:\.\d+)?)%/g)) onProgress?.(Math.min(100, Number(m[1])));
      });
      let stderr = '';
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      proc.on('error', (e) => {
        this.untrack(jobId, proc);
        reject(new Error(`yt-dlp could not start (${e.message}) — is it installed and on PATH?`));
      });
      proc.on('exit', (code, signal) => {
        this.untrack(jobId, proc);
        if (this.stopped.has(jobId) || signal) return reject(new Error('Download cancelled.'));
        const name = fs.readdirSync(dir).find((n) => n.startsWith(prefix) && !/\.(part|ytdl|tmp|done)$/.test(n));
        if (code !== 0 || !name) return reject(new Error(`yt-dlp exited ${code}: ${stderr.trim().slice(-400)}`));
        try { fs.writeFileSync(path.join(dir, `${name}.done`), ''); } catch { /* only affects reuse */ }
        resolve(path.join(dir, name));
      });
    });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private prepared(jobId: string): PreparedVideo {
    const info = this.jobs.get(jobId);
    if (!info) throw new Error(`No prepared video for job ${jobId}`);
    return info;
  }

  private readMarker(dir: string): PreparedVideo | null {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(dir, MARKER_FILE), 'utf8'));
      const sourcePath = path.join(dir, path.basename(String(m.file)));
      if (!(m.totalDurationSec > 1) || !m.sourceKey || !fs.existsSync(sourcePath)) return null;
      const kind = m.kind === 'audio' && m.pageUrl ? 'audio' : 'video';
      return { dir, sourcePath, kind, pageUrl: m.pageUrl, totalDurationSec: Number(m.totalDurationSec), sourceKey: String(m.sourceKey) };
    } catch {
      return null;
    }
  }

  private writeMarker(v: PreparedVideo) {
    const marker = { file: path.basename(v.sourcePath), kind: v.kind, pageUrl: v.pageUrl, totalDurationSec: v.totalDurationSec, sourceKey: v.sourceKey };
    try { fs.writeFileSync(path.join(v.dir, MARKER_FILE), JSON.stringify(marker)); } catch { /* source is just not reusable */ }
  }

  /** Removes everything a previous, unfinished attempt left behind (keeps nothing without a marker). */
  private clearSource(dir: string) {
    for (const name of fs.readdirSync(dir)) {
      if (/^(source|audio|video|info)\./.test(name)) {
        try { fs.rmSync(path.join(dir, name), { force: true }); } catch { /* ignore */ }
      }
    }
  }

  /** Size + hashes of both ends — identifies the same file uploaded twice without reading all of it. */
  private fingerprint(filePath: string): string {
    const { size } = fs.statSync(filePath);
    const hash = crypto.createHash('sha1').update(String(size));
    const len = Math.min(FINGERPRINT_BYTES, size);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(filePath, 'r');
    try {
      fs.readSync(fd, buf, 0, len, 0);
      hash.update(buf);
      fs.readSync(fd, buf, 0, len, Math.max(0, size - len));
      hash.update(buf);
    } finally {
      fs.closeSync(fd);
    }
    return `file:${hash.digest('hex')}`;
  }

  private isLocalPath(p: string): boolean {
    return /^\//.test(p) || /^[A-Za-z]:[/\\]/.test(p) || /^\\\\/.test(p);
  }

  /**
   * A hard link is instant and keeps the job's copy alive even if the original (e.g. an upload)
   * is deleted mid-job; it only fails across volumes, where a real copy is made instead.
   */
  private linkOrCopy(from: string, to: string) {
    try {
      fs.linkSync(from, to);
    } catch {
      fs.copyFileSync(from, to);
    }
  }

  private async probe(filePath: string): Promise<{ durationSec: number; hasVideo: boolean }> {
    const out = await this.capture('ffprobe', [
      '-v', 'error', '-show_entries', 'stream=codec_type,disposition:format=duration', '-of', 'json', filePath,
    ], 60_000);
    const info = JSON.parse(out || '{}');
    const streams: any[] = Array.isArray(info.streams) ? info.streams : [];
    // A music file's cover art is a "video" stream too — it is not a picture to cut from.
    const hasVideo = streams.some((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
    return { durationSec: Number(info.format?.duration) || 0, hasVideo };
  }

  private async probeDuration(filePath: string): Promise<number> {
    return (await this.probe(filePath)).durationSec;
  }

  /** Runs a tool and returns its stdout; kills it after `timeoutMs`. A `jobId` makes it abortable. */
  private capture(bin: string, args: string[], timeoutMs: number, jobId?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      if (jobId) this.track(jobId, proc);
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs);
      proc.stdout.on('data', (d) => { stdout += d.toString(); });
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      proc.on('error', (e) => {
        clearTimeout(timer);
        if (jobId) this.untrack(jobId, proc);
        reject(new Error(`${bin} could not start (${e.message}) — is it installed and on PATH?`));
      });
      proc.on('exit', (code, signal) => {
        clearTimeout(timer);
        if (jobId) this.untrack(jobId, proc);
        if (jobId && this.stopped.has(jobId)) return reject(new Error('Download cancelled.'));
        if (code === 0) return resolve(stdout);
        const tail = stderr.trim().split('\n').filter(Boolean).slice(-2).join(' ').slice(-400);
        reject(new Error(signal ? `${bin} timed out` : `${bin} failed: ${tail || `exit ${code}`}`));
      });
    });
  }

  private run(args: string[], label: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      proc.on('error', reject);
      proc.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`${label} failed (code ${code}): ${stderr.slice(-400)}`));
      });
    });
  }
}

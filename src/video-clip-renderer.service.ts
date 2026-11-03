import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import { ClipFraming } from './types';

/**
 * Renders the MP4 clips with plain `ffmpeg` / `ffprobe` on PATH (no extra dependencies):
 *  - renderClip()      frame-accurate cut, re-framed to the job's aspect ratio, H.264 + AAC, faststart
 *  - createThumbnail() aspect-correct JPEG poster frame
 *  - probe()           stream info (rotation-aware dimensions, audio presence, duration)
 *
 * Every clip is re-encoded: a stream copy can only start on a keyframe (clips began up to several
 * seconds early with a frozen first frame) and cannot change the aspect ratio.
 */

export interface VideoProbe {
  /** Display dimensions — already swapped for 90°/270° rotated phone footage. */
  width: number;
  height: number;
  hasVideo: boolean;
  hasAudio: boolean;
  durationSec: number;
}

export interface RenderClipOptions {
  aspectRatio: string;
  framing: ClipFraming;
}

/** What a clip is cut from: a local file or a remote stream, optionally with its sound from a separate file. */
export interface ClipSource {
  /** Local path or http(s) stream URL the picture is read from. */
  video: string;
  /** HTTP headers a remote `video` needs (yt-dlp's per-format http_headers). */
  headers?: Record<string, string>;
  /** Local audio file that replaces the video's own sound (same timeline). */
  audio?: string;
}

/**
 * The source could not be read (expired / refused stream link, network failure) — as opposed to a
 * render that failed on the content. The caller can retry with a fresh source.
 */
export class SourceUnavailableError extends Error {}

const isRemote = (p: string) => /^https?:\/\//i.test(p);
/** ffmpeg stderr of a failed read, as opposed to a failed encode. */
const INPUT_ERROR = /Server returned|HTTP error|\b40[134]\b|\b410\b|\b5\d\d (Internal|Bad|Service)|Connection (refused|reset|timed out)|timed out|Error opening input|I\/O error|Input\/output error|End of file|Invalid data found when processing input|could not resolve|Failed to resolve/i;
/** Probes of remote streams, cached so each clip doesn't pay a round trip for the same answer. */
const PROBE_CACHE_MAX = 32;
/** Signed stream URLs are kilobytes of query string — keep them out of logs. */
const scrubUrls = (msg: string) => msg.replace(/https?:\/\/\S+|\S*[?&][\w%.-]+=\S*/g, '<stream url>');

export interface RenderedClip {
  path: string;
  width: number;
  height: number;
  durationSec: number;
  sizeBytes: number;
}

/** Per-process FFmpeg thread count — same heuristic as the backend renderer. */
const FFMPEG_THREADS = (() => {
  const override = Number(process.env.FFMPEG_THREADS);
  if (Number.isFinite(override) && override > 0) return Math.floor(override);
  const cores = os.cpus()?.length || 2;
  if (cores >= 8) return 0;
  return Math.max(1, Math.floor(cores / 2));
})();

const X264_PRESET = process.env.CLIP_X264_PRESET || 'veryfast';
const X264_CRF = String(Number(process.env.CLIP_X264_CRF) || 21);
/** Short audio fades so a cut never starts or ends on a click. */
const AUDIO_FADE_IN_SEC = 0.2;
const AUDIO_FADE_OUT_SEC = 0.35;
/** Sources whose short side is at least this get 1080p output; everything else 720p. */
const HD_SHORT_SIDE = 1000;

function runTool(bin: 'ffmpeg' | 'ffprobe', args: string[], label: string, timeoutMs = 0): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = timeoutMs > 0
      ? setTimeout(() => { timedOut = true; try { proc.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs)
      : null;
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (e) => {
      if (timer) clearTimeout(timer);
      reject(new Error(`${label} failed: ${e.message}`));
    });
    proc.on('exit', (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else if (timedOut) reject(new Error(`${label} failed: timed out after ${Math.round(timeoutMs / 1000)}s`));
      else reject(new Error(`${label} failed (code ${code}): ${stderr.trim().slice(-400)}`));
    });
  });
}

/** Input options for reading `p`: network timeouts / reconnects and headers for a remote stream. */
function inputArgs(p: string, headers?: Record<string, string>): string[] {
  if (!isRemote(p)) return [];
  const h = Object.entries(headers ?? {}).map(([k, v]) => `${k}: ${v}\r\n`).join('');
  return [
    ...(h ? ['-headers', h] : []),
    // Give up on a stalled connection after 30s instead of hanging the render forever.
    '-rw_timeout', '30000000',
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
  ];
}

function safeUnlink(...files: (string | null | undefined)[]) {
  for (const f of files) {
    if (!f) continue;
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch { /* ignore */ }
  }
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

export class VideoClipRendererService {
  private readonly probeCache = new Map<string, VideoProbe>();

  async probe(videoPath: string, headers?: Record<string, string>): Promise<VideoProbe> {
    const out = await runTool('ffprobe', [
      '-v', 'error',
      ...inputArgs(videoPath, headers),
      '-show_entries', 'stream=codec_type,width,height:stream_tags=rotate:stream_side_data=rotation:format=duration',
      '-of', 'json',
      videoPath,
    ], 'ffprobe', isRemote(videoPath) ? 60_000 : 0);
    const info = JSON.parse(out || '{}');
    const streams: any[] = Array.isArray(info.streams) ? info.streams : [];
    const video = streams.find((s) => s.codec_type === 'video');
    let width = Number(video?.width) || 0;
    let height = Number(video?.height) || 0;
    const rotation = Math.abs(
      Number(video?.tags?.rotate) ||
      Number((video?.side_data_list || []).find((d: any) => d.rotation !== undefined)?.rotation) ||
      0,
    ) % 180;
    if (rotation === 90) [width, height] = [height, width];
    return {
      width,
      height,
      hasVideo: !!video && width > 0 && height > 0,
      hasAudio: streams.some((s) => s.codec_type === 'audio'),
      durationSec: Number(info.format?.duration) || 0,
    };
  }

  /** Throws if the file has no video stream (e.g. audio-only). */
  async assertVideoFileHasVideoTrack(videoPath: string): Promise<void> {
    const p = await this.probe(videoPath);
    if (!p.hasVideo) throw new Error('Video file has no video track (audio-only).');
  }

  /** Output frame for an aspect ratio: 1080p tier for HD sources, 720p otherwise. */
  outputSize(aspectRatio: string, source: VideoProbe): { width: number; height: number } {
    const tier = Math.min(source.width, source.height) >= HD_SHORT_SIDE ? 1080 : 720;
    switch ((aspectRatio || '16:9').trim()) {
      case '9:16': return { width: tier, height: even((tier * 16) / 9) };
      case '1:1': return { width: tier, height: tier };
      default: return { width: even((tier * 16) / 9), height: tier };
    }
  }

  /**
   * Cuts [start, start+duration) of the source to an H.264/AAC mp4 at outputPath, re-framed to the
   * aspect ratio. A remote source is range-read: only the clip's own few seconds are fetched.
   * Strategy ladder: full render → without audio fades → plain scale (keeps the source shape) —
   * each step only runs when the previous one failed on the content. A source that can't be read
   * throws SourceUnavailableError at once (another graph would fail the same way).
   */
  async renderClip(src: string | ClipSource, start: number, duration: number, outputPath: string, opts: RenderClipOptions): Promise<RenderedClip> {
    if (!(duration > 0)) throw new Error('Invalid clip duration');
    const { video, headers, audio } = typeof src === 'string' ? { video: src } as ClipSource : src;
    const remote = isRemote(video);

    let source = remote ? this.probeCache.get(video) : undefined;
    if (!source) {
      try {
        source = await this.probe(video, headers);
      } catch (e: any) {
        if (remote) throw new SourceUnavailableError(`Could not read the video stream: ${scrubUrls(String(e?.message ?? e))}`);
        throw e;
      }
      if (remote && source.hasVideo) {
        if (this.probeCache.size >= PROBE_CACHE_MAX) this.probeCache.delete(this.probeCache.keys().next().value!);
        this.probeCache.set(video, source);
      }
    }
    if (!source.hasVideo) throw new Error('Source has no video track');
    const hasAudio = !!audio || source.hasAudio;
    const audioMap = audio ? '1:a:0' : '0:a:0';

    const { width, height } = this.outputSize(opts.aspectRatio, source);
    const sameShape = Math.abs(source.width / source.height - width / height) < 0.01;
    const framed = opts.framing === 'blur' && !sameShape
      ? `[0:v:0]split=2[bg][fg];` +
        `[bg]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},boxblur=20:2,eq=brightness=-0.06[bgb];` +
        `[fg]scale=${width}:${height}:force_original_aspect_ratio=decrease[fgs];` +
        `[bgb][fgs]overlay=(W-w)/2:(H-h)/2,setsar=1,format=yuv420p[v]`
      : `[0:v:0]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,format=yuv420p[v]`;
    const plain = `[0:v:0]scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1,format=yuv420p[v]`;
    const fades = `afade=t=in:st=0:d=${AUDIO_FADE_IN_SEC},afade=t=out:st=${Math.max(0, duration - AUDIO_FADE_OUT_SEC).toFixed(3)}:d=${AUDIO_FADE_OUT_SEC}`;

    const args = (graph: string, withFades: boolean) => [
      '-hide_banner', '-loglevel', 'error',
      // Input seek + re-encode is frame-accurate and fast (ffmpeg decodes only from the nearest
      // keyframe — for a remote stream it also fetches only from there).
      ...inputArgs(video, headers), '-ss', start.toFixed(3), '-i', video,
      ...(audio ? ['-ss', start.toFixed(3), '-i', audio] : []),
      '-t', duration.toFixed(3),
      '-threads', String(FFMPEG_THREADS),
      '-filter_complex', graph, '-map', '[v]',
      // First audio track only; subtitle / data / extra tracks routinely break the mp4 mux.
      ...(hasAudio
        ? ['-map', audioMap, ...(withFades ? ['-af', fades] : []), '-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-ar', '48000']
        : ['-an']),
      '-c:v', 'libx264', '-preset', X264_PRESET, '-crf', X264_CRF, '-profile:v', 'high', '-pix_fmt', 'yuv420p',
      '-sn', '-dn', '-map_metadata', '-1', '-movflags', '+faststart',
      '-y', outputPath,
    ];

    const attempts: [string, string, boolean][] = [
      ['primary', framed, true],
      ['no-fades', framed, false],
      ['plain', plain, false],
    ];
    // A remote read that stalls past rw_timeout fails on its own; this caps a slow trickle.
    const timeoutMs = remote ? 120_000 + duration * 4_000 : 0;
    let lastErr: unknown = null;
    for (const [label, graph, withFades] of attempts) {
      try {
        await runTool('ffmpeg', args(graph, withFades), `render ${label}`, timeoutMs);
        const result = await this.probe(outputPath);
        if (result.hasVideo && result.durationSec > 0.5) {
          return {
            path: outputPath,
            width: result.width,
            height: result.height,
            durationSec: result.durationSec,
            sizeBytes: fs.statSync(outputPath).size,
          };
        }
        lastErr = new Error('rendered file is empty');
      } catch (e) {
        const msg = scrubUrls((e as Error).message);
        lastErr = new Error(msg);
        console.log(`[Render] ${label} attempt failed: ${msg}`);
        if (remote && INPUT_ERROR.test(msg)) {
          safeUnlink(outputPath);
          this.probeCache.delete(video);
          throw new SourceUnavailableError(`Could not read the video stream: ${msg}`);
        }
      }
      safeUnlink(outputPath);
    }
    throw new Error(`Failed to render clip: ${(lastErr as Error)?.message ?? 'unknown'}`);
  }

  /** JPEG poster frame at `time` seconds, `width` px wide, source aspect preserved. Falls back to the first frame. */
  async createThumbnail(videoPath: string, time: number, outputPath: string, width = 480): Promise<string> {
    for (const at of time > 0 ? [time, 0] : [0]) {
      try {
        await runTool('ffmpeg', [
          '-hide_banner', '-loglevel', 'error',
          '-ss', at.toFixed(3), '-i', videoPath, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '3', '-y', outputPath,
        ], 'thumbnail');
        if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) return outputPath;
      } catch { /* try the next position */ }
    }
    safeUnlink(outputPath);
    throw new Error('thumbnail failed');
  }
}

import * as fs from 'fs';
import * as path from 'path';
import { ClipJobPhase, ClipJobState, ClipMoment, ClipOutput, EnergyPeak, TranscriptItem, TranscriptResult } from './types';
import { VideoIngestService } from './video-ingest.service';
import { ScoreOutcome, VideoScorerService } from './video-scorer.service';
import { VideoAudioEnergyService } from './video-audio-energy.service';
import { RenderedClip, SourceUnavailableError, VideoClipRendererService } from './video-clip-renderer.service';
import { ChunkCache, ChunkData } from './chunk-cache';

/** Same unit price as LiveCut — charged per emitted clip. */
export const CREDITS_PER_UNIT = 20;

export type PublishKind = 'clip' | 'thumb';

export interface VideoProcessHooks {
  transcribeAudio: (audioBuffer: Buffer) => Promise<TranscriptResult | null>;
  /** Pre-render balance check (LiveCut's getCredits guard). Optional — omitted means "always affordable". */
  canAfford?: (orgId: string, amount: number) => Promise<boolean>;
  /** Charge after a successful render (LiveCut's reserveCredits). false = out of credits, job stops. */
  chargeCredits: (orgId: string, amount: number) => Promise<boolean>;
  /**
   * Persist a rendered local file and return the path/URL stored on the output row (LiveCut uploads
   * to S3 here). Default: keep the local path. Called BEFORE the charge, so a failing upload never
   * leaves a charged-but-unsaved unit; if the charge is then refused, only the local files are removed.
   */
  publishFile?: (localPath: string, kind: PublishKind, job: ClipJobState) => Promise<string>;
  onOutput: (output: ClipOutput) => void;
  /** Directory rendered files are written to before publishFile. Default temp/clips-out/<jobId>. */
  outputDir: string;
  /** Reuses transcripts of chunks an earlier run over the same video already transcribed. */
  chunkCache?: ChunkCache | null;
}

interface ChunkRange {
  start: number;
  end: number;
}

/** A moment that could become a clip, in ABSOLUTE video seconds. */
interface Candidate {
  win: ClipMoment;
  /** The matched beat — setup through payoff. */
  absStart: number;
  absEnd: number;
  /** The line that made it a match — always inside the cut. */
  peakStart: number;
  peakEnd: number;
  /** What actually gets cut: clipOutputSec of footage placed around the beat. */
  outStart: number;
  outEnd: number;
  rank: number;
  /** Not a real prompt match — only cut to reach the requested count. */
  bestAvailable: boolean;
}

type EmitResult = 'emitted' | 'skipped' | 'no_credits' | 'stopped';

interface ScanState {
  chunkCount: number;
  /** Whole-video transcript in ABSOLUTE seconds (finite video — nothing is aged out). */
  transcriptLog: TranscriptItem[];
  /** Whole-video energy peaks in ABSOLUTE seconds. */
  peakLog: EnergyPeak[];
  /** Every prompt match found while scanning, deduped by anchor and overlap (better rank wins). */
  candidates: Candidate[];
  scoredWindows: number;
  scorerUnavailable: number;
  transcribeFailedChunks: number;
  noSpeechChunks: number;
  /** Chunks whose transcript came from the chunk cache. */
  cachedChunks: number;
}

const OUT_OF_CREDITS_MESSAGE = 'Out of credits — top up to keep Video Clip running.';

/** Clips rendered at the same time. ffmpeg already uses several threads, so keep this small. */
const RENDER_CONCURRENCY = Math.max(1, Math.min(4, Math.floor(Number(process.env.CLIP_RENDER_CONCURRENCY) || 2)));
/** Chunks transcribed at the same time (network-bound; AssemblyAI queues anything over its account limit). */
const SCAN_CONCURRENCY = Math.max(1, Math.min(16, Math.floor(Number(process.env.CLIP_SCAN_CONCURRENCY) || 6)));
/** Chunks scored by Gemini at the same time. Lower it on a free-tier key that keeps hitting rate limits. */
const SCORE_CONCURRENCY = Math.max(1, Math.min(16, Math.floor(Number(process.env.CLIP_SCORE_CONCURRENCY) || 4)));

/** Runs at most `n` of the returned function's tasks at once, starting them in call order. */
function limiter(n: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= n) await new Promise<void>((r) => waiting.push(r));
    active++;
    try {
      return await task();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

/**
 * Produces the clips the user asked for from a pre-recorded video:
 *
 *   1. SCAN — the whole video, chunk by chunk (chunkLengthSec). Each chunk is transcribed once and
 *      scored by Gemini with LiveCut's selection prompt (theme guidance, verbatim source_words
 *      anchoring, energy hints). A moment is a whole beat — setup through payoff, up to the clip
 *      length — with its peak line tracked separately. Each scan window overlaps the previous chunk
 *      so a moment on a chunk boundary is seen whole. Every match ≥ MATCH_FLOOR is a candidate.
 *      Chunks are transcribed SCAN_CONCURRENCY at a time (cached on disk) and scored
 *      SCORE_CONCURRENCY at a time — a chunk is scored as soon as it and the chunk before it are
 *      transcribed. Failed chunks are retried after a pause, and short Gemini outages waited out.
 *   2. SELECT — rank all candidates across the WHOLE video (theme score + LiveCut's energy bonus)
 *      and take the best `clipBudget`, spaced at least MIN_GAP_SEC apart. Loud-only candidates must
 *      pass confirmEnergyMoment. If fewer real matches exist than requested and fillToTarget is on,
 *      the remainder is filled with the closest available moments (findBestMoments), then with
 *      audio-energy peaks / evenly spaced moments — all flagged bestAvailable.
 *   3. CUT — best first, RENDER_CONCURRENCY at a time. Each clip is placed with more lead-in than
 *      tail (viewers need the setup), its cut points are snapped to pauses / sentence ends in the
 *      transcript, and it is re-encoded frame-accurately in the requested aspect ratio. Credits are
 *      charged only after a clip is rendered and published; a failed render is replaced by the
 *      next-best candidate.
 *
 * LiveCut emits as it goes because a live stream never ends, which is why it needs a hold pool and
 * an adaptive threshold. A finite video can simply be ranked as a whole.
 *
 * A job that already has outputs (resumed after a restart, or retried) keeps them: they count
 * toward clipBudget and new picks stay clear of them.
 */
export class VideoProcessService {
  private readonly renderer = new VideoClipRendererService();
  private readonly states = new Map<string, ScanState>();
  /** Jobs already told their stream failed and the full video is being downloaded — said once, not per clip. */
  private readonly fallbackLogged = new Set<string>();

  /** Lowest theme score kept as a real match — LiveCut's relaxation floor. */
  private static readonly MATCH_FLOOR = 0.6;
  /** "Strong matches only" mode cutoff — LiveCut's base match threshold. */
  private static readonly STRONG_MATCH = 0.75;
  private static readonly MIN_GAP_SEC = 20;
  /** Gap allowed between two real matches when the normal gap would leave a slot to filler. */
  private static readonly TIGHT_GAP_SEC = 3;
  private static readonly MIN_SCAN_OVERLAP_SEC = 30;
  /** Pauses before re-trying a chunk whose audio / transcription failed (then it is skipped). */
  private static readonly CHUNK_RETRY_DELAYS_MS = [5_000, 20_000];
  /** Pauses before re-scoring a chunk Gemini could not score. */
  private static readonly SCORE_RETRY_DELAYS_MS = [15_000, 45_000];
  /** A Gemini outage longer than this (e.g. a used-up daily quota) is not waited out — the chunk is skipped. */
  private static readonly MAX_SCORE_WAIT_MS = 2 * 60_000;
  private static readonly MIN_FLUSH_SEC = 15;
  /** Longest beat the scorer may return, whatever the clip length. */
  private static readonly MAX_MOMENT_SEC = 60;
  /** Share of a clip's spare time placed BEFORE the beat (the rest goes after it). */
  private static readonly LEAD_SHARE = 0.65;
  /** Footage always kept after the peak line, for the reaction. */
  private static readonly PEAK_TAIL_SEC = 1.5;
  /** Furthest a cut point may move to land on a pause (also capped at 15% of the clip). */
  private static readonly SNAP_MAX_SEC = 4;
  /** A gap between words at least this long counts as a pause worth cutting in. */
  private static readonly MIN_PAUSE_SEC = 0.35;
  /** Transcript span handed to one best-available call. */
  private static readonly FILL_WINDOW_SEC = 15 * 60;

  constructor(
    private readonly ingest: VideoIngestService,
    private readonly scorer: VideoScorerService,
    private readonly audioEnergy: VideoAudioEnergyService,
    private readonly hooks: Omit<VideoProcessHooks, 'outputDir'> & { outputDir?: string },
  ) {}

  async run(job: ClipJobState): Promise<void> {
    const s: ScanState = {
      chunkCount: 0,
      transcriptLog: [],
      peakLog: [],
      candidates: [],
      scoredWindows: 0,
      scorerUnavailable: 0,
      transcribeFailedChunks: 0,
      noSpeechChunks: 0,
      cachedChunks: 0,
    };
    this.states.set(job.jobId, s);
    job.threshold = job.fillToTarget ? VideoProcessService.MATCH_FLOOR : VideoProcessService.STRONG_MATCH;

    try {
      // ── 1. Scan ───────────────────────────────────────────────────────────────
      this.setPhase(job, 'extracting');
      // A link scanned from its audio track was already checked for a video stream by the ingest.
      if (!this.ingest.isAudioOnly(job.jobId)) {
        try {
          await this.renderer.assertVideoFileHasVideoTrack(this.ingest.getSourcePath(job.jobId));
        } catch (e: any) {
          job.status = 'failed';
          job.errorMessage = e?.message ?? String(e);
          this.logEvent(job, 'error', job.errorMessage!, 1);
          return;
        }
      }

      const chunks = this.planChunks(job);
      s.chunkCount = chunks.length;
      job.transcribedChunks = 0;
      job.scannedChunks = 0;
      job.currentChunkIndex = 0;
      this.setPhase(job, 'transcribing');

      // Transcription: SCAN_CONCURRENCY at a time, in timeline order. A finished chunk's words go
      // straight into the whole-video log, so any later scoring window can read them.
      const transcribe = limiter(SCAN_CONCURRENCY);
      const fetches = chunks.map((c, i) => transcribe(async () => {
        const data = this.isActive(job) ? await this.fetchChunk(job, s, c, i + 1) : null;
        if (data) this.addChunkData(s, c, data);
        else if (this.isActive(job)) {
          s.transcribeFailedChunks += 1;
          this.logEvent(job, 'error', `Chunk #${i + 1} could not be transcribed after ${VideoProcessService.CHUNK_RETRY_DELAYS_MS.length + 1} attempts — skipped.`, i + 1);
        }
        job.transcribedChunks = (job.transcribedChunks ?? 0) + 1;
        return data;
      }));

      // Scoring: SCORE_CONCURRENCY workers take chunks in timeline order. A window reaches back into
      // the previous chunk, so it waits for that chunk's transcript as well as its own.
      let next = 0;
      const scoreWorker = async () => {
        while (this.isActive(job) && next < chunks.length) {
          const i = next++;
          const [, data] = await Promise.all([i > 0 ? fetches[i - 1] : null, fetches[i]]);
          if (!this.isActive(job)) return;
          if (data) {
            if (job.phase === 'transcribing') this.setPhase(job, 'scoring');
            await this.scoreChunk(job, s, chunks[i], i + 1, data);
          }
          job.scannedChunks = (job.scannedChunks ?? 0) + 1;
          job.currentChunkIndex = Math.max(0, job.scannedChunks - 1);
        }
      };
      await Promise.all(Array.from({ length: Math.min(SCORE_CONCURRENCY, chunks.length) }, scoreWorker));
      if (!this.isActive(job)) return;
      // Candidates arrive out of order from parallel windows — keep the log in timeline order.
      s.candidates.sort((a, b) => a.peakStart - b.peakStart);

      const strongCount = s.candidates.filter((c) => c.win.score >= VideoProcessService.STRONG_MATCH).length;
      const cached = s.cachedChunks ? `, ${s.cachedChunks} transcript${s.cachedChunks === 1 ? '' : 's'} reused` : '';
      this.info(job, s, `Scanned the whole video (${s.chunkCount} chunk${s.chunkCount === 1 ? '' : 's'}${cached}) — ${s.candidates.length} candidate moment(s), ${strongCount} strong (≥ ${VideoProcessService.STRONG_MATCH}).`);

      // ── 2. Select ─────────────────────────────────────────────────────────────
      this.setPhase(job, 'selecting');
      const prior = this.priorCuts(job);
      const plan = this.capacity(job);
      if (plan.count < job.clipBudget) {
        this.info(job, s, `The video is only ${Math.round(job.totalDurationSec)}s long — it can hold at most ${plan.count} non-overlapping ${job.clipOutputSec}s clips, so ${plan.count} will be cut instead of ${job.clipBudget}.`);
      }
      const { picked, reserve } = await this.select(job, s, plan, prior);
      if (!this.isActive(job)) return;
      const fills = picked.filter((c) => c.bestAvailable).length;
      if (picked.length > 0) {
        // The total (not just this run's picks) — the dashboard's render progress reads it.
        this.info(job, s, `Picked ${prior.length + picked.length} moment(s): ${picked.length - fills} matched the prompt${fills ? `, ${fills} best available (the video has no more real matches)` : ''}${prior.length ? `, ${prior.length} already cut earlier` : ''}.`);
      }

      // ── 3. Cut ────────────────────────────────────────────────────────────────
      await this.cutAll(job, s, picked, reserve, plan.gap, prior);
      if (!this.isActive(job)) return;
      this.report(job, s, plan.count);
    } finally {
      this.setPhase(job, 'idle');
    }
  }

  cleanup(jobId: string): void {
    this.states.delete(jobId);
    this.fallbackLogged.delete(jobId);
  }

  private isActive(job: ClipJobState): boolean {
    return job.status === 'processing' || job.status === 'downloading' || job.status === 'queued';
  }

  /** Longest beat the scorer may return for this job — never more than one clip. */
  private maxMomentSec(job: ClipJobState): number {
    return Math.max(3, Math.min(VideoProcessService.MAX_MOMENT_SEC, job.clipOutputSec));
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Scan
  // ─────────────────────────────────────────────────────────────────────────────

  /** Scan chunks in timeline order; a too-short final remainder is folded into the last chunk. */
  private planChunks(job: ClipJobState): ChunkRange[] {
    const total = job.totalDurationSec;
    const chunks: ChunkRange[] = [];
    for (let cursor = 0; cursor < total; ) {
      let end = Math.min(cursor + job.chunkLengthSec, total);
      if (total - end < VideoProcessService.MIN_FLUSH_SEC) end = total;
      chunks.push({ start: cursor, end });
      cursor = end;
    }
    return chunks;
  }

  private chunkTag(c: ChunkRange, chunkNo: number): string {
    return `[Process] [chunk #${chunkNo} ${Math.round(c.start)}s-${Math.round(c.end)}s]`;
  }

  /**
   * Transcript + loudness peaks of one chunk (chunk-relative) — from the chunk cache when an earlier
   * run already transcribed it, otherwise extracted and transcribed, with a pause before each retry.
   * Null = gave up. Never throws: it runs ahead of the scan, so a stopped job may never await it.
   */
  private async fetchChunk(job: ClipJobState, s: ScanState, c: ChunkRange, chunkNo: number): Promise<ChunkData | null> {
    const tag = this.chunkTag(c, chunkNo);
    try {
      const cache = this.hooks.chunkCache;
      const key = cache ? cache.key(this.ingest.getSourceKey(job.jobId), c.start, c.end) : '';
      const cached = cache?.get(key);
      if (cached) {
        s.cachedChunks += 1;
        console.log(`${tag} transcript reused from cache.`);
        return cached;
      }

      const delays = VideoProcessService.CHUNK_RETRY_DELAYS_MS;
      for (let attempt = 0; attempt <= delays.length; attempt++) {
        if (attempt > 0) {
          const wait = delays[attempt - 1];
          this.logEvent(job, 'error', `Chunk #${chunkNo} hit a problem — retrying in ${wait / 1000}s (attempt ${attempt + 1}/${delays.length + 1}).`, chunkNo);
          if (!(await this.pause(job, wait))) return null;
        }
        if (!this.isActive(job)) return null;
        try {
          const startedAt = Date.now();
          const audio = await this.ingest.extractAudio(job.jobId, c.start, c.end);
          // No decodable audio is not transient — treat as a successful empty transcript.
          const transcript = audio ? await this.hooks.transcribeAudio(audio) : { text: '', items: [] };
          if (!transcript) {
            console.log(`${tag} transcription failed.`);
            continue;
          }
          const peaks = await this.audioEnergy.analyzeChunk(this.ingest.getSourcePath(job.jobId), c.start, c.end - c.start);
          const data: ChunkData = { items: transcript.items ?? [], peaks };
          cache?.set(key, data);
          console.log(`${tag} transcribed: ${data.items.length} word(s), ${peaks.length} energy peak(s) in ${((Date.now() - startedAt) / 1000).toFixed(1)}s.`);
          return data;
        } catch (e: any) {
          console.error(`${tag} failed: ${e?.message ?? e}`);
        }
      }
      return null;
    } catch (e: any) {
      console.error(`${tag} failed: ${e?.message ?? e}`);
      return null;
    }
  }

  /** Adds one transcribed chunk (chunk-relative) to the whole-video logs (absolute seconds). */
  private addChunkData(s: ScanState, c: ChunkRange, data: ChunkData) {
    for (const w of data.items) {
      s.transcriptLog.push({ start_time: (w.start_time || 0) + c.start, end_time: (w.end_time || 0) + c.start, content: w.content });
    }
    s.transcriptLog.sort((a, b) => a.start_time - b.start_time);
    s.peakLog.push(...data.peaks.map((p) => ({ ...p, atSec: p.atSec + c.start, startSec: p.startSec + c.start, endSec: p.endSec + c.start })));
  }

  /** Scores one chunk's window (the chunk plus the tail of the previous one) — both already in the logs. */
  private async scoreChunk(job: ClipJobState, s: ScanState, c: ChunkRange, chunkNo: number, data: ChunkData): Promise<void> {
    const tag = this.chunkTag(c, chunkNo);
    const startedAt = Date.now();

    if (data.items.length === 0) {
      s.noSpeechChunks += 1;
      console.log(`${tag} no speech detected.`);
      this.logEvent(job, 'skip', `Chunk #${chunkNo} — no speech detected.`, chunkNo);
      return;
    }

    // Score this chunk plus a little of the previous one, so a boundary moment is seen whole.
    const overlap = Math.max(VideoProcessService.MIN_SCAN_OVERLAP_SEC, this.maxMomentSec(job));
    const from = Math.max(0, c.start - overlap);
    const win = this.windowAt(s, from, c.end);
    const ask = Math.min(15, Math.max(5, job.clipBudget * 2));
    const delays = VideoProcessService.SCORE_RETRY_DELAYS_MS;
    let moments: ClipMoment[] = [];
    let outcome: ScoreOutcome = {};
    for (let attempt = 0; ; attempt++) {
      outcome = {};
      try {
        moments = await this.scorer.findChunkMoments(
          win.transcript, job.prompt, job.negativePrompt, ask, c.end - from, VideoProcessService.MATCH_FLOOR, win.peaks, outcome, this.maxMomentSec(job),
        );
      } catch (e: any) {
        console.error(`${tag} scoring failed: ${e?.message ?? e}`);
        moments = [];
        outcome.status = 'unavailable';
      }
      if (outcome.status !== 'unavailable' || attempt >= delays.length || !this.isActive(job)) break;
      // Overload and per-minute limits pass quickly; a used-up daily quota does not — don't stall on it.
      const wait = Math.max(delays[attempt], this.scorer.msUntilAvailable());
      if (wait > VideoProcessService.MAX_SCORE_WAIT_MS) break;
      this.logEvent(job, 'error', `Chunk #${chunkNo} — Gemini unavailable, retrying in ${Math.round(wait / 1000)}s.`, chunkNo);
      if (!(await this.pause(job, wait))) return;
    }
    if (!this.isActive(job)) return;
    this.countOutcome(s, outcome);

    let added = 0;
    for (const m of moments) {
      if (this.addCandidate(s, this.toCandidate(job, m, from, false))) added++;
    }
    const best = moments.length ? Math.max(...moments.map((m) => m.score)) : 0;
    if (outcome.status === 'unavailable') {
      this.logEvent(job, 'error', `Chunk #${chunkNo} — Gemini scoring unavailable for this chunk.`, chunkNo);
    } else if (moments.length === 0) {
      this.logEvent(job, 'skip', `Chunk #${chunkNo} scanned — no moment matched the prompt.`, chunkNo);
    } else {
      this.logEvent(job, 'match', `Chunk #${chunkNo} scanned — ${moments.length} candidate moment(s), best score ${best.toFixed(2)}.`, chunkNo);
    }
    console.log(`${tag} ${moments.length} candidate(s), ${added} new — scored in ${((Date.now() - startedAt) / 1000).toFixed(1)}s.`);
  }

  /** Waits up to `ms`, waking early if the job stops. Returns whether the job is still running. */
  private async pause(job: ClipJobState, ms: number): Promise<boolean> {
    const until = Date.now() + ms;
    while (this.isActive(job) && Date.now() < until) {
      await new Promise((r) => setTimeout(r, Math.min(1_000, until - Date.now())));
    }
    return this.isActive(job);
  }

  /** Clips an earlier run of this job already cut (before a restart / retry) — kept, and kept clear of. */
  private priorCuts(job: ClipJobState): Candidate[] {
    return job.outputs.map((o) => {
      const peak = o.peakSec ?? (o.startSec + o.endSec) / 2;
      const m: ClipMoment = {
        start: o.startSec, end: o.endSec, peakStart: peak, peakEnd: peak, score: o.matchScore,
        caption: o.caption ?? '', tags: o.tags ?? [], anchorKey: o.anchorKey ?? '', energy: 0, energyOnly: false,
      };
      return { win: m, absStart: o.startSec, absEnd: o.endSec, peakStart: peak, peakEnd: peak, outStart: o.startSec, outEnd: o.endSec, rank: 0, bestAvailable: o.bestAvailable };
    });
  }

  /** Transcript + peaks for [from, to) re-based to 0 (the scorer works in window-relative seconds). */
  private windowAt(s: ScanState, from: number, to: number): { transcript: TranscriptResult; peaks: EnergyPeak[] } {
    const items = s.transcriptLog
      .filter((w) => w.end_time > from && w.start_time < to)
      .map((w) => ({ start_time: Math.max(0, w.start_time - from), end_time: Math.max(0, w.end_time - from), content: w.content }));
    const peaks = s.peakLog
      .filter((p) => p.endSec > from && p.startSec < to)
      .map((p) => ({ ...p, atSec: p.atSec - from, startSec: p.startSec - from, endSec: p.endSec - from }));
    return { transcript: { text: items.map((i) => i.content).join(' '), items }, peaks };
  }

  private toCandidate(job: ClipJobState, m: ClipMoment, offsetSec: number, bestAvailable: boolean): Candidate {
    const absStart = offsetSec + m.start;
    const absEnd = offsetSec + m.end;
    const peakStart = offsetSec + m.peakStart;
    const peakEnd = offsetSec + m.peakEnd;
    const out = this.placeClip(absStart, absEnd, peakStart, peakEnd, job.totalDurationSec, job.clipOutputSec);
    return { win: m, absStart, absEnd, peakStart, peakEnd, outStart: out.start, outEnd: out.end, rank: this.scorer.rankOf(m), bestAvailable };
  }

  /** Adds a scan candidate unless the same moment is already known; on a duplicate the better rank wins. */
  private addCandidate(s: ScanState, c: Candidate): boolean {
    const dupIdx = s.candidates.findIndex(
      (o) => (c.win.anchorKey && o.win.anchorKey === c.win.anchorKey) || (c.peakStart < o.peakEnd && c.peakEnd > o.peakStart),
    );
    if (dupIdx === -1) {
      s.candidates.push(c);
      return true;
    }
    if (c.rank > s.candidates[dupIdx].rank) s.candidates[dupIdx] = c;
    return false;
  }

  private countOutcome(s: ScanState, outcome: ScoreOutcome) {
    if (outcome.status === 'scored') s.scoredWindows += 1;
    else if (outcome.status === 'unavailable') s.scorerUnavailable += 1;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Select
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * How many clips the video can physically hold and the spacing between them. Full MIN_GAP_SEC
   * when it fits; otherwise the gap shrinks; if even back-to-back clips don't fit, the count is capped.
   */
  private capacity(job: ClipJobState): { count: number; gap: number } {
    const total = job.totalDurationSec;
    const unit = Math.min(job.clipOutputSec, total);
    const n = job.clipBudget;
    if (n <= 1) return { count: 1, gap: VideoProcessService.MIN_GAP_SEC };
    if (n * unit + (n - 1) * VideoProcessService.MIN_GAP_SEC <= total) return { count: n, gap: VideoProcessService.MIN_GAP_SEC };
    if (n * unit <= total) return { count: n, gap: (total - n * unit) / (n - 1) };
    return { count: Math.max(1, Math.floor(total / unit)), gap: 0 };
  }

  private conflicts(c: Candidate, taken: Candidate[], gap: number): boolean {
    return taken.some(
      (t) => (c.win.anchorKey && t.win.anchorKey === c.win.anchorKey) || (c.outStart < t.outEnd + gap && c.outEnd > t.outStart - gap),
    );
  }

  /**
   * Picks the best candidates across the whole video to reach `plan.count` together with the
   * `prior` cuts. Returns the new picks plus a reserve of further non-picked candidates used to
   * replace a pick whose render fails.
   */
  private async select(
    job: ClipJobState,
    s: ScanState,
    plan: { count: number; gap: number },
    prior: Candidate[],
  ): Promise<{ picked: Candidate[]; reserve: Candidate[] }> {
    // Prior cuts take their slots up front: everything below counts and spaces against them.
    const picked: Candidate[] = [...prior];
    const pool = s.candidates
      .filter((c) => job.fillToTarget || c.win.score >= VideoProcessService.STRONG_MATCH)
      .sort((a, b) => b.rank - a.rank);
    const reserve: Candidate[] = [];
    const crowded: Candidate[] = [];
    const rejected = new Set<Candidate>();

    // A loud spike is not prompt evidence — it must prove itself before it can take a slot.
    const confirmed = async (c: Candidate) => {
      if (!c.win.energyOnly) return true;
      const caption = await this.scorer.confirmEnergyMoment(s.transcriptLog, c.peakStart, c.peakEnd, job.prompt, job.negativePrompt);
      if (!caption) rejected.add(c);
      else c.win.caption = caption;
      return !!caption;
    };

    for (const c of pool) {
      if (!this.isActive(job)) break;
      if (picked.length >= plan.count) {
        reserve.push(c);
        continue;
      }
      if (this.conflicts(c, picked, plan.gap)) {
        crowded.push(c);
        continue;
      }
      if (await confirmed(c)) picked.push(c);
    }

    // Real matches that only lost on spacing beat any best-available filler: retry them with a
    // small gap before falling back to weaker moments.
    const tightGap = Math.min(plan.gap, VideoProcessService.TIGHT_GAP_SEC);
    for (const c of crowded) {
      if (picked.length >= plan.count || !this.isActive(job)) break;
      if (rejected.has(c) || this.conflicts(c, picked, tightGap)) continue;
      if (await confirmed(c)) picked.push(c);
    }
    reserve.push(...crowded.filter((c) => !picked.includes(c) && !rejected.has(c)));

    if (picked.length < plan.count && job.fillToTarget && this.isActive(job) && this.canBlindFill(s)) {
      await this.fillFromTranscript(job, s, picked, reserve, plan);
    }
    if (picked.length < plan.count && job.fillToTarget && this.isActive(job) && this.canBlindFill(s)) {
      this.fillBlind(job, s, picked, plan);
    }
    if (picked.length < plan.count && job.fillToTarget && this.isActive(job) && this.canBlindFill(s)) {
      this.repack(job, s, picked, plan, prior);
    }
    reserve.sort((a, b) => b.rank - a.rank);
    return { picked: picked.filter((c) => !prior.includes(c)), reserve };
  }

  /** Asks Gemini for the closest available moments in each part of the video, then fills by score. */
  private async fillFromTranscript(job: ClipJobState, s: ScanState, picked: Candidate[], reserve: Candidate[], plan: { count: number; gap: number }) {
    if (s.transcriptLog.length === 0) return;
    const need = plan.count - picked.length;
    this.info(job, s, `Only ${picked.length} moment(s) matched the prompt — finding the ${need} closest available moment(s) to reach ${plan.count}.`);

    const logStart = s.transcriptLog[0].start_time;
    const logEnd = Math.max(job.totalDurationSec, s.transcriptLog[s.transcriptLog.length - 1].end_time);
    const windows: number[] = [];
    for (let from = logStart; from < logEnd; from += VideoProcessService.FILL_WINDOW_SEC) windows.push(from);
    // Independent windows — asked in parallel, like the scan.
    const ask = limiter(SCORE_CONCURRENCY);
    const found: Candidate[] = (await Promise.all(windows.map((from) => ask(async () => {
      if (!this.isActive(job)) return [];
      const to = Math.min(from + VideoProcessService.FILL_WINDOW_SEC, logEnd);
      const win = this.windowAt(s, from, to);
      if (win.transcript.items.length === 0) return [];
      const avoid = picked
        .filter((p) => p.outEnd > from && p.outStart < to)
        .map((p) => ({ start: Math.max(0, p.outStart - from), end: Math.min(to - from, p.outEnd - from) }));
      const outcome: ScoreOutcome = {};
      const moments = await this.scorer.findBestMoments(win.transcript, job.prompt, job.negativePrompt, need + 2, to - from, avoid, outcome, this.maxMomentSec(job));
      this.countOutcome(s, outcome);
      return moments.map((m) => this.toCandidate(job, m, from, true));
    })))).flat();
    if (!this.isActive(job)) return;

    found.sort((a, b) => b.rank - a.rank);
    for (const c of found) {
      if (picked.length >= plan.count) {
        reserve.push(c);
        continue;
      }
      if (this.conflicts(c, picked, plan.gap)) continue;
      picked.push(c);
    }
  }

  /**
   * Blind fill is only honest when the pipeline actually worked and the video simply lacks speech
   * (music, b-roll). If the scorer or transcription was down, random clips would hide a config error.
   */
  private canBlindFill(s: ScanState): boolean {
    const scorerDown = s.scoredWindows === 0 && s.scorerUnavailable > 0;
    const allTranscriptionFailed = s.chunkCount > 0 && s.transcribeFailedChunks === s.chunkCount;
    return !scorerDown && !allTranscriptionFailed;
  }

  /** A clip-length fill moment centred on `center`, flagged best available. */
  private fillCandidate(job: ClipJobState, center: number, rank: number, energy: number, key: string): Candidate {
    const total = job.totalDurationSec;
    const len = Math.min(job.clipOutputSec, total);
    const start = Math.max(0, Math.min(center - len / 2, total - len));
    const peakStart = Math.max(start, center - 1);
    const peakEnd = Math.min(start + len, center + 1);
    const m: ClipMoment = { start, end: start + len, peakStart, peakEnd, score: 0, caption: '', tags: [], anchorKey: key, energy, energyOnly: false };
    return { win: m, absStart: start, absEnd: start + len, peakStart, peakEnd, outStart: start, outEnd: start + len, rank, bestAvailable: true };
  }

  /** Last resort for reaching the requested count: loudest audio moments, then evenly spaced ones. */
  private fillBlind(job: ClipJobState, s: ScanState, picked: Candidate[], plan: { count: number; gap: number }) {
    const total = job.totalDurationSec;
    const before = picked.length;

    for (const p of [...s.peakLog].sort((a, b) => b.prominenceDb - a.prominenceDb)) {
      if (picked.length >= plan.count) break;
      const c = this.fillCandidate(job, p.atSec, p.relative * 0.25, p.relative, `energy@${Math.round(p.atSec)}`);
      if (!this.conflicts(c, picked, plan.gap)) picked.push(c);
    }
    // Evenly spaced slots, densifying until enough fit between what is already picked.
    for (let slots = plan.count; picked.length < plan.count && slots <= plan.count * 8; slots *= 2) {
      for (let i = 0; i < slots && picked.length < plan.count; i++) {
        const center = ((i + 0.5) * total) / slots;
        const c = this.fillCandidate(job, center, 0, 0, `spaced@${Math.round(center)}`);
        if (!this.conflicts(c, picked, plan.gap)) picked.push(c);
      }
    }
    if (picked.length > before) {
      this.info(job, s, `Not enough usable speech for ${plan.count} moments — added ${picked.length - before} from the loudest / evenly spaced parts of the video.`);
    }
  }

  /**
   * Tight timelines: capacity() promised `plan.count` clips, but picks cut wherever their moment
   * happened can leave gaps too small for one more clip (5 × 30s clips in a 150s video only fit
   * back-to-back). Re-lay the timeline left to right: each pick may slide anywhere its clip still
   * contains its beat, and a new clip is slotted in front of a pick whenever that pick can still
   * fit afterwards. Earliest-start greedy is optimal for equal-length windows with start ranges.
   * `prior` cuts are already rendered, so they stay exactly where they are.
   * Leaves `picked` untouched if the layout cannot be improved.
   */
  private repack(job: ClipJobState, s: ScanState, picked: Candidate[], plan: { count: number; gap: number }, prior: Candidate[]) {
    const total = job.totalDurationSec;
    const g = plan.gap;
    const eps = 1e-6;
    const fillLen = Math.min(job.clipOutputSec, total);
    const items = [...picked]
      .sort((a, b) => a.outStart - b.outStart)
      .map((c) => {
        const len = c.outEnd - c.outStart;
        if (prior.includes(c)) return { c, len, lo: c.outStart, hi: c.outStart };
        const hi = Math.max(0, Math.min(c.absStart, total - len));
        return { c, len, lo: Math.min(Math.max(0, c.absEnd - len), hi), hi };
      });

    let need = plan.count - picked.length;
    let x = 0;
    const placed: { c: Candidate; start: number; len: number }[] = [];
    const fills: number[] = [];
    for (const it of items) {
      while (need > 0 && x + fillLen + g <= it.hi + eps) {
        fills.push(x);
        x += fillLen + g;
        need--;
      }
      const start = Math.max(x, it.lo);
      if (start > it.hi + eps) return; // current layout already as tight as it gets
      placed.push({ c: it.c, start, len: it.len });
      x = start + it.len + g;
    }
    while (need > 0 && x + fillLen <= total + eps) {
      fills.push(x);
      x += fillLen + g;
      need--;
    }
    if (fills.length === 0) return;

    for (const p of placed) {
      p.c.outStart = p.start;
      p.c.outEnd = p.start + p.len;
    }
    for (const start of fills) picked.push(this.fillCandidate(job, start + fillLen / 2, 0, 0, `slot@${Math.round(start)}`));
    this.info(job, s, `Re-arranged the cuts to fit ${fills.length} more into the timeline (${picked.length}/${plan.count}).`);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Clip placement
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Where a clip of `clipSec` goes around a beat. Spare time is split LEAD_SHARE before / rest after
   * (context matters more than aftermath). A beat longer than the clip keeps the peak line plus
   * PEAK_TAIL_SEC and as much setup as fits. Slides (never shrinks) to stay inside [0, totalSec].
   */
  private placeClip(beatStart: number, beatEnd: number, peakStart: number, peakEnd: number, totalSec: number, clipSec: number): { start: number; end: number } {
    const len = Math.min(clipSec, totalSec);
    const beatLen = beatEnd - beatStart;
    let start: number;
    if (beatLen <= len) {
      start = beatStart - (len - beatLen) * VideoProcessService.LEAD_SHARE;
    } else {
      start = Math.max(beatStart, peakEnd + VideoProcessService.PEAK_TAIL_SEC - len);
      start = Math.min(start, Math.max(0, peakStart - 0.5));
    }
    start = Math.max(0, Math.min(start, totalSec - len));
    return { start, end: start + len };
  }

  /**
   * Moves each cut point (by at most SNAP_MAX_SEC / 15% of the clip) onto a pause between words,
   * preferring sentence ends and longer pauses, so a clip never starts or stops mid-word. Never
   * cuts into the peak line or past a neighbouring clip. A cut point already in silence, or with
   * no transcript nearby, stays put.
   */
  private snapToSpeech(job: ClipJobState, s: ScanState, c: Candidate, others: Candidate[]) {
    const words = s.transcriptLog;
    if (words.length === 0) return;
    const total = job.totalDurationSec;
    const len = c.outEnd - c.outStart;
    const reach = Math.min(VideoProcessService.SNAP_MAX_SEC, len * 0.15);
    const lo = Math.max(0, ...others.filter((o) => o.outStart < c.outStart).map((o) => o.outEnd));
    const hi = Math.min(total, ...others.filter((o) => o.outStart > c.outStart).map((o) => o.outStart));
    const sentenceEnd = (w: TranscriptItem) => /[.!?…]["'”’)\]]*$/.test((w.content || '').trim());
    const inWord = (t: number) => words.some((w) => w.start_time < t - 0.05 && w.end_time > t + 0.05);

    // Pauses near the clip: [i] = gap between words[i-1] and words[i].
    const pauses: { from: number; to: number; sentence: boolean }[] = [];
    for (let i = 0; i <= words.length; i++) {
      const prev = words[i - 1];
      const next = words[i];
      const from = prev ? prev.end_time : 0;
      const to = next ? next.start_time : total;
      if (to < c.outStart - reach - 1 || from > c.outEnd + reach + 1) continue;
      if (to - from < VideoProcessService.MIN_PAUSE_SEC) continue;
      pauses.push({ from, to, sentence: !prev || sentenceEnd(prev) });
    }

    // `inward` = which side of the target shortens the clip; moving that way costs a little more.
    const pick = (target: number, min: number, max: number, inward: 1 | -1, pointOf: (p: { from: number; to: number }) => number): number | null => {
      let best: { t: number; cost: number } | null = null;
      for (const p of pauses) {
        const t = pointOf(p);
        if (t < min || t > max || Math.abs(t - target) > reach) continue;
        const shift = (t - target) * inward > 0 ? 1.4 : 1;
        const cost = Math.abs(t - target) * shift + (p.sentence ? 0 : 1.5) - Math.min(p.to - p.from, 1.5) * 0.5;
        if (!best || cost < best.cost) best = { t, cost };
      }
      return best ? best.t : null;
    };

    // Start: just before the next word begins. End: shortly after the last word ends.
    if (inWord(c.outStart) || !this.isNearSentence(words, c.outStart)) {
      const t = pick(c.outStart, lo, Math.min(c.peakStart - 0.3, c.outEnd - 3), 1, (p) => Math.max(p.from, p.to - 0.25));
      if (t !== null) c.outStart = t;
    }
    if (inWord(c.outEnd) || !this.isNearSentence(words, c.outEnd)) {
      const t = pick(c.outEnd, Math.max(c.peakEnd + 0.5, c.outStart + 3), hi, -1, (p) => Math.min(p.to, p.from + 0.35));
      if (t !== null) c.outEnd = t;
    }
  }

  /** True when `t` sits in a pause that follows a sentence end. */
  private isNearSentence(words: TranscriptItem[], t: number): boolean {
    const prev = [...words].reverse().find((w) => w.end_time <= t);
    const next = words.find((w) => w.start_time >= t);
    if (!prev || !next) return true;
    return next.start_time - prev.end_time >= VideoProcessService.MIN_PAUSE_SEC && /[.!?…]["'”’)\]]*$/.test(prev.content.trim());
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Cut
  // ─────────────────────────────────────────────────────────────────────────────

  private async cutAll(job: ClipJobState, s: ScanState, picked: Candidate[], reserve: Candidate[], gap: number, prior: Candidate[]) {
    this.setPhase(job, 'rendering');
    // Real matches first, best first — so if credits run out, the best ones are what you keep.
    const queue = [...picked].sort((a, b) => Number(a.bestAvailable) - Number(b.bestAvailable) || b.rank - a.rank);
    const target = picked.length;
    const done: Candidate[] = [];
    const inFlight = new Set<Candidate>();
    let noCredits = false;
    let seq = job.clipsEmitted;

    // Each worker pulls the next pick; a failed render queues a replacement that the same worker
    // then picks up, so nothing is left behind when the other workers have already finished.
    const worker = async () => {
      while (!noCredits && this.isActive(job) && queue.length && done.length + inFlight.size < target) {
        const c = queue.shift()!;
        inFlight.add(c);
        const no = ++seq;
        this.snapToSpeech(job, s, c, [...prior, ...done, ...queue, ...inFlight].filter((o) => o !== c));
        const label = `[Process] [clip #${no} ${this.fmt(c.outStart)}-${this.fmt(c.outEnd)}]`;
        console.log(`${label} score=${c.win.score.toFixed(2)}${c.bestAvailable ? ' (best available)' : ''} title="${c.win.caption}" — rendering…`);

        let result: EmitResult;
        try {
          result = await this.renderAndStore(job, c, no);
        } catch (e: any) {
          console.error(`${label} failed: ${e?.message}`);
          result = 'skipped';
        }
        inFlight.delete(c);
        if (result === 'no_credits') {
          noCredits = true;
          return;
        }
        if (result === 'stopped') return;
        if (result === 'emitted') {
          done.push(c);
          this.logEvent(
            job,
            'match',
            `Clip ${job.clipsEmitted} cut at ${this.fmt(c.outStart)}–${this.fmt(c.outEnd)} ` +
              `(${c.bestAvailable ? 'best available' : `score ${c.win.score.toFixed(2)}`})${c.win.caption ? `: "${c.win.caption}"` : ''}`,
          );
          continue;
        }
        // Render failed — no charge. Replace it with the next-best candidate that still fits.
        this.logEvent(job, 'error', `A moment at ${this.fmt(c.outStart)} failed to render — no credit charged, trying the next best.`);
        const taken = [...prior, ...done, ...queue, ...inFlight];
        const idx = reserve.findIndex((r) => !this.conflicts(r, taken, gap));
        if (idx !== -1) queue.push(reserve.splice(idx, 1)[0]);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(RENDER_CONCURRENCY, target)) }, worker));

    if (noCredits && this.isActive(job)) this.outOfCredits(job);
    // Concurrent renders finish out of order — present the clips in timeline order.
    job.outputs.sort((a, b) => a.startSec - b.startSec);
  }

  /** Final summary — always says how many were cut and, when short of the request, why. */
  private report(job: ClipJobState, s: ScanState, feasible: number) {
    const fills = job.outputs.filter((o) => o.bestAvailable).length;
    const matched = job.outputs.length - fills;
    if (job.clipsEmitted >= feasible && job.clipsEmitted > 0) {
      this.info(job, s, `Done — ${job.clipsEmitted}/${job.clipBudget} clips cut (${matched} matched the prompt${fills ? `, ${fills} best available` : ''}).`);
      return;
    }

    let type: 'info' | 'error' = 'info';
    let why: string;
    if (s.scoredWindows === 0 && s.scorerUnavailable > 0) {
      type = 'error';
      why = 'Gemini scoring was unavailable (API key, quota or overload), so the video could not be matched against the prompt.';
    } else if (s.chunkCount > 0 && s.transcribeFailedChunks === s.chunkCount) {
      type = 'error';
      why = 'Transcription failed for every chunk (check ASSEMBLYAI_API_KEY / AssemblyAI status).';
    } else if (!job.fillToTarget) {
      why = `Only ${matched} strong match(es) for "${job.prompt}" in this video ("Strong matches only" is on — turn it off to fill up to ${job.clipBudget} with the closest moments).`;
    } else {
      why = 'Some selected moments failed to render and no replacements were left.';
    }
    const msg = `${job.clipsEmitted}/${job.clipBudget} clips cut — ${why}${job.clipsEmitted === 0 ? ' No credits were charged.' : ''}`;
    if (type === 'error') {
      // A service outage, not an answer about the video — failed, so it can be retried.
      job.status = 'failed';
      job.errorMessage = msg;
    }
    console.log(`[Process] ${msg}`);
    this.logEvent(job, type, msg, s.chunkCount);
  }

  /** Renders one clip + poster frame, publishes, THEN charges — so nothing after the charge can throw and trigger a re-charge. */
  private async renderAndStore(job: ClipJobState, c: Candidate, no: number): Promise<EmitResult> {
    if (this.hooks.canAfford && !(await this.hooks.canAfford(job.orgId, CREDITS_PER_UNIT))) return 'no_credits';

    const dir = this.outputDir(job);
    const base = `clip-${no}-${Date.now()}`;
    const clipPath = path.join(dir, `${base}.mp4`);
    const thumbPath = path.join(dir, `${base}.jpg`);

    let rendered: RenderedClip;
    try {
      rendered = await this.renderWithFallback(job, c.outStart, c.outEnd - c.outStart, clipPath);
    } catch (e: any) {
      console.log(`[Render] ${e?.message}`);
      return this.isActive(job) ? 'skipped' : 'stopped';
    }
    // Poster frame on the matched line — the first frame is often mid-blink or a scene cut.
    const peakAt = Math.max(0, Math.min((c.peakStart + c.peakEnd) / 2 - c.outStart, rendered.durationSec - 0.2));
    const thumb = await this.renderer.createThumbnail(clipPath, peakAt, thumbPath).catch(() => null);

    // A Stop that arrived while rendering must not be billed.
    if (!this.isActive(job)) {
      this.discard(clipPath, thumbPath);
      return 'stopped';
    }

    let urls: [string, string | undefined];
    try {
      urls = await Promise.all([
        this.publish(clipPath, 'clip', job),
        thumb ? this.publish(thumbPath, 'thumb', job) : Promise.resolve(undefined),
      ]);
    } catch (e: any) {
      console.log(`[Render] publishing clip failed: ${e?.message}`);
      this.discard(clipPath, thumbPath);
      return 'skipped';
    }

    if (!(await this.hooks.chargeCredits(job.orgId, CREDITS_PER_UNIT))) {
      this.discard(clipPath, thumbPath);
      return 'no_credits';
    }

    this.emit(job, {
      startSec: c.outStart,
      endSec: c.outEnd,
      outputPath: urls[0],
      thumbPath: urls[1],
      peakSec: (c.peakStart + c.peakEnd) / 2,
      caption: c.win.caption,
      tags: c.win.tags,
      anchorKey: c.win.anchorKey || undefined,
      width: rendered.width,
      height: rendered.height,
      sizeBytes: rendered.sizeBytes,
      matchScore: c.win.score,
      bestAvailable: c.bestAvailable,
    });
    return 'emitted';
  }

  /**
   * Renders from the cheapest source that works: the remote stream (link sources scanned from
   * audio) → the stream with freshly fetched links (they expire / get refused) → the full video,
   * downloaded once. Uploads and fully downloaded links render from the local file directly.
   */
  private async renderWithFallback(job: ClipJobState, start: number, duration: number, outPath: string): Promise<RenderedClip> {
    const opts = { aspectRatio: job.aspectRatio, framing: job.framing };
    const attempt = async (mode: 'stream' | 'refresh' | 'download') =>
      this.renderer.renderClip(await this.ingest.renderSource(job.jobId, mode), start, duration, outPath, opts);

    try {
      return await attempt('stream');
    } catch (e) {
      if (!(e instanceof SourceUnavailableError) || !this.isActive(job)) throw e;
      console.log(`[Render] ${e.message} — retrying with fresh stream links.`);
    }
    try {
      return await attempt('refresh');
    } catch (e) {
      if (!(e instanceof SourceUnavailableError) || !this.isActive(job)) throw e;
      if (!this.fallbackLogged.has(job.jobId)) {
        this.fallbackLogged.add(job.jobId);
        this.logEvent(job, 'error', 'The video stream could not be read — downloading the full video to cut the clips from instead (slower).');
      }
    }
    return attempt('download');
  }

  /** Records a charged unit. Never throws — a failing onOutput hook must not cause a re-run (and re-charge). */
  private emit(job: ClipJobState, o: Omit<ClipOutput, 'id' | 'jobId' | 'orgId' | 'clipNo' | 'durationSec' | 'creditsCharged' | 'createdAt'>) {
    job.clipsEmitted++;
    const output: ClipOutput = {
      ...o,
      id: `${job.jobId}-clip-${job.clipsEmitted}`,
      jobId: job.jobId,
      orgId: job.orgId,
      clipNo: job.clipsEmitted,
      durationSec: o.endSec - o.startSec,
      creditsCharged: CREDITS_PER_UNIT,
      createdAt: new Date(),
    };
    job.outputs.push(output);
    try {
      this.hooks.onOutput(output);
    } catch (e: any) {
      console.error(`[Process] onOutput hook threw: ${e?.message}`);
    }
  }

  private outOfCredits(job: ClipJobState) {
    console.log('[Process] out of credits — stopping job.');
    this.logEvent(job, 'error', `Out of credits — stopped after ${job.clipsEmitted}/${job.clipBudget}.`);
    job.status = 'done';
    job.errorMessage = OUT_OF_CREDITS_MESSAGE;
  }

  private outputDir(job: ClipJobState): string {
    const dir = path.join(this.hooks.outputDir ?? path.join(process.cwd(), 'temp', 'clips-out'), job.jobId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  private async publish(localPath: string, kind: PublishKind, job: ClipJobState): Promise<string> {
    return this.hooks.publishFile ? this.hooks.publishFile(localPath, kind, job) : localPath;
  }

  private discard(...files: string[]) {
    for (const f of files) {
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch { /* ignore */ }
    }
  }

  private fmt(sec: number): string {
    const m = Math.floor(sec / 60);
    return `${m}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
  }

  private setPhase(job: ClipJobState, phase: ClipJobPhase) {
    job.phase = phase;
  }

  /** Event + console line (the dashboard's Activity panel shows [Process] console lines). */
  private info(job: ClipJobState, s: ScanState, message: string) {
    console.log(`[Process] ${message}`);
    this.logEvent(job, 'info', message, s.chunkCount);
  }

  private logEvent(job: ClipJobState, type: 'info' | 'match' | 'skip' | 'error', message: string, chunkNo = 0) {
    job.events.push({ type, message, chunkNo, at: new Date() });
  }
}

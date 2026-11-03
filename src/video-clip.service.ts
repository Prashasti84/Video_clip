import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ClipJobState, ClipOutput, TranscriptResult } from './types';
import { StartClipJobDto } from './dto/start-clip-job.dto';
import { VideoIngestService } from './video-ingest.service';
import { PublishKind, VideoProcessService } from './video-process.service';
import { VideoScorerService } from './video-scorer.service';
import { VideoAudioEnergyService } from './video-audio-energy.service';
import { ChunkCache } from './chunk-cache';

const DEFAULT_CHUNK_LENGTH_SEC = 300;
const DEFAULT_CLIP_BUDGET = 5;
const DEFAULT_CLIP_OUTPUT_SEC = 30;
const ASPECT_RATIOS = ['16:9', '9:16', '1:1'];
const TERMINAL = ['done', 'failed', 'stopped'];

/** How often changed job state is written to stateDir. */
const SAVE_INTERVAL_MS = 2_000;
/** Resumes after a restart before a job is given up on — a job that crashes the server must not loop forever. */
const MAX_RESUMES = 2;
/** A failed / stopped job keeps its downloaded source this long, so Retry doesn't download it again. */
const SOURCE_KEEP_MS = 2 * 60 * 60 * 1000;
/** Finished jobs are forgotten (and their state file deleted) after this long. */
const JOB_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
/** Cached chunk transcripts unused for this long are deleted. */
const CACHE_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const MAINTENANCE_INTERVAL_MS = 10 * 60 * 1000;

/** Integer in [min, max]; anything unparseable falls back to `dflt`. */
function intIn(v: unknown, min: number, max: number, dflt: number): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n !== 0 ? Math.min(max, Math.max(min, n)) : dflt;
}

/** JSON turns Dates into strings — turn them back. */
function reviveJob(raw: any): ClipJobState | null {
  if (!raw?.jobId || !raw.startedAt) return null;
  const date = (v: unknown) => (v ? new Date(v as string) : undefined);
  return {
    ...raw,
    startedAt: new Date(raw.startedAt),
    endedAt: date(raw.endedAt),
    outputs: (raw.outputs ?? []).map((o: any) => ({ ...o, createdAt: new Date(o.createdAt) })),
    events: (raw.events ?? []).map((e: any) => ({ ...e, at: new Date(e.at) })),
  };
}

export interface VideoClipServiceConfig {
  geminiApiKey: string;
  transcribeAudio: (audioBuffer: Buffer) => Promise<TranscriptResult | null>;
  /** Charged after each successful render (LiveCut reserveCredits). false = out of credits. */
  chargeCredits: (orgId: string, amount: number) => Promise<boolean>;
  /** Optional pre-render balance check (LiveCut getCredits guard). */
  canAfford?: (orgId: string, amount: number) => Promise<boolean>;
  /** Where rendered clips / thumbnails are written. Default temp/clips-out. */
  outputDir?: string;
  /** Persist a rendered file (e.g. upload to S3) and return the path/URL stored on the output. */
  publishFile?: (localPath: string, kind: PublishKind, job: ClipJobState) => Promise<string>;
  onOutput?: (output: ClipOutput) => void;
  /**
   * Folder job state is saved to, so jobs survive a restart (see resumeInterrupted). Unset = jobs
   * live in memory only.
   */
  stateDir?: string;
  /** Transcript cache for retried / resumed / re-prompted jobs. Default temp/chunk-cache; null = off. */
  cacheDir?: string | null;
  /** Wraps every job run — e.g. to give its log lines an async context. */
  runInContext?: (jobId: string, run: () => Promise<void>) => Promise<void>;
}

export class VideoClipService {
  private readonly jobs = new Map<string, ClipJobState>();
  private readonly ingest = new VideoIngestService();
  private readonly audioEnergy = new VideoAudioEnergyService();
  private readonly scorer: VideoScorerService;
  private readonly processor: VideoProcessService;
  private readonly cache: ChunkCache | null;
  /** Last JSON written per job — only changed jobs are rewritten. */
  private readonly saved = new Map<string, string>();
  /** The run in progress per job. A job never has two runs at once — they share its work folder and state. */
  private readonly running = new Map<string, Promise<void>>();

  constructor(private readonly config: VideoClipServiceConfig) {
    this.scorer = new VideoScorerService(config.geminiApiKey);
    const cacheDir = config.cacheDir === undefined ? path.join(process.cwd(), 'temp', 'chunk-cache') : config.cacheDir;
    this.cache = cacheDir ? new ChunkCache(cacheDir) : null;
    const onOutput = config.onOutput ?? (() => {});
    this.processor = new VideoProcessService(this.ingest, this.scorer, this.audioEnergy, {
      transcribeAudio: config.transcribeAudio,
      chargeCredits: config.chargeCredits,
      canAfford: config.canAfford,
      publishFile: config.publishFile,
      outputDir: config.outputDir ?? path.join(process.cwd(), 'temp', 'clips-out'),
      chunkCache: this.cache,
      onOutput: (output) => {
        // A charged clip is saved at once, so a crash right after it can't lose (and re-cut) it.
        const job = this.jobs.get(output.jobId);
        if (job) this.saveJob(job);
        onOutput(output);
      },
    });

    if (config.stateDir) {
      this.loadState();
      setInterval(() => this.flush(), SAVE_INTERVAL_MS).unref();
    }
    this.maintain();
    setInterval(() => this.maintain(), MAINTENANCE_INTERVAL_MS).unref();
  }

  /** Starts a job. Out-of-range settings are clamped to the DTO's limits rather than rejected. */
  async start(orgId: string, dto: StartClipJobDto): Promise<string> {
    const sourceUrl = String(dto.sourceUrl ?? '').trim();
    const prompt = String(dto.prompt ?? '').trim();
    if (!sourceUrl) throw new Error('sourceUrl is required');
    if (!prompt) throw new Error('prompt is required');

    const jobId = crypto.randomUUID();
    const job: ClipJobState = {
      jobId,
      orgId,
      status: 'queued',
      phase: 'idle',
      sourceUrl,
      sourceName: dto.sourceName?.trim() || undefined,
      prompt,
      negativePrompt: dto.negativePrompt?.trim() || undefined,
      aspectRatio: ASPECT_RATIOS.includes(String(dto.aspectRatio)) ? String(dto.aspectRatio) : '16:9',
      framing: dto.framing === 'blur' ? 'blur' : 'crop',
      clipBudget: intIn(dto.clipBudget, 1, 100, DEFAULT_CLIP_BUDGET),
      fillToTarget: dto.fillToTarget !== false,
      clipsEmitted: 0,
      chunkLengthSec: intIn(dto.chunkLengthSec, 30, 1800, DEFAULT_CHUNK_LENGTH_SEC),
      clipOutputSec: intIn(dto.clipOutputSec, 5, 300, DEFAULT_CLIP_OUTPUT_SEC),
      totalDurationSec: 0,
      currentChunkIndex: 0,
      threshold: 0, // set by VideoProcessService.run (match floor in use)
      outputs: [],
      events: [],
      startedAt: new Date(),
    };
    this.jobs.set(jobId, job);
    this.launch(job);
    return jobId;
  }

  /**
   * Runs a failed or stopped job again, in place: clips already cut are kept (and count toward the
   * budget), the source is reused if still on disk, and cached chunk transcripts are not re-bought.
   */
  async retry(jobId: string): Promise<ClipJobState> {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error('Job not found.');
    const check = () => {
      if (job.status !== 'failed' && job.status !== 'stopped') {
        throw new Error(`Only a failed or stopped job can be retried — this one is ${job.status}.`);
      }
      if (job.clipsEmitted >= job.clipBudget) throw new Error('All requested clips are already cut.');
    };
    check();
    // A stopped run only notices at its next step (after a Gemini call or a render) — let it finish.
    const previous = this.running.get(jobId);
    if (previous) {
      const settled = await Promise.race([
        previous.then(() => true),
        new Promise<boolean>((r) => setTimeout(() => r(false), 20_000)),
      ]);
      if (!settled) throw new Error('The previous run is still finishing its current step — try again in a moment.');
      if (this.jobs.get(jobId) !== job) throw new Error('Job not found.');
      check();
    }
    job.resumeCount = 0;
    this.resetForRun(job, job.status === 'stopped' ? 'Resumed.' : 'Retrying.');
    this.saveJob(job);
    this.launch(job);
    return job;
  }

  /**
   * Restarts the jobs a server restart interrupted (call once the host is wired up). Each job
   * picks up with its clips so far; a job interrupted more than MAX_RESUMES times is failed instead.
   * Returns the ids of the resumed jobs.
   */
  resumeInterrupted(): string[] {
    const resumed: string[] = [];
    for (const job of this.jobs.values()) {
      if (TERMINAL.includes(job.status)) continue;
      job.resumeCount = (job.resumeCount ?? 0) + 1;
      if (job.resumeCount > MAX_RESUMES) {
        job.status = 'failed';
        job.phase = 'idle';
        job.endedAt = new Date();
        job.errorMessage = `Interrupted by a server restart ${job.resumeCount} times — not resuming it automatically again. Use Retry to run it once more.`;
        job.events.push({ type: 'error', message: job.errorMessage, chunkNo: 0, at: new Date() });
        this.saveJob(job);
        continue;
      }
      this.resetForRun(job, 'Server restarted — resuming. Clips already cut are kept and finished chunks are not transcribed again.');
      // Written before the run starts, so a job that crashes the server is still counted.
      this.saveJob(job);
      this.launch(job);
      resumed.push(job.jobId);
    }
    return resumed;
  }

  stop(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job) return false;
    if (!TERMINAL.includes(job.status)) {
      job.status = 'stopped';
      job.endedAt = new Date();
      this.ingest.abort(jobId);
      this.saveJob(job);
    }
    return true;
  }

  getJob(jobId: string): ClipJobState | null {
    return this.jobs.get(jobId) ?? null;
  }

  listJobs(orgId: string): ClipJobState[] {
    return [...this.jobs.values()]
      .filter((j) => j.orgId === orgId)
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
  }

  listOutputs(jobId: string): ClipOutput[] {
    return this.jobs.get(jobId)?.outputs ?? [];
  }

  deleteJob(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job) return false;
    this.stop(jobId);
    this.ingest.cleanup(jobId);
    this.processor.cleanup(jobId);
    this.jobs.delete(jobId);
    this.removeState(jobId);
    return true;
  }

  /** Writes every changed job to stateDir now (also runs on a timer). Safe to call on shutdown. */
  flush(): void {
    if (!this.config.stateDir) return;
    for (const job of this.jobs.values()) this.saveJob(job);
  }

  private launch(job: ClipJobState) {
    const run = () => this.runJob(job);
    const tracked: Promise<void> = (this.config.runInContext ? this.config.runInContext(job.jobId, run) : run())
      .catch((e) => {
        if (job.status === 'stopped') return; // a cancelled download rejects — that's not a failure
        job.status = 'failed';
        job.errorMessage = e?.message ?? String(e);
        job.endedAt = new Date();
      })
      .finally(() => {
        if (this.running.get(job.jobId) === tracked) this.running.delete(job.jobId);
        // Saved at once: a restart a moment after a job ends must not resume it.
        if (this.jobs.get(job.jobId) === job) this.saveJob(job);
      });
    this.running.set(job.jobId, tracked);
  }

  private resetForRun(job: ClipJobState, message: string) {
    job.status = 'queued';
    job.phase = 'idle';
    job.errorMessage = undefined;
    job.endedAt = undefined;
    job.downloadPct = undefined;
    job.currentChunkIndex = 0;
    job.transcribedChunks = undefined;
    job.scannedChunks = undefined;
    job.events.push({ type: 'info', message, chunkNo: 0, at: new Date() });
  }

  private async runJob(job: ClipJobState): Promise<void> {
    try {
      job.status = 'downloading';
      const { totalDurationSec } = await this.ingest.prepareVideo(job.jobId, job.sourceUrl, (pct) => {
        job.downloadPct = Math.round(pct * 10) / 10;
      });
      job.totalDurationSec = totalDurationSec;
      if (job.status !== 'downloading') return; // stopped while downloading

      job.status = 'processing';
      await this.processor.run(job);

      if (job.status === 'processing') job.status = 'done'; // the processor already logged the summary
    } finally {
      if (!job.endedAt) job.endedAt = new Date();
      job.phase = 'idle';
      this.processor.cleanup(job.jobId);
      // With saved state, a failed / stopped job keeps its source for Retry (maintain() drops it later).
      if (job.status === 'done' || !this.config.stateDir) this.ingest.cleanup(job.jobId);
    }
  }

  /** Periodic housekeeping: old sources, old finished jobs, unused cache entries. */
  private maintain() {
    const now = Date.now();
    for (const job of [...this.jobs.values()]) {
      if (TERMINAL.includes(job.status) && job.endedAt && now - job.endedAt.getTime() > JOB_KEEP_MS) {
        this.jobs.delete(job.jobId);
        this.removeState(job.jobId);
      }
    }
    // Only the instance that owns saved state sweeps work folders — a second, in-memory instance in
    // the same folder (test-run.ts next to the server) must not delete the server's sources.
    if (this.config.stateDir) {
      const keep = new Set(
        [...this.jobs.values()]
          .filter((j) => this.running.has(j.jobId) || !TERMINAL.includes(j.status)
            || (j.status !== 'done' && (!j.endedAt || now - j.endedAt.getTime() < SOURCE_KEEP_MS)))
          .map((j) => j.jobId),
      );
      this.ingest.sweep(keep);
    }
    this.cache?.sweep(CACHE_KEEP_MS);
  }

  // ── Persistence ──────────────────────────────────────────────────────────────

  private stateFile(jobId: string): string {
    return path.join(this.config.stateDir!, `${jobId}.json`);
  }

  private loadState() {
    const dir = this.config.stateDir!;
    fs.mkdirSync(dir, { recursive: true });
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const text = fs.readFileSync(path.join(dir, name), 'utf8');
        const job = reviveJob(JSON.parse(text));
        if (!job) continue;
        this.jobs.set(job.jobId, job);
        this.saved.set(job.jobId, text);
      } catch (e: any) {
        console.warn(`[Server] Skipping unreadable job file ${name}: ${e?.message ?? e}`);
      }
    }
  }

  private saveJob(job: ClipJobState) {
    if (!this.config.stateDir) return;
    const text = JSON.stringify(job);
    if (this.saved.get(job.jobId) === text) return;
    const file = this.stateFile(job.jobId);
    const tmp = `${file}.tmp`;
    try {
      // Write-then-rename: a crash mid-write never leaves a truncated state file.
      fs.writeFileSync(tmp, text);
      fs.renameSync(tmp, file);
      this.saved.set(job.jobId, text);
    } catch (e: any) {
      console.warn(`[Server] Could not save job ${job.jobId.slice(0, 8)}: ${e?.message ?? e}`);
    }
  }

  private removeState(jobId: string) {
    this.saved.delete(jobId);
    if (!this.config.stateDir) return;
    try { fs.rmSync(this.stateFile(jobId), { force: true }); } catch { /* ignore */ }
  }
}

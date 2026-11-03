export type ClipJobStatus =
  | 'queued'
  | 'downloading'
  | 'processing'
  | 'done'
  | 'failed'
  | 'stopped';

/** Mirrors LiveSession.batchPhase. */
export type ClipJobPhase = 'idle' | 'extracting' | 'transcribing' | 'scoring' | 'selecting' | 'rendering';

/**
 * How the source is fitted to the output aspect ratio.
 * 'crop': fill the frame, centre-cropping the overflow (default — best for talking heads).
 * 'blur': fit the whole picture over a blurred, zoomed copy of itself (nothing is cut off).
 */
export type ClipFraming = 'crop' | 'blur';

/** One prompt-matched moment, timestamps relative to the scanned window (mirrors LiveCut's BatchMoment). */
export interface ClipMoment {
  /** The whole beat — setup through payoff. */
  start: number;
  end: number;
  /** The line that made it a match (the verbatim source_words anchor). Always kept inside the cut. */
  peakStart: number;
  peakEnd: number;
  score: number;
  caption: string;
  tags: string[];
  /** Normalized source_words — content-based dedup key that survives timestamp drift. */
  anchorKey: string;
  /** Relative loudness 0..1 (0 = no energy bonus). */
  energy: number;
  /** True when the moment came from a loudness spike with no usable speech behind it. */
  energyOnly: boolean;
}

export interface ClipOutput {
  id: string;
  jobId: string;
  orgId: string;
  clipNo: number;
  startSec: number;
  endSec: number;
  durationSec: number;
  /** Rendered mp4 (path or published URL). */
  outputPath: string;
  /** JPEG poster frame taken at the matched line. */
  thumbPath?: string;
  /** Absolute source second of the matched line. */
  peakSec?: number;
  caption?: string;
  tags: string[];
  anchorKey?: string;
  width?: number;
  height?: number;
  sizeBytes: number;
  matchScore: number;
  /** True when this unit was not a real prompt match — cut only to reach the requested clip count. */
  bestAvailable: boolean;
  creditsCharged: number;
  createdAt: Date;
}

/** Activity timeline row — mirrors LiveEvent. */
export interface ClipJobEvent {
  type: 'info' | 'match' | 'skip' | 'error';
  message: string;
  chunkNo: number;
  at: Date;
}

export interface ClipJobState {
  jobId: string;
  orgId: string;
  status: string; // use string (not the union) so TypeScript doesn't narrow away mutations
  phase: ClipJobPhase;
  sourceUrl: string;
  /** Display name of the source (e.g. the uploaded file's name). */
  sourceName?: string;
  prompt: string;
  negativePrompt?: string;
  aspectRatio: string;
  framing: ClipFraming;
  /** Number of clips the user asked for. */
  clipBudget: number;
  /** true: always aim for clipBudget outputs (best-available fill); false: strong matches only. */
  fillToTarget: boolean;
  clipsEmitted: number;
  chunkLengthSec: number;
  clipOutputSec: number;
  totalDurationSec: number;
  currentChunkIndex: number;
  /** Current adaptive match threshold. */
  threshold: number;
  outputs: ClipOutput[];
  events: ClipJobEvent[];
  errorMessage?: string;
  /** yt-dlp download progress 0–100 while status is 'downloading' (link sources only). */
  downloadPct?: number;
  /** Scan progress: chunks transcribed / scored so far (both run in parallel; out of the chunk count). */
  transcribedChunks?: number;
  scannedChunks?: number;
  /** Times this job was resumed after a server restart — caps a job that keeps crashing the server. */
  resumeCount?: number;
  startedAt: Date;
  endedAt?: Date;
}

export interface EnergyPeak {
  atSec: number;
  startSec: number;
  endSec: number;
  prominenceDb: number;
  relative: number;
}

export interface TranscriptItem {
  start_time: number;
  end_time: number;
  content: string;
}

export interface TranscriptResult {
  text: string;
  items: TranscriptItem[];
}

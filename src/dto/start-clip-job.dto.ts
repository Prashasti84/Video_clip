import { IsString, IsOptional, IsInt, IsIn, IsBoolean, Min, Max } from 'class-validator';
import { ClipFraming } from '../types';

/**
 * Parameters for kicking off a video-clip job against a pre-recorded video.
 * Mirrors StartLiveSessionDto from livecut but removes live-only fields
 * (autoContinue, lookbackSec, checkIntervalSec) and adds normal-video fields.
 */
export class StartClipJobDto {
  /**
   * URL of the pre-recorded video (YouTube, direct .mp4 URL) or absolute path to a local file.
   * Not validated as a URL when it starts with `/` or a Windows drive letter — local paths are
   * allowed here unlike the live path which only ever takes a live-stream URL. HTTP callers
   * should upload local files (server.ts POST /uploads) instead of passing a server path.
   */
  sourceUrl!: string;

  /** Display name for the source (e.g. the uploaded file's original name). */
  @IsOptional()
  @IsString()
  sourceName?: string;

  /** What to look for in the video — same natural-language prompt as in LiveCut. */
  @IsString()
  prompt!: string;

  @IsOptional()
  @IsString()
  negativePrompt?: string;

  @IsOptional()
  @IsIn(['1:1', '9:16', '16:9'])
  aspectRatio?: string;

  /** How the source is fitted to aspectRatio: centre-crop (default) or fit over a blurred fill. */
  @IsOptional()
  @IsIn(['crop', 'blur'])
  framing?: ClipFraming;

  /**
   * How many clips the user wants. Default 5. The whole video is scanned first, then the best
   * `clipBudget` moments for the prompt are cut (spaced apart). Capped by how many non-overlapping
   * windows the video can physically hold.
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  clipBudget?: number;

  /**
   * true (default): if the video has fewer real matches than clipBudget, fill the rest with the
   * closest available moments (flagged bestAvailable). false: strong matches only — may return fewer.
   */
  @IsOptional()
  @IsBoolean()
  fillToTarget?: boolean;

  /**
   * Length in seconds of each SCAN CHUNK — the video is sliced into chunks of this length and
   * each chunk is transcribed + scored independently. A longer chunk means fewer Gemini calls
   * (cheaper) but coarser matching. Default 300s (5 min).
   */
  @IsOptional()
  @IsInt()
  @Min(30)
  @Max(1800)
  chunkLengthSec?: number;

  /**
   * Target length of each emitted clip (seconds). The matched moment is placed inside a window of
   * this length (more lead-in than tail), then both cut points are snapped to pauses in speech.
   * Default 30s.
   */
  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(300)
  clipOutputSec?: number;
}

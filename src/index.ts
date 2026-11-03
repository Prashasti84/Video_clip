export { VideoClipService } from './video-clip.service';
export type { VideoClipServiceConfig } from './video-clip.service';
export { StartClipJobDto } from './dto/start-clip-job.dto';
export type {
  ClipFraming,
  ClipJobEvent,
  ClipJobPhase,
  ClipJobState,
  ClipJobStatus,
  ClipMoment,
  ClipOutput,
  EnergyPeak,
  TranscriptItem,
  TranscriptResult,
} from './types';

// Lower-level services (exported for advanced use / custom wiring)
export { VideoIngestService } from './video-ingest.service';
export type { PreparedVideo } from './video-ingest.service';
export { ChunkCache } from './chunk-cache';
export type { ChunkData } from './chunk-cache';
export { VideoScorerService } from './video-scorer.service';
export { VideoProcessService, CREDITS_PER_UNIT } from './video-process.service';
export type { PublishKind } from './video-process.service';
export { VideoAudioEnergyService } from './video-audio-energy.service';
export { VideoClipRendererService } from './video-clip-renderer.service';
export type { RenderClipOptions, RenderedClip, VideoProbe } from './video-clip-renderer.service';
export { buildThemeGuidance } from './theme-guidance';

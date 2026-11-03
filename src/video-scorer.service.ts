import { GoogleGenerativeAI } from '@google/generative-ai';
import { ClipMoment, TranscriptResult, TranscriptItem, EnergyPeak } from './types';
import { buildThemeGuidance } from './theme-guidance';
import { GEMINI_MODELS, isModelRetiredError } from './gemini-models';

/**
 * Prompt-match scoring for Video Clip — a port of LiveCut's LiveWindowScorerService
 * (backend/src/livecut/live-window-scorer.service.ts). Same selection prompt, theme guidance,
 * verbatim source_words anchoring (exact → ±1 word count → fuzzy), energy ranking and energy-only
 * confirmation gate. Adapted to a pre-recorded video and to video clips: a moment is a whole beat
 * (setup → payoff, up to the clip length) and the anchored peak line is tracked separately.
 */

/** Weight of the loudness signal in the final ranking key — energy only breaks ties between things that already qualify. */
const ENERGY_RANK_WEIGHT = 0.25;
/** A moment must be at least this loud, relative to its window, to earn any energy bonus at all. */
const ENERGY_MIN_RELATIVE = 0.35;
/** Energy-only fallback: a spike must be at least this prominent (dB over the median) to emit. */
const ENERGY_ONLY_MIN_PROMINENCE_DB = 12;
/** Energy-only fallback: ceiling score — below MATCH_THRESHOLD, so it only survives via confirmEnergyMoment(). */
const ENERGY_ONLY_SCORE = 0.62;
/** Energy confirmation: seconds of transcript either side of a spike handed to the check. */
const CAPTION_CONTEXT_SEC = 30;

/** Moment sizing. The upper bound is per call (the clip length) — this is only the default. */
const MIN_MOMENT_SEC = 3;
const MAX_MOMENT_SEC = 12;
const MATCH_THRESHOLD = 0.75;
const MIN_TRANSCRIPT_WORDS = 6; // below this there's no signal worth a Gemini call

type RawMoment = { source_words?: string; score?: number; caption?: string; tags?: string[]; hint_start?: number; hint_end?: number };

/**
 * Why findChunkMoments returned what it did. [] alone cannot tell "Gemini looked and nothing
 * matched" apart from "Gemini was never reached" — the caller needs that to report honestly.
 */
export interface ScoreOutcome {
  status?: 'scored' | 'too_little_speech' | 'unavailable';
}

export class VideoScorerService {
  private readonly genAI: GoogleGenerativeAI | null;
  private readonly modelBackoffMs: Record<string, number> = {};

  constructor(geminiApiKey: string) {
    this.genAI = geminiApiKey ? new GoogleGenerativeAI(geminiApiKey) : null;
  }

  /**
   * Scans a transcript window for up to `maxMoments` prompt-matched moments with a SINGLE Gemini
   * call. Returns [] when nothing clears the threshold. Timestamps are window-relative.
   */
  async findChunkMoments(
    transcript: TranscriptResult,
    prompt: string,
    negativePrompt: string | null | undefined,
    maxMoments: number,
    windowDurationSec: number,
    matchThreshold: number = MATCH_THRESHOLD,
    energyPeaks: EnergyPeak[] = [],
    outcome: ScoreOutcome = {},
    maxMomentSec: number = MAX_MOMENT_SEC,
  ): Promise<ClipMoment[]> {
    if (!this.genAI) {
      outcome.status = 'unavailable';
      return [];
    }
    if (maxMoments <= 0) return [];
    maxMomentSec = Math.max(MIN_MOMENT_SEC, maxMomentSec);

    const items = transcript.items || [];
    const text = (transcript.text || items.map((i) => i.content).join(' ')).trim();
    if (text.split(/\s+/).filter(Boolean).length < MIN_TRANSCRIPT_WORDS) {
      // Not enough speech to score — a loud enough spike is still a candidate (confirmed later).
      outcome.status = 'too_little_speech';
      return this.momentsFromEnergyAlone(energyPeaks, maxMoments, windowDurationSec, maxMomentSec);
    }

    const sys = this.buildMomentPrompt(text, prompt, negativePrompt ?? null, maxMoments, matchThreshold, energyPeaks, items, windowDurationSec, maxMomentSec);
    console.log(`[Scorer] Calling Gemini: words=${items.length} duration=${windowDurationSec.toFixed(1)}s minScore=${matchThreshold.toFixed(2)} maxMoments=${maxMoments}`);
    const raw = await this.callGeminiWithFallback(sys);
    if (raw === null) {
      outcome.status = 'unavailable';
      return [];
    }

    let parsed = this.tryParseMoments(raw);
    if (parsed === null) {
      console.log('[Scorer] Moment response unparseable, retrying once with a stricter prompt.');
      const retryRaw = await this.callGeminiWithFallback(`${sys}\n\nSTRICT: your previous output was not valid JSON. Output ONLY a valid JSON array, nothing else.`);
      parsed = retryRaw === null ? null : this.tryParseMoments(retryRaw);
      if (parsed === null) {
        outcome.status = 'unavailable';
        return [];
      }
    }
    outcome.status = 'scored';

    return this.resolveMoments(parsed, items, text, matchThreshold, windowDurationSec, energyPeaks, maxMoments, true, maxMomentSec);
  }

  /**
   * "Best available" selection — used only when the video has fewer real matches than the user
   * asked for. Same anchoring/window rules as findChunkMoments, but the model is told to return
   * the `count` closest moments even if the fit is weak (New Pack's "return EXACTLY N" contract)
   * and to score them honestly, so the caller can rank them below every genuine match.
   * `avoid` are window-relative ranges already chosen — the model is asked not to re-pick them.
   */
  async findBestMoments(
    transcript: TranscriptResult,
    prompt: string,
    negativePrompt: string | null | undefined,
    count: number,
    windowDurationSec: number,
    avoid: { start: number; end: number }[] = [],
    outcome: ScoreOutcome = {},
    maxMomentSec: number = MAX_MOMENT_SEC,
  ): Promise<ClipMoment[]> {
    if (!this.genAI) {
      outcome.status = 'unavailable';
      return [];
    }
    if (count <= 0) return [];
    maxMomentSec = Math.max(MIN_MOMENT_SEC, maxMomentSec);
    const items = transcript.items || [];
    const text = (transcript.text || items.map((i) => i.content).join(' ')).trim();
    if (text.split(/\s+/).filter(Boolean).length < MIN_TRANSCRIPT_WORDS) {
      outcome.status = 'too_little_speech';
      return [];
    }

    const avoidNote = avoid.length
      ? `\nThese time ranges are ALREADY CHOSEN — pick different moments, at least 20 seconds away from them: ${avoid
          .map((r) => `${r.start.toFixed(0)}s-${r.end.toFixed(0)}s`)
          .join(', ')}\n`
      : '';
    const sys = `You are selecting the ${count} best short-clip moments from a VIDEO transcript (duration: ${windowDurationSec.toFixed(0)}s) for a user's prompt. The video may not contain a perfect match — your job is to find the CLOSEST available moments anyway.

═══ TIMED TRANSCRIPT ═══
${this.buildTimedTranscript(items, windowDurationSec)}

═══ USER'S VIBE PROMPT ═══
"${prompt}"
${negativePrompt ? `\nStrictly AVOID content matching: "${negativePrompt}"\n` : ''}${avoidNote}
═══ THEME GUIDANCE ═══
${buildThemeGuidance(prompt)}

═══ SELECTION RULES ═══
1. Return EXACTLY ${count} moment${count > 1 ? 's' : ''} (fewer ONLY if the transcript has fewer distinct moments than that). Spread them across DIFFERENT parts of the video — never adjacent sentences.
2. Prefer, in order: moments that fit the prompt; then the most expressive, quotable or emotionally charged lines; then clear, self-contained statements.
3. "score": an HONEST 0.0–1.0 fit to the prompt. Low scores are expected and fine here — do not inflate them.
4. For each moment:
   a. "source_words": EXACTLY 3–5 consecutive words copied VERBATIM from the transcript.
   b. "hint_start" / "hint_end": where the moment's setup begins and where its payoff ends, in seconds, from the timestamps — at most ${maxMomentSec.toFixed(0)}s apart, starting and ending on whole sentences.
   c. "caption": a clip title, 3–8 words (hard max 10), English, a complete standalone thought in the caption style above, no exclamation marks, double quotes, hashtags or emojis.
   d. "tags": 5–8 single-word tags.
5. OUTPUT: ONLY a valid JSON array — no markdown, no explanation.

Format:
[
  {"source_words": "I just told him", "hint_start": 42.5, "hint_end": 48.0, "caption": "Accidentally reveals the whole plan", "score": 0.4, "tags": ["confession", "funny", "accident", "reveal", "awkward"]}
]`;

    console.log(`[Scorer] Calling Gemini (best-available): words=${items.length} duration=${windowDurationSec.toFixed(1)}s count=${count}`);
    const raw = await this.callGeminiWithFallback(sys);
    const parsed = raw === null ? null : this.tryParseMoments(raw);
    if (parsed === null) {
      outcome.status = 'unavailable';
      return [];
    }
    outcome.status = 'scored';
    return this.resolveMoments(parsed, items, text, 0, windowDurationSec, [], count, false, maxMomentSec);
  }

  /**
   * Validates raw model output against the transcript (verbatim source_words, word-level anchor,
   * hint blending), sizes each moment (setup → payoff, never dropping the anchored peak line),
   * drops overlaps (keeping the better-ranked), optionally adds energy-only candidates, and keeps
   * the best `maxMoments`. Window-relative in and out.
   */
  private resolveMoments(
    parsed: RawMoment[],
    items: TranscriptItem[],
    text: string,
    matchThreshold: number,
    windowDurationSec: number,
    energyPeaks: EnergyPeak[],
    maxMoments: number,
    withEnergyOnly: boolean,
    maxMomentSec: number,
  ): ClipMoment[] {
    const fullNorm = this.normalizePhrase(text);
    const moments: ClipMoment[] = [];

    // Validate EVERY returned moment — the cap is applied once, after ranking.
    for (const m of parsed) {
      const score = Math.min(1, Math.max(0, m.score ?? 0));
      if (score < matchThreshold) {
        console.log(`[Scorer] DROP score=${score.toFixed(2)} < ${matchThreshold.toFixed(2)} — "${(m.source_words || '').trim()}"`);
        continue;
      }

      const sourceWords = (m.source_words || '').trim();
      const sw = this.normalizePhrase(sourceWords);
      if (!sw || !fullNorm.includes(sw)) {
        console.log(`[Scorer] DROP source_words not verbatim in transcript: "${sourceWords}"`);
        continue;
      }

      const anchor = this.findWordAnchor(items, sourceWords);
      const hintStart = typeof m.hint_start === 'number' && isFinite(m.hint_start) ? m.hint_start : null;
      const hintEnd = typeof m.hint_end === 'number' && isFinite(m.hint_end) ? m.hint_end : null;

      if (!anchor && hintStart === null) {
        console.log(`[Scorer] DROP "${sourceWords}" — no word anchor and no hint.`);
        continue;
      }

      let anchorStart: number;
      let anchorEnd: number;
      if (anchor && hintStart !== null && hintEnd !== null) {
        anchorStart = Math.min(anchor.start, hintStart);
        anchorEnd = Math.max(anchor.end, hintEnd);
      } else if (anchor) {
        anchorStart = anchor.start;
        anchorEnd = anchor.end;
      } else {
        anchorStart = hintStart!;
        anchorEnd = hintEnd !== null ? hintEnd : hintStart! + MIN_MOMENT_SEC;
      }
      // The peak is the verbatim line itself; without a word anchor the hint start stands in for it.
      const peakStart = anchor ? anchor.start : hintStart!;
      const peakEnd = anchor ? anchor.end : Math.min(anchorEnd, hintStart! + MIN_MOMENT_SEC);

      // Lead in slightly so the line doesn't start mid-syllable, clamp duration, keep inside window.
      let start = Math.max(0, anchorStart - 0.5);
      const spanSec = anchorEnd - anchorStart;
      const duration = Math.max(MIN_MOMENT_SEC, Math.min(maxMomentSec, spanSec + 2));
      // A setup longer than allowed is trimmed from the front — the peak line always stays in.
      if (start + duration < peakEnd + 1) start = Math.max(0, Math.min(peakStart - 0.5, peakEnd + 1 - duration));
      let end = start + duration;
      if (end > windowDurationSec) {
        end = windowDurationSec;
        start = Math.max(0, end - duration);
      }
      if (end - start < 1) continue;

      moments.push({
        start,
        end,
        peakStart: Math.max(start, Math.min(peakStart, end)),
        peakEnd: Math.max(start, Math.min(peakEnd, end)),
        score,
        caption: (m.caption || '').trim(),
        tags: Array.isArray(m.tags) ? m.tags : [],
        anchorKey: sw,
        energy: this.energyAt(energyPeaks, start, end),
        energyOnly: false,
      });
    }

    const rank = (mo: ClipMoment) => this.rankOf(mo);

    // Chronological; drop overlaps keeping the better-ranked.
    moments.sort((a, b) => a.start - b.start);
    const deduped: ClipMoment[] = [];
    for (const m of moments) {
      const prev = deduped[deduped.length - 1];
      if (prev && m.start < prev.end) {
        if (rank(m) > rank(prev)) deduped[deduped.length - 1] = m;
        continue;
      }
      deduped.push(m);
    }

    // Energy-only candidates for spikes the transcript pass ignored.
    for (const extra of withEnergyOnly ? this.momentsFromEnergyAlone(energyPeaks, maxMoments, windowDurationSec, maxMomentSec) : []) {
      if (deduped.some((m) => extra.start < m.end && extra.end > m.start)) continue;
      deduped.push(extra);
    }
    deduped.sort((a, b) => a.start - b.start);

    // Keep the BEST maxMoments, then restore chronological order.
    if (deduped.length > maxMoments) {
      const best = [...deduped].sort((a, b) => rank(b) - rank(a)).slice(0, maxMoments);
      const keep = new Set(best);
      return deduped.filter((m) => keep.has(m));
    }
    return deduped;
  }

  /** LiveCut name for the same call. */
  findBatchMoments(...args: Parameters<VideoScorerService['findChunkMoments']>): Promise<ClipMoment[]> {
    return this.findChunkMoments(...args);
  }

  /** Ranking key: theme fit plus the energy bonus. */
  rankOf(moment: ClipMoment): number {
    return moment.score + ENERGY_RANK_WEIGHT * moment.energy;
  }

  private momentsFromEnergyAlone(peaks: EnergyPeak[], maxMoments: number, windowDurationSec: number, maxMomentSec: number): ClipMoment[] {
    const out: ClipMoment[] = [];
    for (const p of peaks) {
      if (p.prominenceDb < ENERGY_ONLY_MIN_PROMINENCE_DB) continue;
      // Spike plus the few seconds before it — the build-up is what makes a reaction land.
      const wanted = Math.max(MIN_MOMENT_SEC, Math.min(maxMomentSec, p.endSec - p.startSec + 6));
      let start = Math.max(0, p.endSec + 1.5 - wanted);
      let end = start + wanted;
      if (end > windowDurationSec) {
        end = windowDurationSec;
        start = Math.max(0, end - wanted);
      }
      if (end - start < MIN_MOMENT_SEC) continue;
      out.push({
        start,
        end,
        peakStart: Math.max(start, p.startSec),
        peakEnd: Math.min(end, p.endSec),
        score: ENERGY_ONLY_SCORE,
        caption: '',
        tags: ['reaction', 'loud', 'crowd', 'moment'],
        anchorKey: `energy@${Math.round(p.atSec)}`,
        energy: p.relative,
        energyOnly: true,
      });
      if (out.length >= maxMoments) break;
    }
    return out;
  }

  /**
   * Gate for an energy-only moment: does this loud spike actually belong to the user's prompt?
   * Returns a caption to keep it, or null to drop it. Fails CLOSED. Times are in the same
   * coordinate space as `items`.
   */
  async confirmEnergyMoment(
    items: TranscriptItem[],
    momentStart: number,
    momentEnd: number,
    prompt: string,
    negativePrompt: string | null | undefined,
  ): Promise<string | null> {
    if (!this.genAI) return null;

    const from = momentStart - CAPTION_CONTEXT_SEC;
    const to = momentEnd + CAPTION_CONTEXT_SEC;
    const near = items.filter((w) => w.end_time > from && w.start_time < to);
    if (near.length < MIN_TRANSCRIPT_WORDS) return null;

    const context = near.map((w) => w.content).join(' ');
    const themeGuidance = buildThemeGuidance(prompt);

    const sys = `A video got noticeably LOUD at one moment (a spike in audio energy — shouting, laughter, a crowd reacting, or an in-game event). The transcript around that moment is below. The words themselves may not describe what happened, because the loud part may not be speech at all.

═══ TRANSCRIPT AROUND THE LOUD MOMENT ═══
"${context}"

═══ USER'S VIBE PROMPT ═══
"${prompt}"
${negativePrompt ? `\nStrictly AVOID content matching: "${negativePrompt}"\n` : ''}
═══ CAPTION STYLE ═══
${themeGuidance}

Decide whether this loud moment is worth cutting as a short clip for the user's prompt.

REJECT (keep=false) when:
- The loudness is plainly incidental — a cough, a mic bump, music, an ad, a stray noise.
- The surrounding talk has nothing to do with the prompt.
- You cannot tell what happened. Uncertainty means REJECT.
REJECTING IS THE NORMAL, EXPECTED ANSWER. Most loud moments are not highlights. Only keep one you would genuinely be glad to see as a clip for this prompt.

If you keep it, write a clip title in the style above: 3-8 words (hard max 10), English, a complete thought that stands alone, no exclamation marks, double quotes, hashtags, or emojis. Never vague filler.

Return ONLY JSON: {"keep": true/false, "caption": "..."}`;

    const raw = await this.callGeminiWithFallback(sys);
    if (raw === null) return null;
    try {
      const parsed = JSON.parse(raw.trim().replace(/```json\n?|\n?```/g, '').trim());
      if (!parsed?.keep) return null;
      const caption = String(parsed.caption || '').trim();
      if (!caption || caption.split(/\s+/).length > 10) return null;
      return caption;
    } catch {
      return null;
    }
  }

  private energyAt(peaks: EnergyPeak[], start: number, end: number): number {
    let best = 0;
    for (const p of peaks) {
      if (p.startSec < end && p.endSec > start) best = Math.max(best, p.relative);
    }
    return best < ENERGY_MIN_RELATIVE ? 0 : best;
  }

  /** Returns null (not []) on any parse failure so the caller can distinguish "retry" from "legitimately empty". */
  private tryParseMoments(raw: string): RawMoment[] | null {
    try {
      const parsed = JSON.parse(raw.trim().replace(/```json\n?|\n?```/g, '').trim());
      return Array.isArray(parsed) ? parsed : null;
    } catch (e: any) {
      console.log(`[Scorer] Moment response unparseable: ${e?.message}`);
      return null;
    }
  }

  private buildTimedTranscript(items: TranscriptItem[], durationSec: number): string {
    if (items.length === 0) return '';
    const clamp = (t: number) => Math.max(0, Math.min(durationSec, t));
    return items.map((w) => `[${clamp(Number(w.start_time) || 0).toFixed(1)}s] ${w.content}`).join(' ');
  }

  private buildMomentPrompt(
    transcriptText: string,
    prompt: string,
    negativePrompt: string | null,
    maxMoments: number,
    matchThreshold: number,
    energyPeaks: EnergyPeak[],
    items: TranscriptItem[],
    windowDurationSec: number,
    maxMomentSec: number,
  ): string {
    const themeGuidance = buildThemeGuidance(prompt);
    const energyHints = this.buildEnergyHints(energyPeaks, items);
    const timedBlock = items.length > 0 ? this.buildTimedTranscript(items, windowDurationSec) : transcriptText;
    const durationNote = windowDurationSec > 0 ? ` (chunk duration: ${windowDurationSec.toFixed(0)}s)` : '';

    return `You are watching a VIDEO transcript chunk${durationNote}, hunting for moments that match a theme.

═══ TIMED TRANSCRIPT ═══
${timedBlock}
${energyHints}
═══ USER'S VIBE PROMPT ═══
"${prompt}"
${negativePrompt ? `\nStrictly AVOID content matching: "${negativePrompt}"\n` : ''}
═══ THEME GUIDANCE ═══
${themeGuidance}

═══ SELECTION RULES ═══
1. Read the ENTIRE transcript before choosing. The timestamps [Xs] before each word show when it occurs. Use them to locate the best moments precisely.
2. Select ONLY clear, standalone matches to the theme — most chunks contain zero or one real moment. Do NOT pad with weak picks.
3. Return AT MOST ${maxMoments} moment${maxMoments > 1 ? 's' : ''}. Returning an empty array [] is the correct answer when nothing truly matches.
   Transcripts of music or ambient noise are often HALLUCINATED by the transcriber — if the chunk reads as incoherent, repetitive, or unrelated fragments (random language switches, looping phrases, filler), treat it as noise and return [].
4. Each selected moment must score above ${matchThreshold} for theme fit; different moments must come from clearly different parts of the chunk — never adjacent sentences.
5. For each moment:
   a. "source_words": EXACTLY 3–5 consecutive words copied VERBATIM from the transcript (case-insensitive substring match must exist). Choose words from the emotional or comedic PEAK of the moment — the specific line that BEST represents why this qualifies.
   b. "hint_start": when the moment's SETUP begins in seconds (from the timestamps) — the first sentence a viewer needs to understand the peak. Start on a sentence boundary, never mid-thought.
   c. "hint_end": when the moment ENDS in seconds — after the payoff and any immediate reaction, on a sentence boundary. hint_start to hint_end must be at most ${maxMomentSec.toFixed(0)}s; this span becomes a standalone short video clip, so it must make sense on its own.
   d. "caption": A clip title in the "Caption style" defined in THEME GUIDANCE — rephrase the spoken idea into a sharp standalone line, do NOT copy the transcript verbatim. Use the ENTIRE chunk as context so the caption captures what is actually happening around the moment, not just the anchored words. The caption MUST make sense on its own to someone who never saw the video: it states what is happening or the punchline of the moment. Never output vague fillers ("viral moment", "epic clip", "wow"), sentence fragments that trail off, or lines whose meaning depends on unseen context. ALWAYS write the caption in ENGLISH, regardless of the transcript's language — if the transcript is in another language, translate/rephrase the moment's idea into natural English. 3–8 words (hard max 10), complete thought, no exclamation marks, double quotes, hashtags, or emojis. A moment without a strong caption should not be returned at all.
   e. "score": theme-fit 0.0–1.0 (only include moments above ${matchThreshold}).
   f. "tags": 5–8 single-word tags covering both the moment content AND the theme.
6. ${energyHints ? 'The AUDIO ENERGY section lists where the audio spiked (shouting, laughter, a crowd reacting). Those are strong candidates — prefer a moment on or next to a spike when it also fits the theme. A spike alone is NOT a reason to select something off-theme, and a quiet moment that fits the theme perfectly is still a valid pick.' : 'You have no audio information — judge purely on the words.'}
7. OUTPUT: ONLY a valid JSON array — no markdown, no explanation.

Format:
[
  {"source_words": "I just told him", "hint_start": 42.5, "hint_end": 48.0, "caption": "Accidentally reveals the whole plan", "score": 0.9, "tags": ["confession", "funny", "accident", "reveal", "awkward"]}
]`;
  }

  private buildEnergyHints(peaks: EnergyPeak[], items: TranscriptItem[]): string {
    if (peaks.length === 0) return '';
    const lines: string[] = [];
    for (const p of peaks) {
      const words = items
        .filter((w) => w.start_time < p.endSec && w.end_time > p.startSec)
        .map((w) => w.content)
        .join(' ')
        .trim();
      const strength = p.relative >= 0.8 ? 'strongest' : p.relative >= 0.5 ? 'strong' : 'moderate';
      lines.push(
        words
          ? `- ${strength} spike over: "${words.slice(0, 120)}"`
          : `- ${strength} spike with no speech (${Math.round(p.startSec)}s into this chunk) — likely a reaction, crowd noise, or music`,
      );
    }
    return `
═══ AUDIO ENERGY (where the video got loud) ═══
${lines.join('\n')}
`;
  }

  private normalizePhrase(s: string): string {
    // \p{L}\p{N} so non-Latin scripts survive.
    return String(s || '')
      .toLowerCase()
      .replace(/[‘’]/g, "'")
      .replace(/[^\p{L}\p{N}\s']/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** Exact match → ±1 word count (ASR split/merge) → fuzzy per-word (≤1 edit). */
  private findWordAnchor(items: TranscriptItem[], sourceWords: string): { start: number; end: number } | null {
    const target = this.normalizePhrase(sourceWords);
    const wordCount = sourceWords.split(/\s+/).filter(Boolean).length;
    if (!target || wordCount === 0 || items.length < wordCount) return null;

    const exact = this.scanForAnchor(items, target, wordCount);
    if (exact) return exact;

    for (const wc of [wordCount - 1, wordCount + 1]) {
      if (wc < 1 || items.length < wc) continue;
      const hit = this.scanForAnchor(items, target, wc);
      if (hit) return hit;
    }

    const targetWords = target.split(' ');
    for (let i = 0; i <= items.length - wordCount; i++) {
      const win = items.slice(i, i + wordCount);
      const winWords = win.map((it) => this.normalizePhrase(it.content));
      if (winWords.every((w, idx) => this.levenshteinAtMost(w, targetWords[idx] ?? '', 1))) {
        return { start: Number(win[0].start_time) || 0, end: Number(win[win.length - 1].end_time) || 0 };
      }
    }
    return null;
  }

  private scanForAnchor(items: TranscriptItem[], target: string, wordCount: number): { start: number; end: number } | null {
    for (let i = 0; i <= items.length - wordCount; i++) {
      const win = items.slice(i, i + wordCount);
      if (this.normalizePhrase(win.map((it) => it.content).join(' ')) === target) {
        return { start: Number(win[0].start_time) || 0, end: Number(win[win.length - 1].end_time) || 0 };
      }
    }
    return null;
  }

  private levenshteinAtMost(a: string, b: string, max: number): boolean {
    if (Math.abs(a.length - b.length) > max) return false;
    if (a === b) return true;
    const prev = new Array(b.length + 1);
    const curr = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j++) prev[j] = j;
    for (let i = 1; i <= a.length; i++) {
      curr[0] = i;
      let rowMin = curr[0];
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
        rowMin = Math.min(rowMin, curr[j]);
      }
      if (rowMin > max) return false;
      for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
    }
    return prev[b.length] <= max;
  }

  /** 0 when a Gemini model can be called now, else ms until the first one leaves its backoff (Infinity if none ever will). */
  msUntilAvailable(): number {
    if (!this.genAI) return Number.POSITIVE_INFINITY;
    const soonest = Math.min(...GEMINI_MODELS.map((m) => this.modelBackoffMs[m] ?? 0));
    if (soonest >= Number.MAX_SAFE_INTEGER) return Number.POSITIVE_INFINITY;
    return Math.max(0, soonest - Date.now());
  }

  /** Walks GEMINI_MODELS, skipping ones in backoff, until one succeeds. Null if all fail. */
  private async callGeminiWithFallback(sys: string): Promise<string | null> {
    for (const [i, modelName] of GEMINI_MODELS.entries()) {
      if (Date.now() < (this.modelBackoffMs[modelName] ?? 0)) continue;
      try {
        const model = this.genAI!.getGenerativeModel({
          model: modelName,
          generationConfig: { responseMimeType: 'application/json', temperature: 0.3 },
        });
        const result = await model.generateContent(sys);
        return result.response.text();
      } catch (e: any) {
        const msg = String(e?.message || '');
        const lower = msg.toLowerCase();
        const retryDelaySec = this.extractRetryDelaySeconds(msg);
        const is429 = msg.includes('429') || lower.includes('quota') || lower.includes('too many requests');
        const is503 = msg.includes('503') || lower.includes('service unavailable') || lower.includes('high demand');
        const dailyQuota = is429 && (lower.includes('per day') || lower.includes('perday'));

        let reason: string;
        if (isModelRetiredError(e)) {
          this.modelBackoffMs[modelName] = Number.MAX_SAFE_INTEGER;
          reason = 'model retired by Google — removed from the list';
        } else if (retryDelaySec > 0) {
          this.modelBackoffMs[modelName] = Date.now() + retryDelaySec * 1000;
          reason = `${dailyQuota ? 'free-tier DAILY quota used up' : is429 ? 'rate limited' : 'unavailable'} — skipping it for ${this.fmtDuration(retryDelaySec)}`;
        } else if (is429) {
          this.modelBackoffMs[modelName] = Date.now() + 60 * 60_000;
          reason = 'quota / rate limit hit — skipping it for 1h';
        } else if (is503) {
          this.modelBackoffMs[modelName] = Date.now() + 10_000;
          reason = 'overloaded (503) — skipping it for 10s';
        } else {
          reason = msg.replace(/\s+/g, ' ').slice(0, 160);
        }
        const next = GEMINI_MODELS.slice(i + 1).find((m) => Date.now() >= (this.modelBackoffMs[m] ?? 0));
        console.log(`[Scorer] ${modelName}: ${reason}.${next ? ` Trying ${next}…` : ''}`);
      }
    }
    const soonest = Math.min(...GEMINI_MODELS.map((m) => this.modelBackoffMs[m] ?? 0));
    const waitSec = Math.max(0, Math.round((soonest - Date.now()) / 1000));
    console.log(
      `[Scorer] No Gemini model available — all are out of quota or overloaded${waitSec > 0 && soonest < Number.MAX_SAFE_INTEGER ? ` (next one frees up in ${this.fmtDuration(waitSec)})` : ''}. ` +
        'Enable billing on the Google AI Studio project or use another GEMINI_API_KEY to lift the free-tier limit.',
    );
    return null;
  }

  private fmtDuration(sec: number): string {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : m > 0 ? `${m}m` : `${sec}s`;
  }

  private extractRetryDelaySeconds(errorMessage: string): number {
    const retryInfoMatch = errorMessage.match(/retryDelay":"(\d+)s"/i);
    if (retryInfoMatch?.[1]) return Number(retryInfoMatch[1]) || 0;
    const plainMatch = errorMessage.match(/retry in\s+(\d+(?:\.\d+)?)s/i);
    if (plainMatch?.[1]) return Math.ceil(Number(plainMatch[1]) || 0);
    return 0;
  }
}

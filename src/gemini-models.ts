/**
 * Gemini model ladder — mirrors backend/src/config/gemini-models.ts.
 *
 * Order matters: primary first, then progressively cheaper/lighter fallbacks. Callers walk
 * the ladder when a model is quota-limited (429), overloaded (503), or retired (404).
 */
export const GEMINI_MODELS = [
  'gemini-3.6-flash',
  'gemini-2.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-2.5-flash-lite',
] as const;

/** A retired-model 404 — permanent for the process lifetime, so callers drop the model from the ladder. */
export function isModelRetiredError(error: unknown): boolean {
  const msg = String((error as { message?: string } | null)?.message ?? error ?? '');
  return (
    msg.includes('404') &&
    (msg.includes('is no longer available') ||
      msg.includes('not found') ||
      msg.includes('is not supported'))
  );
}

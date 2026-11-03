/**
 * Maps the user's vibe prompt to concrete selection signals and caption style guidance.
 * Verbatim port of SegmentAnalyzerService.buildThemeGuidance (backend/src/ai/segment-analyzer.service.ts)
 * so Video Clip selects and captions moments exactly like LiveCut / New Pack.
 *
 * One deliberate difference: keywords are word-boundary anchored. The backend matches raw
 * substrings, so "promises" hit `pro` (GAMING), "event" hit `vent` and "made" hit `mad` (RAGE),
 * "display" hit `play`, etc. — picking the wrong selection signals and caption style.
 */
export function buildThemeGuidance(prompt: string): string {
  const p = prompt.toLowerCase().trim();

  if (/\b(funny|humou?r|hilarious|comed|joke|lol|meme|lmao|roast|sarcas|cringe|absurd|ridiculous)/.test(p)) {
    return `FUNNY/HUMOR mode — you are hunting for moments that make people laugh out loud.
Target these signals in the transcript:
• Punchlines: the sentence where a joke lands or an ironic truth is revealed
• Unexpected admissions ("I have no idea what I'm doing", "that was a mistake")
• Self-deprecating lines or awkward honest confessions
• Contrast statements ("I thought X... turns out Y") where Y is embarrassing or absurd
• Over-the-top reactions, exaggerated claims, or accidental comedy
• Lines that are funny BECAUSE of how blunt, oblivious, or ironic they are
REJECT: generic statements, straight explanations, or anything that requires context to be funny.
Caption style: deliver the comedic payoff — write it like a punchline or a relatable meme caption, not a description.`;
  }

  if (/(?<![a-z])(rag(e|es|ed|ing|equit)|enrag|outrag|angry|angri|mad(?![a-z])|madness|madden|furious|frustrat|heated|triggered|annoyed|rant(s|ed|ing)?(?![a-z])|vent(s|ed|ing)?(?![a-z]))/.test(p)) {
    return `RAGE/RANT mode — find moments of raw frustration or emotional explosion.
Target these signals:
• Escalating frustration: phrases with strong emphasis, repetition, or disbelief
• "I can't believe...", "Every single time...", "Why does this always..." type statements
• Venting, calling people out, or expressing strong dissatisfaction
• The emotional peak of a rant, not the calm parts
Caption style: capture the frustration — short, punchy, relatable anger.`;
  }

  if (/\b(satisf|smooth|perfect|clean|asmr|oddly|pleasing|calming)/.test(p)) {
    return `SATISFYING mode — find moments that feel complete, smooth, or deeply pleasing.
Target these signals:
• Conclusions, reveals, or "everything coming together" moments
• Before-and-after statements, completion moments, clean explanations
• Moments of mastery, precision, or effortless execution being described
Caption style: calm, clean, and final — like the satisfying click of something falling into place.`;
  }

  if (/\b(viral|engaging|best|highlight|top moment|exciting|must.see|trending)/.test(p)) {
    return `VIRAL/HIGHLIGHTS mode — select the most quotable, shareable, high-energy moments.
Target these signals:
• Shocking reveals or surprising twists in the speech
• Quotable one-liners with broad emotional resonance
• The most unique, unexpected, or emotionally charged statements
• Moments people would screenshot or repost
Caption style: punchy and shareable — reads like a viral headline or tweet.`;
  }

  if (/\b(emotional|feel|inspir|motivat|sad|touching|powerful|moving|deep|raw(?![a-z]))|heart/.test(p)) {
    return `EMOTIONAL/INSPIRING mode — find moments of genuine vulnerability or powerful truth.
Target these signals:
• Vulnerable admissions, honest turning points, or raw personal statements
• Lines that feel universal — anyone could relate to this
• Moments of genuine breakthrough, realization, or heartfelt expression
• Avoid surface-level positivity — find the REAL moments
Caption style: sincere and resonant — should feel meaningful and human, not like marketing copy.`;
  }

  if (/(?<![a-z])(gaming|gamer|epic|fail|win(s|ner|ners|ning)?(?![a-z])|clutch|noob|pros?(?![a-z])|progamer|speedrun)|(?<!dis)play/.test(p)) {
    return `GAMING/EPIC mode — target high-energy reactions and pivotal game moments.
Target these signals:
• Big reactions, hype moments, disbelief, or trash talk
• Clutch statements, epic fail admissions, celebration lines
• Gamer vocabulary used in a funny or hype context
Caption style: hype and punchy — like a gaming clip title or Twitch highlight.`;
  }

  if (/\b(awkward|weird|uncomfortable|cringe|socially|embarrass)/.test(p)) {
    return `AWKWARD/CRINGE mode — find moments of social discomfort or secondhand embarrassment.
Target these signals:
• Uncomfortable truths, oversharing, or social missteps being described
• Moments where someone clearly regrets saying something mid-sentence
• Awkward pauses, self-corrections, or "I probably shouldn't have said that" energy
Caption style: dry and observational — capture the cringe with minimal words.`;
  }

  if (/\b(shock|surpris|reveal|twist|unexpected|plot twist|wait what|no way)/.test(p)) {
    return `SHOCKING/REVEAL mode — find the moments of maximum surprise or plot-twist energy.
Target these signals:
• The exact sentence where a reveal or unexpected fact lands
• "Wait, so..." / "Turns out..." / "Nobody told me that..." type moments
• Strong contrast between expectation and reality
Caption style: short and punchy — build the suspense, land the reveal.`;
  }

  // Generic fallback for any custom prompt
  return `CUSTOM THEME "${prompt}" — your mission is to find moments that most powerfully embody the essence of "${prompt}".
Guidelines:
• Every selected moment must obviously and directly connect to "${prompt}" — no vague or tangential picks
• Prefer moments where the connection to "${prompt}" is unmistakable even without context
• Spread selections across the video timeline; avoid clustering everything at one point
• Reject any moment that only weakly relates — high relevance over quantity
Caption style: write each caption so that someone who only sees the clip immediately understands why it fits "${prompt}".`;
}

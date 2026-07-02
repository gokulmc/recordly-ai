/**
 * Focus-area keyword extraction, shared by the crawl (to steer the reveal
 * interaction toward the requested control) and script-gen (to pin matching
 * features/elements). `focusArea` is free-form user text such as
 * "no need for theme, I want Save to Notion button to be clicked".
 *
 * We tokenize, drop stopwords, and apply light negation handling so phrases like
 * "no need for theme" / "without export" don't pin the very thing the user
 * excluded. This is a best-effort heuristic — the full text is still shown to the
 * LLM, which understands negation; these keywords only drive deterministic
 * pinning/matching as a safety net.
 */

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "to", "of", "for", "in", "on", "at", "by", "with",
  "i", "we", "you", "it", "is", "are", "be", "want", "need", "should", "would",
  "please", "can", "could", "demo", "show", "click", "clicked", "clicking", "press",
  "pressed", "button", "buttons", "feature", "features", "page", "use", "using",
  "also", "just", "make", "sure", "see", "let", "get", "go", "this", "that", "my",
  "me", "do", "does", "add", "added", "include", "included",
]);

const NEGATORS = new Set(["no", "not", "without", "skip", "dont", "don't", "never", "except", "exclude", "excluding"]);

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Extract meaningful keywords from the focus text, dropping tokens that fall
 * inside a negation window (a negator + up to the next few words, or up to a
 * clause boundary).
 */
export function extractFocusKeywords(focusArea?: string): string[] {
  if (!focusArea) return [];
  // Split into clauses so a negation in one clause doesn't suppress a later clause.
  const clauses = focusArea.split(/[,.;]|\bbut\b|\band\b/i);
  const out = new Set<string>();
  for (const clause of clauses) {
    const tokens = normalize(clause).split(" ").filter(Boolean);
    let negateUntil = -1;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]!;
      if (NEGATORS.has(t)) {
        negateUntil = i + 4; // suppress the next few words after a negator
        continue;
      }
      if (i <= negateUntil) continue;
      if (STOPWORDS.has(t)) continue;
      if (t.length < 2) continue;
      out.add(t);
    }
  }
  return [...out];
}

/** Does the given text contain any of the focus keywords? */
export function textMatchesFocus(text: string | undefined, keywords: string[]): boolean {
  if (!text || keywords.length === 0) return false;
  const hay = text.toLowerCase();
  return keywords.some((k) => hay.includes(k));
}

/** Count how many distinct focus keywords appear in the text (for ranking best match). */
export function focusMatchScore(text: string | undefined, keywords: string[]): number {
  if (!text || keywords.length === 0) return 0;
  const hay = text.toLowerCase();
  return keywords.reduce((n, k) => (hay.includes(k) ? n + 1 : n), 0);
}

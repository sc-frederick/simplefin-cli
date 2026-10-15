/**
 * Characters that hide, reorder or smuggle text past a human reader while a model still reads
 * it: every control, format (bidirectional overrides, zero-width joiners, Unicode tag
 * characters), private-use and unassigned code point, plus variation selectors and blank-looking
 * fillers. Written as escapes inside a string so the source never contains the characters.
 */
const HIDDEN_CHARACTERS = new RegExp(
  [
    "[",
    "\\p{Cc}\\p{Cf}\\p{Co}\\p{Cn}",
    // Combining grapheme joiner, Mongolian variation selectors, variation selectors 1-256.
    "\\u{34f}\\u{180b}-\\u{180f}\\u{fe00}-\\u{fe0f}\\u{e0100}-\\u{e01ef}",
    // Hangul fillers and the Braille blank, which render as nothing.
    "\\u{115f}\\u{1160}\\u{3164}\\u{ffa0}\\u{2800}",
    "]",
  ].join(""),
  "gu",
);

/** Longest bank-supplied string returned to a client; real descriptions are far shorter. */
export const MAX_TEXT_LENGTH = 300;

/**
 * Make bank-supplied or error text safe to show: hidden characters become spaces, runs of
 * whitespace collapse, and the result is trimmed and bounded.
 */
export function sanitizeText(text: string, maxLength: number = MAX_TEXT_LENGTH): string {
  const visible = text.replace(HIDDEN_CHARACTERS, " ").replace(/\s+/gu, " ").trim();

  const characters = Array.from(visible);

  // Cut on code points, never inside a surrogate pair.
  return characters.length > maxLength
    ? `${characters.slice(0, maxLength - 1).join("")}…`
    : visible;
}

/** Sanitize an optional value, keeping absence and collapsing empty text to absence. */
export function sanitizeOptionalText(text: string | null | undefined): string | null {
  if (text === null || text === undefined) return null;

  const visible = sanitizeText(text);

  return visible === "" ? null : visible;
}

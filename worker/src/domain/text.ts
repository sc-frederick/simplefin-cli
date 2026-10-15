/**
 * Control characters plus invisible formatting characters (bidirectional overrides, zero-width
 * joiners, byte-order marks) that can hide or reorder text shown to people and models. Kept as
 * code points so the source never contains the invisible characters themselves.
 */
const HIDDEN_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00, 0x1f],
  [0x7f, 0x9f],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2069],
  [0xfeff, 0xfeff],
];

const HIDDEN_CHARACTERS = new RegExp(
  `[${HIDDEN_RANGES.map(([low, high]) => `\\u{${low.toString(16)}}-\\u{${high.toString(16)}}`).join("")}]`,
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

  return visible.length > maxLength ? `${visible.slice(0, maxLength - 1)}…` : visible;
}

/** Sanitize an optional value, keeping absence and collapsing empty text to absence. */
export function sanitizeOptionalText(text: string | null | undefined): string | null {
  if (text === null || text === undefined) return null;

  const visible = sanitizeText(text);

  return visible === "" ? null : visible;
}

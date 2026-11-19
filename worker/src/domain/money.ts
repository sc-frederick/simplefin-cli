import { Result, Schema } from "effect";

/** A decimal amount the bridge cannot represent exactly in cents. */
export class InvalidAmount extends Schema.TaggedError<InvalidAmount>()("InvalidAmount", {
  message: Schema.String,
}) {}

const DECIMAL_AMOUNT = /^([+-])?(\d{1,13})(?:\.(\d{1,12}))?$/u;

/**
 * Parse a SimpleFIN decimal string such as "-12.345" into integer cents, rounding half to even
 * like Python's Decimal default so stored values match the upstream CLI.
 */
export function parseAmountCents(amount: string): Result.Result<number, InvalidAmount> {
  const match = DECIMAL_AMOUNT.exec(amount.trim());

  if (match === null) {
    return Result.fail(
      new InvalidAmount({ message: "Amounts are decimal numbers such as -12.34." }),
    );
  }

  const [, sign = "", whole = "0", fraction = ""] = match;
  const padded = fraction.padEnd(2, "0");
  const remainder = padded.slice(2);
  const truncated = Number(whole) * 100 + Number(padded.slice(0, 2));
  const half = "5".padEnd(remainder.length, "0");

  const roundsUp =
    remainder !== "" && (remainder > half || (remainder === half && truncated % 2 === 1));

  const cents = truncated + (roundsUp ? 1 : 0);

  return Result.succeed(sign === "-" && cents !== 0 ? -cents : cents);
}

/** Format integer cents as a signed two-decimal string, e.g. -1234 becomes "-12.34". */
export function formatCents(cents: number): string {
  const whole = Math.round(cents);
  const absolute = Math.abs(whole);
  const units = Math.trunc(absolute / 100);
  const remainder = String(absolute % 100).padStart(2, "0");

  return `${whole < 0 ? "-" : ""}${units}.${remainder}`;
}

/** Round to the nearest integer, ties to even, matching Python's round(). */
export function roundHalfEven(value: number): number {
  const rounded = Math.round(value);
  const isTie = Math.abs(value % 1) === 0.5;

  return isTie && rounded % 2 !== 0 ? rounded - 1 : rounded;
}

/** Format fractional cents (averages, projected costs) the way the upstream CLI does. */
export function formatFractionalCents(cents: number): string {
  return formatCents(roundHalfEven(cents));
}

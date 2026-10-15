import { Result, Schema } from "effect";
import type { Brand } from "effect";

/** Seconds since the Unix epoch, the unit SimpleFIN uses for every timestamp. */
export type EpochSeconds = number;

/** Seconds in one day. */
export const DAY = 86_400;

/** An IANA time zone name the runtime can format, such as "America/New_York". */
export type TimeZone = string & Brand.Brand<"TimeZone">;

/** A configured time zone name the runtime does not recognize. */
export class InvalidTimeZone extends Schema.TaggedError<InvalidTimeZone>()("InvalidTimeZone", {
  message: Schema.String,
}) {}

/** A date filter that is neither a calendar date, an ISO timestamp, nor a relative day count. */
export class InvalidDateFilter extends Schema.TaggedError<InvalidDateFilter>()(
  "InvalidDateFilter",
  { message: Schema.String },
) {}

/** Accept only time zones the runtime's Intl implementation can resolve. */
export function parseTimeZone(name: string): Result.Result<TimeZone, InvalidTimeZone> {
  try {
    const resolved = new Intl.DateTimeFormat("en-US", { timeZone: name }).resolvedOptions();

    // SAFETY: Intl accepted the name, which is the TimeZone invariant.
    return Result.succeed(resolved.timeZone as TimeZone);
  } catch {
    return Result.fail(
      new InvalidTimeZone({ message: `Unknown time zone ${JSON.stringify(name)}.` }),
    );
  }
}

/** Interprets calendar input and renders timestamps in one configured time zone. */
export interface Calendar {
  /** Render a timestamp like Python's isoformat(timespec="seconds"), e.g. 2026-10-15T09:30:00-04:00. */
  readonly format: (timestamp: EpochSeconds) => string;
  /** Render only the calendar date of a timestamp, e.g. 2026-10-15. */
  readonly formatDate: (timestamp: EpochSeconds) => string;
  /** Parse YYYY-MM-DD, an ISO timestamp, or a relative "30d" into a timestamp. */
  readonly parseFilter: (
    value: string,
    now: EpochSeconds,
  ) => Result.Result<EpochSeconds, InvalidDateFilter>;
}

const RELATIVE_DAYS = /^(\d{1,5})d$/u;

const ISO_INPUT =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?)?$/u;

const OFFSET = /^GMT(?:([+-])(\d{2}):(\d{2}))?$/u;

interface ZonedParts {
  readonly date: string;
  readonly time: string;
  readonly offsetMinutes: number;
}

/** Build a calendar for one validated time zone. */
export function calendarFor(timeZone: TimeZone): Calendar {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longOffset",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });

  const zonedParts = (milliseconds: number): ZonedParts => {
    const parts = new Map(
      formatter.formatToParts(milliseconds).map((part) => [part.type, part.value]),
    );

    const offset = OFFSET.exec(parts.get("timeZoneName") ?? "GMT");
    const [, sign = "+", hours = "00", minutes = "00"] = offset ?? [];
    const magnitude = Number(hours) * 60 + Number(minutes);

    return {
      date: `${parts.get("year")}-${parts.get("month")}-${parts.get("day")}`,
      time: `${parts.get("hour")}:${parts.get("minute")}:${parts.get("second")}`,
      offsetMinutes: sign === "-" ? -magnitude : magnitude,
    };
  };

  /** Convert a wall-clock time in this zone to UTC, resolving DST gaps forward. */
  const fromWallClock = (wallClockAsUtc: number): number => {
    const firstGuess = wallClockAsUtc - zonedParts(wallClockAsUtc).offsetMinutes * 60_000;
    const corrected = wallClockAsUtc - zonedParts(firstGuess).offsetMinutes * 60_000;

    return corrected;
  };

  const format = (timestamp: EpochSeconds): string => {
    // Out-of-range values are rejected at ingest; never let one throw while rendering a result.
    if (!Number.isFinite(timestamp) || Math.abs(timestamp) > 8.64e12) return "invalid date";

    const parts = zonedParts(timestamp * 1000);
    const sign = parts.offsetMinutes < 0 ? "-" : "+";
    const magnitude = Math.abs(parts.offsetMinutes);
    const hours = String(Math.trunc(magnitude / 60)).padStart(2, "0");
    const minutes = String(magnitude % 60).padStart(2, "0");

    return `${parts.date}T${parts.time}${sign}${hours}:${minutes}`;
  };

  const invalid = (value: string) =>
    Result.fail(
      new InvalidDateFilter({
        message: `Invalid date ${JSON.stringify(value.slice(0, 40))}: use YYYY-MM-DD or e.g. 30d.`,
      }),
    );

  const parseFilter = (value: string, now: EpochSeconds) => {
    const text = value.trim();
    const relative = RELATIVE_DAYS.exec(text);

    if (relative !== null) return Result.succeed(now - Number(relative[1]) * DAY);

    const iso = ISO_INPUT.exec(text);

    if (iso === null) return invalid(value);

    const [, year, month, day, hour = "00", minute = "00", second = "00", zone] = iso;

    const wallClock = Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
    );

    const check = new Date(wallClock);

    if (
      check.getUTCFullYear() !== Number(year) ||
      check.getUTCMonth() !== Number(month) - 1 ||
      check.getUTCDate() !== Number(day) ||
      Number(hour) > 23 ||
      Number(minute) > 59 ||
      Number(second) > 59
    ) {
      return invalid(value);
    }

    if (zone === undefined) return Result.succeed(Math.floor(fromWallClock(wallClock) / 1000));

    const zoneMatch = /^([+-])(\d{2}):?(\d{2})$/u.exec(zone);
    const [, sign = "+", hours = "00", minutes = "00"] = zoneMatch ?? [];
    const offset = (Number(hours) * 60 + Number(minutes)) * (sign === "-" ? -1 : 1);

    return Result.succeed(Math.floor((wallClock - offset * 60_000) / 1000));
  };

  return {
    format,
    formatDate: (timestamp) => format(timestamp).slice(0, 10),
    parseFilter,
  };
}

import type { EpochSeconds } from "./dates.ts";
import { DAY } from "./dates.ts";

/** Days re-fetched before the last complete sync, so late-posting transactions are caught. */
export const OVERLAP_DAYS = 5;

/** Days per request. The Bridge allows 90 but warns above 45 and says it may cap there. */
export const WINDOW_DAYS = 45;

/** Local request budget. The Bridge expects at most ~24 a day and disables tokens that keep exceeding it. */
export const DAILY_BUDGET = 20;

/**
 * Minimum gap between automatic attempts, so failures can never burn the quota: at most eight
 * automatic attempts a day.
 */
export const AUTO_SYNC_RETRY_SECONDS = 3 * 3600;

/** Backoff after the Bridge revokes access or asks for payment; neither fixes itself. */
export const BLOCKED_RETRY_SECONDS = DAY;

/** Manual syncs are refused within this long after a successful one; the Bridge refreshes about daily. */
export const MIN_MANUAL_SYNC_SECONDS = 3600;

/** Manual syncs are refused while another attempt started this recently. */
export const RECENT_ATTEMPT_SECONDS = 600;

/** One request's half-open time range, [start, end). */
export interface SyncWindow {
  readonly start: EpochSeconds;
  readonly end: EpochSeconds;
}

/** When earlier syncs finished, as recorded in the sync history. */
export interface SyncHistory {
  /** Finish time of the last successful sync, complete or not. */
  readonly lastSuccess: EpochSeconds | null;
  /** Finish time of the last successful sync with no account or connection errors. */
  readonly lastComplete: EpochSeconds | null;
}

/**
 * Plan request windows, newest first. The first successful sync backfills `initialDays`. Later
 * syncs resume from the last complete sync, so gaps get re-fetched, but never reach back more
 * than two windows; without any complete sync they fetch one window, as the upstream CLI does.
 */
export function planWindows(
  now: EpochSeconds,
  history: SyncHistory,
  initialDays: number,
): ReadonlyArray<SyncWindow> {
  const end = now + DAY;

  const start =
    history.lastComplete !== null
      ? Math.max(history.lastComplete - OVERLAP_DAYS * DAY, end - 2 * WINDOW_DAYS * DAY)
      : history.lastSuccess !== null
        ? end - WINDOW_DAYS * DAY
        : now - initialDays * DAY;

  const windows: Array<SyncWindow> = [];

  for (let cursor = end; cursor > start;) {
    const windowStart = Math.max(start, cursor - WINDOW_DAYS * DAY);

    windows.push({ start: windowStart, end: cursor });
    cursor = windowStart;
  }

  return windows;
}

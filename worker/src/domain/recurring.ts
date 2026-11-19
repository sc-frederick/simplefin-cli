import type { Calendar, EpochSeconds } from "./dates.ts";
import { DAY } from "./dates.ts";
import { formatFractionalCents } from "./money.ts";
import { isCardPresent, isTransfer, merchantKey } from "./merchants.ts";

/** A posted transaction as recurring detection and merchant rollups read it. */
export interface LedgerEntry {
  readonly description: string;
  readonly payee: string | null;
  readonly amountCents: number;
  readonly date: EpochSeconds;
  readonly account: string;
}

/** One charge series that repeats on a regular cadence. */
export interface RecurringSeries {
  readonly merchant: string;
  readonly direction: "in" | "out";
  readonly kind: "subscription" | "bill" | "installment plan fee";
  readonly cadence: CadenceName;
  readonly typical_amount: string;
  readonly amount_varies: boolean;
  readonly monthly_cost: string;
  readonly yearly_cost: string;
  readonly occurrences: number;
  readonly first_seen: string;
  readonly last_charged: string;
  readonly next_expected: string;
  readonly status: "active" | "possibly cancelled";
  readonly confidence: "high" | "medium" | "low";
  readonly accounts: ReadonlyArray<string>;
  readonly example: string;
}

/** The find_recurring_charges result, including totals over active outflows. */
export interface RecurringReport {
  readonly recurring: ReadonlyArray<RecurringSeries>;
  readonly active_monthly_total: string;
  readonly active_yearly_total: string;
  readonly history_from: string | null;
  readonly note: string;
}

/** Options for recurring detection, mirroring the upstream tool parameters. */
export interface RecurringOptions {
  readonly minOccurrences: number;
  readonly includeInactive: boolean;
  readonly includeIncome: boolean;
}

/** Spending at one normalized merchant. */
export interface MerchantSpending {
  readonly merchant: string;
  readonly spent: string;
  readonly transactions: number;
  readonly average: string;
  readonly accounts: ReadonlyArray<string>;
}

type CadenceName = "weekly" | "biweekly" | "monthly" | "quarterly" | "yearly";

interface Cadence {
  readonly name: CadenceName;
  readonly nominalDays: number;
  readonly low: number;
  readonly high: number;
}

/** Cadence name, nominal days, and the accepted interval range in days. */
const CADENCES: ReadonlyArray<Cadence> = [
  { name: "weekly", nominalDays: 7, low: 5, high: 9 },
  { name: "biweekly", nominalDays: 14, low: 12, high: 17 },
  { name: "monthly", nominalDays: 30.44, low: 25, high: 36 },
  { name: "quarterly", nominalDays: 91.3, low: 80, high: 100 },
  { name: "yearly", nominalDays: 365.25, low: 340, high: 390 },
];

type Hit = Omit<RecurringSeries, "merchant" | "direction">;

function median(values: ReadonlyArray<number>): number {
  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;

  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function mean(values: ReadonlyArray<number>): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Population standard deviation, like Python's statistics.pstdev. */
function populationDeviation(values: ReadonlyArray<number>): number {
  const average = mean(values);

  return Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
}

function cadenceFor(intervals: ReadonlyArray<number>): Cadence | undefined {
  const typical = median(intervals);

  for (const cadence of CADENCES) {
    if (typical < cadence.low || typical > cadence.high) continue;

    const inBand = intervals.filter((days) => days >= cadence.low && days <= cadence.high).length;

    // Allow one skipped or doubled period when there's enough data.
    if (inBand >= Math.max(1, intervals.length - 1) || inBand / intervals.length >= 0.75) {
      return cadence;
    }
  }

  return undefined;
}

/** Group charges whose amounts are within 2% (min 50 cents) of each other. */
function fixedBuckets(charges: ReadonlyArray<LedgerEntry>): Array<Array<LedgerEntry>> {
  const ordered = charges.toSorted(
    (left, right) => Math.abs(left.amountCents) - Math.abs(right.amountCents),
  );

  const buckets: Array<Array<LedgerEntry>> = [];

  for (const charge of ordered) {
    const amount = Math.abs(charge.amountCents);
    const current = buckets.at(-1);
    const anchor = Math.abs(current?.[0]?.amountCents ?? 0);

    if (current !== undefined && amount - anchor <= Math.max(50, anchor * 0.02)) {
      current.push(charge);
    } else {
      buckets.push([charge]);
    }
  }

  return buckets.filter((bucket) => bucket.length >= 2);
}

function latest(entries: ReadonlyArray<LedgerEntry>): LedgerEntry | undefined {
  let found: LedgerEntry | undefined;

  for (const entry of entries) if (found === undefined || entry.date > found.date) found = entry;

  return found;
}

function evaluate(
  matched: ReadonlyArray<LedgerEntry>,
  charges: ReadonlyArray<LedgerEntry>,
  context: {
    readonly now: EpochSeconds;
    readonly minOccurrences: number;
    readonly fixed: boolean;
    readonly calendar: Calendar;
  },
): Hit | undefined {
  const required = Math.max(2, context.minOccurrences);

  if (matched.length < required) return undefined;

  const amounts = matched.map((charge) => Math.abs(charge.amountCents));
  const average = mean(amounts);
  const variation = average === 0 ? 1 : populationDeviation(amounts) / average;

  // Collapse same-day duplicates (split charges) before measuring intervals.
  const days = [...new Set(matched.map((charge) => Math.floor(charge.date / DAY)))].toSorted(
    (left, right) => left - right,
  );

  const occurrences = days.length;

  if (occurrences < required) return undefined;

  const cadence = cadenceFor(days.slice(1).map((day, index) => day - (days[index] ?? day)));

  if (cadence === undefined) return undefined;

  const frequent = cadence.name === "weekly" || cadence.name === "biweekly";

  // Two visits a week apart is a habit, not a subscription.
  if (frequent && (occurrences < 3 || variation > 0.12)) return undefined;

  // Tap-to-pay purchases are shopping unless identical and monthly or longer (a membership paid
  // in person). A loose cluster at a merchant that mostly charges other amounts is too.
  const cardPresent = matched.every((charge) => isCardPresent(charge.description));
  const mostlyOther = !context.fixed && matched.length / charges.length < 0.6;

  if ((cardPresent || mostlyOther) && !(occurrences >= 3 && variation <= 0.02 && !frequent)) {
    return undefined;
  }

  const newest = latest(matched);

  if (newest === undefined) return undefined;

  const first = Math.min(...matched.map((charge) => charge.date));
  const nextExpected = newest.date + cadence.nominalDays * DAY;
  const active = (context.now - nextExpected) / DAY <= Math.max(7, cadence.nominalDays * 0.5);
  const typical = median(amounts);

  const confidence =
    occurrences >= 3 && variation <= 0.05
      ? "high"
      : occurrences >= 3 || variation <= 0.02
        ? "medium"
        : "low";

  const kind = newest.description.toUpperCase().startsWith("PLAN FEE")
    ? "installment plan fee"
    : variation > 0.05
      ? "bill"
      : "subscription";

  return {
    kind,
    cadence: cadence.name,
    typical_amount: formatFractionalCents(typical),
    amount_varies: variation > 0.05,
    monthly_cost: formatFractionalCents((typical * 30.44) / cadence.nominalDays),
    yearly_cost: formatFractionalCents((typical * 365.25) / cadence.nominalDays),
    occurrences,
    first_seen: context.calendar.formatDate(Math.trunc(first)),
    last_charged: context.calendar.formatDate(Math.trunc(newest.date)),
    next_expected: context.calendar.formatDate(Math.trunc(nextExpected)),
    status: active ? "active" : "possibly cancelled",
    confidence,
    accounts: [...new Set(matched.map((charge) => charge.account))].toSorted(),
    example: newest.description,
  };
}

/**
 * Detect charges that repeat on a regular cadence with a consistent amount.
 * Entries must be posted transactions ordered by date.
 */
export function findRecurring(
  entries: ReadonlyArray<LedgerEntry>,
  options: RecurringOptions,
  context: {
    readonly now: EpochSeconds;
    readonly calendar: Calendar;
    readonly historyFrom: EpochSeconds | null;
  },
): RecurringReport {
  const groups = new Map<
    string,
    { merchant: string; direction: "in" | "out"; charges: Array<LedgerEntry> }
  >();

  for (const entry of entries) {
    if (
      entry.amountCents === 0 ||
      (entry.amountCents > 0 && !options.includeIncome) ||
      isTransfer(entry.description, entry.payee)
    ) {
      continue;
    }

    const direction = entry.amountCents < 0 ? "out" : "in";

    const merchant = merchantKey(
      entry.payee === null || entry.payee === "" ? entry.description : entry.payee,
    );

    const key = `${direction}\u0000${merchant}`;
    const group = groups.get(key);

    if (group === undefined) groups.set(key, { merchant, direction, charges: [entry] });
    else group.charges.push(entry);
  }

  const results: Array<RecurringSeries> = [];

  const evaluation = {
    now: context.now,
    minOccurrences: options.minOccurrences,
    calendar: context.calendar,
  };

  for (const { merchant, direction, charges } of groups.values()) {
    if (charges.length < Math.max(2, options.minOccurrences)) continue;

    // First look for exact-price series (one merchant can bill several subscriptions, e.g. Apple
    // or Google); fall back to a looser cluster for bills that vary (utilities, phone).
    const found: Array<Hit> = [];

    for (const bucket of fixedBuckets(charges)) {
      const hit = evaluate(bucket, charges, { ...evaluation, fixed: true });

      if (hit !== undefined) found.push(hit);
    }

    if (found.length === 0) {
      const typical = median(charges.map((charge) => Math.abs(charge.amountCents)));
      const tolerance = Math.max(200, typical * 0.15);

      const cluster = charges.filter(
        (charge) => Math.abs(Math.abs(charge.amountCents) - typical) <= tolerance,
      );

      const hit = evaluate(cluster, charges, { ...evaluation, fixed: false });

      if (hit !== undefined) found.push(hit);
    }

    for (const hit of found) {
      if (hit.status !== "active" && !options.includeInactive) continue;

      results.push({
        merchant: found.length === 1 ? merchant : `${merchant} (${hit.typical_amount})`,
        direction,
        ...hit,
      });
    }
  }

  const ranked = results.toSorted(
    (left, right) => Number(right.monthly_cost) - Number(left.monthly_cost),
  );

  const outflows = ranked.filter(
    (series) => series.direction === "out" && series.status === "active",
  );

  return {
    recurring: ranked,
    active_monthly_total: formatFractionalCents(
      outflows.reduce((sum, series) => sum + Number(series.monthly_cost) * 100, 0),
    ),
    active_yearly_total: formatFractionalCents(
      outflows.reduce((sum, series) => sum + Number(series.yearly_cost) * 100, 0),
    ),
    history_from:
      context.historyFrom === null ? null : context.calendar.formatDate(context.historyFrom),
    note: "Yearly and quarterly charges need history longer than one period to be detected.",
  };
}

/**
 * Spending (outflows, excluding transfers unless requested) grouped by normalized merchant,
 * largest first. Entries must be posted transactions.
 */
export function topMerchants(
  entries: ReadonlyArray<LedgerEntry>,
  options: { readonly limit: number; readonly includeTransfers: boolean },
): Array<MerchantSpending> {
  const totals = new Map<string, { cents: number; transactions: number; accounts: Set<string> }>();

  for (const entry of entries) {
    if (
      entry.amountCents >= 0 ||
      (!options.includeTransfers && isTransfer(entry.description, entry.payee))
    ) {
      continue;
    }

    const merchant = merchantKey(
      entry.payee === null || entry.payee === "" ? entry.description : entry.payee,
    );

    const total = totals.get(merchant) ?? {
      cents: 0,
      transactions: 0,
      accounts: new Set<string>(),
    };

    total.cents -= entry.amountCents;
    total.transactions += 1;
    total.accounts.add(entry.account);
    totals.set(merchant, total);
  }

  return [...totals.entries()]
    .toSorted(([, left], [, right]) => right.cents - left.cents)
    .slice(0, Math.max(1, options.limit))
    .map(([merchant, total]) => ({
      merchant,
      spent: formatFractionalCents(total.cents),
      transactions: total.transactions,
      average: formatFractionalCents(total.cents / total.transactions),
      accounts: [...total.accounts].toSorted(),
    }));
}

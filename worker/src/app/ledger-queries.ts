import { Clock, Context, Effect, Layer, Result } from "effect";
import type { EpochSeconds, InvalidDateFilter } from "../domain/dates.ts";
import type { InvalidAmount } from "../domain/money.ts";
import { formatCents, parseAmountCents } from "../domain/money.ts";
import type { MerchantSpending, RecurringReport } from "../domain/recurring.ts";
import { findRecurring, topMerchants } from "../domain/recurring.ts";
import type { StorageError } from "../store/ledger-store.ts";
import { LedgerStore } from "../store/ledger-store.ts";
import { BridgeSettings } from "./sync-service.ts";

/** An account as list_accounts returns it. */
export interface AccountView {
  readonly id: string;
  readonly name: string;
  readonly institution: string | null;
  readonly connection: string | null;
  readonly currency: string | null;
  readonly balance: string | null;
  readonly available_balance: string | null;
  readonly balance_date: string | null;
}

/** A transaction as list_transactions returns it. */
export interface TransactionView {
  readonly date: string;
  readonly account: string | null;
  readonly account_id: string;
  readonly id: string;
  readonly amount: string;
  readonly currency: string | null;
  readonly description: string;
  readonly payee: string | null;
  readonly memo: string | null;
  readonly pending: boolean;
}

/** Inputs for list_transactions after schema decoding. */
export interface TransactionsInput {
  readonly account: string | null;
  readonly since: string | null;
  readonly until: string | null;
  readonly search: string | null;
  readonly minAmount: string | null;
  readonly maxAmount: string | null;
  readonly pending: boolean | null;
  readonly limit: number;
}

/** A period over all accounts or the accounts matching `account`. */
export interface PeriodInput {
  readonly account: string | null;
  readonly since: string | null;
  readonly until: string | null;
}

/** Failures a read tool can report back to the caller. */
export type QueryError = StorageError | InvalidDateFilter | InvalidAmount;

/** Read-only views over the synced ledger, with dates rendered in the configured time zone. */
export class LedgerQueries extends Context.Service<
  LedgerQueries,
  {
    readonly accounts: Effect.Effect<
      { readonly accounts: ReadonlyArray<AccountView> },
      StorageError
    >;
    readonly transactions: (
      input: TransactionsInput,
    ) => Effect.Effect<{ readonly transactions: ReadonlyArray<TransactionView> }, QueryError>;
    readonly balanceHistory: (input: {
      readonly account: string;
      readonly since: string | null;
    }) => Effect.Effect<
      {
        readonly balances: ReadonlyArray<{
          readonly account: string;
          readonly date: string;
          readonly balance: string;
          readonly available_balance: string | null;
        }>;
      },
      QueryError
    >;
    readonly cashFlow: (input: PeriodInput) => Effect.Effect<
      {
        readonly since: string | null;
        readonly until: string | null;
        readonly accounts: ReadonlyArray<{
          readonly account: string;
          readonly currency: string | null;
          readonly transactions: number;
          readonly money_in: string;
          readonly money_out: string;
        }>;
      },
      QueryError
    >;
    readonly recurring: (input: {
      readonly since: string | null;
      readonly minOccurrences: number;
      readonly includeInactive: boolean;
      readonly includeIncome: boolean;
    }) => Effect.Effect<RecurringReport, QueryError>;
    readonly topMerchants: (input: {
      readonly since: string | null;
      readonly until: string | null;
      readonly limit: number;
      readonly includeTransfers: boolean;
    }) => Effect.Effect<
      {
        readonly since: string | null;
        readonly until: string | null;
        readonly merchants: ReadonlyArray<MerchantSpending>;
      },
      QueryError
    >;
  }
>()("simplefin/LedgerQueries") {
  /** Wire queries to storage and the configured calendar. */
  static readonly layer = Layer.effect(
    LedgerQueries,
    Effect.gen(function* () {
      const store = yield* LedgerStore;
      const { calendar } = yield* BridgeSettings;
      const now = Clock.currentTimeMillis.pipe(Effect.map((ms) => Math.floor(ms / 1000)));

      const parseDate = (value: string | null) =>
        Effect.gen(function* () {
          if (value === null) return null;

          const parsed = calendar.parseFilter(value, yield* now);

          return Result.isFailure(parsed) ? yield* parsed.failure : parsed.success;
        });

      const parseCents = (value: string | null) =>
        Effect.gen(function* () {
          if (value === null) return null;

          const parsed = parseAmountCents(value);

          return Result.isFailure(parsed) ? yield* parsed.failure : parsed.success;
        });

      /** `null` means every account; an empty list means nothing matched. */
      const resolveAccounts = (account: string | null) =>
        account === null ? Effect.succeed(null) : store.resolveAccountIds(account);

      const formatOptional = (timestamp: EpochSeconds | null) =>
        timestamp === null ? null : calendar.format(timestamp);

      return LedgerQueries.of({
        accounts: store.accounts.pipe(
          Effect.map((rows) => ({
            accounts: rows.map((row) => ({
              id: row.id,
              name: row.name,
              institution: row.institution,
              connection: row.connection,
              currency: row.currency,
              balance: row.balance,
              available_balance: row.available_balance,
              balance_date: formatOptional(row.balance_date),
            })),
          })),
        ),

        transactions: (input) =>
          Effect.gen(function* () {
            const accountIds = yield* resolveAccounts(input.account);

            if (accountIds !== null && accountIds.length === 0) return { transactions: [] };

            const rows = yield* store.transactions({
              accountIds,
              since: yield* parseDate(input.since),
              until: yield* parseDate(input.until),
              search: input.search,
              minCents: yield* parseCents(input.minAmount),
              maxCents: yield* parseCents(input.maxAmount),
              pending: input.pending,
              limit: input.limit,
            });

            return {
              transactions: rows.map((row) => ({
                date: calendar.format(row.date),
                account: row.account_name,
                account_id: row.account_id,
                id: row.id,
                amount: row.amount,
                currency: row.currency,
                description: row.description,
                payee: row.payee,
                memo: row.memo,
                pending: row.pending === 1,
              })),
            };
          }),

        balanceHistory: (input) =>
          Effect.gen(function* () {
            const accountIds = yield* resolveAccounts(input.account);

            if (accountIds === null || accountIds.length === 0) return { balances: [] };

            const rows = yield* store.balanceHistory(
              accountIds,
              (yield* parseDate(input.since)) ?? 0,
            );

            return {
              balances: rows.map((row) => ({
                account: row.name,
                date: calendar.format(row.balance_date),
                balance: row.balance,
                available_balance: row.available_balance,
              })),
            };
          }),

        cashFlow: (input) =>
          Effect.gen(function* () {
            const since = yield* parseDate(input.since);
            const until = yield* parseDate(input.until);
            const accountIds = yield* resolveAccounts(input.account);
            const period = { since: formatOptional(since), until: formatOptional(until) };

            if (accountIds !== null && accountIds.length === 0) return { ...period, accounts: [] };

            const rows = yield* store.cashFlow({ accountIds, since, until });

            return {
              ...period,
              accounts: rows.map((row) => ({
                account: row.name,
                currency: row.currency,
                transactions: row.n,
                money_in: formatCents(row.money_in ?? 0),
                money_out: formatCents(row.money_out ?? 0),
              })),
            };
          }),

        recurring: (input) =>
          Effect.gen(function* () {
            const since = yield* parseDate(input.since);
            const entries = yield* store.postedEntries({ accountIds: null, since, until: null });

            return findRecurring(
              entries,
              {
                minOccurrences: input.minOccurrences,
                includeInactive: input.includeInactive,
                includeIncome: input.includeIncome,
              },
              { now: yield* now, calendar, historyFrom: yield* store.earliestTransaction },
            );
          }),

        topMerchants: (input) =>
          Effect.gen(function* () {
            const since = yield* parseDate(input.since);
            const until = yield* parseDate(input.until);
            const entries = yield* store.postedEntries({ accountIds: null, since, until });

            return {
              since: formatOptional(since),
              until: formatOptional(until),
              merchants: topMerchants(entries, {
                limit: input.limit,
                includeTransfers: input.includeTransfers,
              }),
            };
          }),
      });
    }),
  );
}

import { Clock, Context, Effect, Layer, Match, Schema } from "effect";
import type { SchemaError } from "effect/Schema";
import type { SqlError } from "effect/sql/SqlError";
import { SqlClient } from "effect/sql";
import type { EpochSeconds } from "../domain/dates.ts";
import type { LedgerEntry } from "../domain/recurring.ts";
import type { GapRetry, SyncHistory, SyncWindow } from "../domain/sync-plan.ts";
import { mergeWindows, subtractWindow } from "../domain/sync-plan.ts";
import type { Account, AccountSet } from "../simplefin/account-set.ts";
import { accountRef } from "../simplefin/account-set.ts";
import { migrate } from "./migrations.ts";

/** A storage failure, safe to show: it names the operation, never the data. */
export class StorageError extends Schema.TaggedError<StorageError>()("StorageError", {
  operation: Schema.String,
  message: Schema.String,
}) {}

/** Transaction query filters, already parsed from tool input. */
export interface TransactionFilter {
  /** Restrict to the accounts this names (see {@link LedgerStore}); `null` means every account. */
  readonly account: string | null;
  readonly since: EpochSeconds | null;
  readonly until: EpochSeconds | null;
  readonly search: string | null;
  readonly minCents: number | null;
  readonly maxCents: number | null;
  readonly pending: boolean | null;
  readonly limit: number;
}

/** Period filters shared by cash-flow and merchant rollups. */
export interface PeriodFilter {
  readonly account: string | null;
  readonly since: EpochSeconds | null;
  readonly until: EpochSeconds | null;
}

const NullableText = Schema.NullOr(Schema.String);
const NullableInt = Schema.NullOr(Schema.Int);

/** An account row joined with its connection. */
export const AccountRow = Schema.Struct({
  id: Schema.String,
  ref: Schema.String,
  name: Schema.String,
  institution: NullableText,
  connection: NullableText,
  currency: NullableText,
  balance: NullableText,
  available_balance: NullableText,
  balance_date: NullableInt,
});

/** An account row joined with its connection. */
export type AccountRow = typeof AccountRow.Type;

/** A transaction row with its account name and effective date. */
export const TransactionRow = Schema.Struct({
  date: Schema.Int,
  account_id: Schema.String,
  account_ref: NullableText,
  account_name: NullableText,
  currency: NullableText,
  id: Schema.String,
  amount: Schema.String,
  description: Schema.String,
  payee: NullableText,
  memo: NullableText,
  pending: Schema.Int,
});

/** A transaction row with its account name and effective date. */
export type TransactionRow = typeof TransactionRow.Type;

/** One recorded balance. */
export const BalanceRow = Schema.Struct({
  name: Schema.String,
  balance_date: Schema.Int,
  balance: Schema.String,
  available_balance: NullableText,
});

/** One recorded balance. */
export type BalanceRow = typeof BalanceRow.Type;

/** Money in and out of one account over a period. */
export const CashFlowRow = Schema.Struct({
  name: Schema.String,
  currency: NullableText,
  n: Schema.Int,
  money_in: NullableInt,
  money_out: NullableInt,
});

/** Money in and out of one account over a period. */
export type CashFlowRow = typeof CashFlowRow.Type;

/** One sync attempt. */
export const SyncRunRow = Schema.Struct({
  id: Schema.Int,
  started_at: Schema.Int,
  finished_at: NullableInt,
  window_start: NullableInt,
  window_end: NullableInt,
  ok: Schema.Int,
  complete: Schema.Int,
  accounts: NullableInt,
  transactions_new: NullableInt,
  transactions_updated: NullableInt,
  errors: NullableText,
});

/** One sync attempt. */
export type SyncRunRow = typeof SyncRunRow.Type;

const EntryRow = Schema.Struct({
  description: Schema.String,
  payee: NullableText,
  amount_cents: Schema.Int,
  date: Schema.Int,
  account: Schema.String,
});

const IdRow = Schema.Struct({ id: Schema.String });
const GapRow = Schema.Struct({ window_start: Schema.Int, window_end: Schema.Int });

const GapRetryRow = Schema.Struct({
  window_start: Schema.Int,
  failures: Schema.Int,
  last_attempt: Schema.Int,
});

const CountRow = Schema.Struct({ n: Schema.Int });
const ValueRow = Schema.Struct({ value: Schema.NullOr(Schema.Union([Schema.Int, Schema.String])) });
const EarliestRow = Schema.Struct({ earliest: NullableInt });
const FinishedRow = Schema.Struct({ finished: NullableInt });
const InsertedRow = Schema.Struct({ id: Schema.Int });

/**
 * Most ids one prune statement binds. They go in as one JSON value, and 50 ids of up to 512
 * characters stay far below SQLite's limit on one value even when every character is escaped.
 */
const PRUNE_BATCH = 50;

/** Upsert counts for one stored response. */
export interface StoredCounts {
  readonly new: number;
  readonly updated: number;
}

/** Persistence for synced accounts, transactions, request accounting and sync bookkeeping. */
export class LedgerStore extends Context.Service<
  LedgerStore,
  {
    readonly migrate: Effect.Effect<void, StorageError>;
    /**
     * Store one response for `window` and update the recorded gaps in the same transaction: an
     * incomplete response adds the window, a complete one clears it.
     */
    readonly storeAccountSet: (
      set: AccountSet,
      window: SyncWindow,
    ) => Effect.Effect<StoredCounts, StorageError>;
    readonly beginRequest: Effect.Effect<number, StorageError>;
    readonly finishRequest: (
      id: number,
      ok: boolean,
      note: string,
    ) => Effect.Effect<void, StorageError>;
    readonly requestsSince: (since: EpochSeconds) => Effect.Effect<number, StorageError>;
    readonly claimLease: (minGapSeconds: number) => Effect.Effect<boolean, StorageError>;
    /** Move the lease forward to `value`; it never moves back, so backoff can't be shortened. */
    readonly raiseLease: (value: EpochSeconds) => Effect.Effect<void, StorageError>;
    /** Clear the lease; only a new claim does this. */
    readonly resetLease: Effect.Effect<void, StorageError>;
    readonly leaseValue: Effect.Effect<EpochSeconds, StorageError>;
    readonly readSetting: (key: string) => Effect.Effect<string | null, StorageError>;
    readonly writeSetting: (key: string, value: string) => Effect.Effect<void, StorageError>;
    readonly startRun: (window: SyncWindow) => Effect.Effect<number, StorageError>;
    readonly finishRun: (
      id: number,
      outcome:
        | {
            readonly ok: true;
            readonly complete: boolean;
            readonly accounts: number;
            readonly counts: StoredCounts;
            readonly errors: ReadonlyArray<string>;
          }
        | { readonly ok: false; readonly errors: ReadonlyArray<string> },
    ) => Effect.Effect<void, StorageError>;
    readonly history: Effect.Effect<SyncHistory, StorageError>;
    /** Ranges whose last fetch was incomplete, merged and oldest first. */
    readonly gaps: Effect.Effect<ReadonlyArray<SyncWindow>, StorageError>;
    /** Retry history of gap windows that are still incomplete. */
    readonly gapRetries: Effect.Effect<ReadonlyArray<GapRetry>, StorageError>;
    /**
     * Record a retry of `window` before sending it, as a failure until a complete response
     * clears the window. A retry that fails outright then backs off like an incomplete one.
     */
    readonly noteGapRetry: (
      window: SyncWindow,
      at: EpochSeconds,
    ) => Effect.Effect<void, StorageError>;
    readonly lastSuccessfulRun: Effect.Effect<SyncRunRow | null, StorageError>;
    readonly lastAttempt: Effect.Effect<SyncRunRow | null, StorageError>;
    readonly counts: Effect.Effect<
      { readonly accounts: number; readonly transactions: number },
      StorageError
    >;
    readonly accounts: Effect.Effect<ReadonlyArray<AccountRow>, StorageError>;
    readonly transactions: (
      filter: TransactionFilter,
    ) => Effect.Effect<ReadonlyArray<TransactionRow>, StorageError>;
    readonly balanceHistory: (
      account: string,
      since: EpochSeconds,
    ) => Effect.Effect<ReadonlyArray<BalanceRow>, StorageError>;
    readonly cashFlow: (
      filter: PeriodFilter,
    ) => Effect.Effect<ReadonlyArray<CashFlowRow>, StorageError>;
    readonly postedEntries: (
      filter: PeriodFilter,
    ) => Effect.Effect<ReadonlyArray<LedgerEntry>, StorageError>;
    readonly earliestTransaction: Effect.Effect<EpochSeconds | null, StorageError>;
  }
>()("simplefin/LedgerStore") {
  /** SQLite adapter over Effect SQL; works on Durable Object storage and on node:sqlite in tests. */
  static readonly layer = Layer.effect(
    LedgerStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const txDate = sql.literal("COALESCE(NULLIF(t.posted, 0), t.transacted_at, t.first_seen)");
      const ownTxDate = sql.literal("COALESCE(NULLIF(posted, 0), transacted_at, first_seen)");
      const now = Clock.currentTimeMillis.pipe(Effect.map((ms) => Math.floor(ms / 1000)));

      /**
       * Log why storage failed, then replace the error with a safe one. SQLite messages name
       * limits and constraints, never bound values; schema errors can quote row data, so only
       * their tag is logged.
       */
      const guard =
        (operation: string) =>
        <A, R>(effect: Effect.Effect<A, SqlError | SchemaError | StorageError, R>) =>
          effect.pipe(
            Effect.tapError((error) => {
              const detail = Match.value(error).pipe(
                Match.tag("SqlError", ({ reason }) =>
                  reason.cause instanceof Error ? reason.cause.message.slice(0, 200) : reason._tag,
                ),
                Match.orElse(({ _tag }) => _tag),
              );

              return Effect.logError("Storage operation failed").pipe(
                Effect.annotateLogs({ operation, detail }),
              );
            }),
            Effect.mapError(
              () => new StorageError({ operation, message: `Storage failed during ${operation}.` }),
            ),
          );

      /**
       * Bind a list as one JSON parameter: Durable Object SQLite allows only 100 bound parameters.
       * Callers keep the list short, since SQLite also caps the size of one bound value.
       */
      const jsonList = (values: ReadonlyArray<string>) =>
        sql`(SELECT value FROM json_each(${JSON.stringify(values)}))`;

      const decodeRows =
        <S extends Schema.Top>(schema: S) =>
        (rows: ReadonlyArray<object>) =>
          Schema.decodeUnknownEffect(Schema.Array(schema))(rows);

      const firstOrNull = <A>(rows: ReadonlyArray<A>): A | null => rows[0] ?? null;

      const readGaps =
        sql`SELECT window_start, window_end FROM sync_gaps ORDER BY window_start`.pipe(
          Effect.flatMap(decodeRows(GapRow)),
          Effect.map((rows) =>
            rows.map((row) => ({ start: row.window_start, end: row.window_end })),
          ),
        );

      // Refs are hashed before the transaction opens, so it never waits on anything but SQLite.
      const storeAccountSet = (set: AccountSet, window: SyncWindow) =>
        Effect.forEach(set.accounts, (account) =>
          Effect.promise(() => accountRef(account.id)).pipe(
            Effect.map((ref) => ({ account, ref })),
          ),
        ).pipe(Effect.flatMap((accounts) => writeAccountSet(set, accounts, window)));

      const writeAccountSet = (
        set: AccountSet,
        accounts: ReadonlyArray<{ readonly account: Account; readonly ref: string }>,
        window: SyncWindow,
      ) =>
        Effect.gen(function* () {
          const stamp = yield* now;
          let inserted = 0;
          let updated = 0;

          for (const connection of set.connections) {
            yield* sql`INSERT INTO connections (conn_id, name, org_id, org_name, org_url, updated_at)
              VALUES (${connection.connId}, ${connection.name}, ${connection.orgId}, ${connection.orgName},
                ${connection.orgUrl}, ${stamp})
              ON CONFLICT(conn_id) DO UPDATE SET name = excluded.name, org_id = excluded.org_id,
                org_name = excluded.org_name, org_url = excluded.org_url, updated_at = excluded.updated_at`;
          }

          for (const { account, ref } of accounts) {
            yield* sql`INSERT INTO accounts
                (id, ref, conn_id, name, currency, balance, available_balance, balance_date, updated_at)
              VALUES (${account.id}, ${ref}, ${account.connId}, ${account.name}, ${account.currency},
                ${account.balance}, ${account.availableBalance}, ${account.balanceDate}, ${stamp})
              ON CONFLICT(id) DO UPDATE SET conn_id = excluded.conn_id, name = excluded.name,
                currency = excluded.currency, balance = excluded.balance,
                available_balance = excluded.available_balance, balance_date = excluded.balance_date,
                updated_at = excluded.updated_at
              WHERE accounts.balance_date IS NULL OR excluded.balance_date >= accounts.balance_date`;

            if (account.balance !== null && account.balanceDate !== null) {
              yield* sql`INSERT OR REPLACE INTO balance_snapshots
                  (account_id, balance_date, balance, available_balance)
                VALUES (${account.id}, ${account.balanceDate}, ${account.balance}, ${account.availableBalance})`;
            }

            if (account.transactions === null) continue;

            for (const transaction of account.transactions) {
              const existing = yield* sql`SELECT id FROM transactions
                WHERE account_id = ${account.id} AND id = ${transaction.id}`;

              if (existing.length > 0) {
                yield* sql`UPDATE transactions SET posted = ${transaction.posted},
                    transacted_at = ${transaction.transactedAt}, amount = ${transaction.amount},
                    amount_cents = ${transaction.amountCents}, description = ${transaction.description},
                    payee = ${transaction.payee}, memo = ${transaction.memo},
                    pending = ${transaction.pending ? 1 : 0}, last_seen = ${stamp}
                  WHERE account_id = ${account.id} AND id = ${transaction.id}`;

                updated += 1;
              } else {
                yield* sql`INSERT INTO transactions (account_id, id, posted, transacted_at, amount,
                    amount_cents, description, payee, memo, pending, first_seen, last_seen)
                  VALUES (${account.id}, ${transaction.id}, ${transaction.posted}, ${transaction.transactedAt},
                    ${transaction.amount}, ${transaction.amountCents}, ${transaction.description},
                    ${transaction.payee}, ${transaction.memo}, ${transaction.pending ? 1 : 0}, ${stamp}, ${stamp})`;

                inserted += 1;
              }
            }

            // A pending transaction usually reappears under a new id once it posts, so pending rows
            // in the fetched window that the server no longer returns are stale. That holds only
            // when the list is the account's whole list: an unreadable record or a reported error
            // means a missing row proves nothing.
            // The returned ids can be megabytes together, so they are never bound to a statement:
            // the stored pending ids are read back and only the stale ones deleted, in batches.
            if (!account.transactionsComplete) continue;

            const returned = new Set(account.transactions.map((transaction) => transaction.id));

            const pending = yield* sql`SELECT id FROM transactions
              WHERE account_id = ${account.id} AND pending = 1
                AND ${ownTxDate} >= ${window.start} AND ${ownTxDate} < ${window.end}`.pipe(
              Effect.flatMap(decodeRows(IdRow)),
            );

            const stale = pending.map((row) => row.id).filter((id) => !returned.has(id));

            for (let start = 0; start < stale.length; start += PRUNE_BATCH) {
              yield* sql`DELETE FROM transactions WHERE account_id = ${account.id}
                AND id IN ${jsonList(stale.slice(start, start + PRUNE_BATCH))}`;
            }
          }

          const gaps = yield* readGaps;

          const next = set.hasDataErrors
            ? mergeWindows([...gaps, window])
            : subtractWindow(gaps, window);

          yield* sql`DELETE FROM sync_gaps`;

          for (const gap of next) {
            yield* sql`INSERT INTO sync_gaps (window_start, window_end) VALUES (${gap.start}, ${gap.end})`;
          }

          // Retry history is kept only for windows that are still part of a gap.
          yield* sql`DELETE FROM gap_retries WHERE NOT EXISTS (SELECT 1 FROM sync_gaps g
            WHERE g.window_start <= gap_retries.window_start AND gap_retries.window_start < g.window_end)`;

          return { new: inserted, updated };
        }).pipe(sql.withTransaction, guard("storeAccountSet"));

      const finishRun: LedgerStore["Service"]["finishRun"] = (id, outcome) =>
        Effect.gen(function* () {
          const stamp = yield* now;

          if (outcome.ok) {
            yield* sql`UPDATE sync_runs SET finished_at = ${stamp}, ok = 1, complete = ${outcome.complete ? 1 : 0},
                accounts = ${outcome.accounts}, transactions_new = ${outcome.counts.new},
                transactions_updated = ${outcome.counts.updated}, errors = ${JSON.stringify(outcome.errors)}
              WHERE id = ${id}`;
          } else {
            yield* sql`UPDATE sync_runs SET finished_at = ${stamp}, ok = 0,
                errors = ${JSON.stringify(outcome.errors)} WHERE id = ${id}`;
          }

          // Bound bookkeeping growth; quota accounting only needs the last day.
          yield* sql`DELETE FROM sync_runs WHERE id <= ${id - 500}`;
          yield* sql`DELETE FROM requests WHERE at < ${stamp - 7 * 86_400}`;
        }).pipe(guard("finishRun"));

      const lastRun = (where: "ok" | "any") =>
        (where === "ok"
          ? sql`SELECT * FROM sync_runs WHERE ok = 1 ORDER BY finished_at DESC, id DESC LIMIT 1`
          : sql`SELECT * FROM sync_runs ORDER BY started_at DESC, id DESC LIMIT 1`
        ).pipe(Effect.flatMap(decodeRows(SyncRunRow)), Effect.map(firstOrNull));

      /**
       * The upstream ids of the accounts `account` names: the account with that ref, else the
       * account with that upstream id, else every account whose name contains it (ASCII case is
       * ignored, as in the upstream CLI). Matching happens in SQL, so nothing grows with the
       * number of accounts.
       */
      const namedAccounts = (account: string) =>
        sql`(SELECT id FROM accounts WHERE CASE
          WHEN EXISTS (SELECT 1 FROM accounts WHERE ref = ${account}) THEN ref = ${account}
          WHEN EXISTS (SELECT 1 FROM accounts WHERE id = ${account}) THEN id = ${account}
          ELSE instr(lower(name), lower(${account})) > 0 END)`;

      const accountFilter = (account: string | null) =>
        account === null ? sql.literal("1=1") : sql`t.account_id IN ${namedAccounts(account)}`;

      const periodClauses = (filter: PeriodFilter) => [
        accountFilter(filter.account),
        filter.since === null ? sql.literal("1=1") : sql`${txDate} >= ${filter.since}`,
        filter.until === null ? sql.literal("1=1") : sql`${txDate} < ${filter.until}`,
      ];

      return LedgerStore.of({
        migrate: migrate.pipe(Effect.provideService(SqlClient.SqlClient, sql), guard("migrate")),

        storeAccountSet,

        beginRequest: Effect.gen(function* () {
          const stamp = yield* now;

          // Recorded before sending, so a request that fails mid-flight still counts against the quota.
          const rows =
            yield* sql`INSERT INTO requests (at, ok) VALUES (${stamp}, 0) RETURNING id`.pipe(
              Effect.flatMap(decodeRows(InsertedRow)),
            );

          return rows[0]?.id ?? 0;
        }).pipe(guard("beginRequest")),

        finishRequest: (id, ok, note) =>
          sql`UPDATE requests SET ok = ${ok ? 1 : 0}, note = ${note} WHERE id = ${id}`.pipe(
            Effect.asVoid,
            guard("finishRequest"),
          ),

        requestsSince: (since) =>
          sql`SELECT COUNT(*) AS n FROM requests WHERE at > ${since}`.pipe(
            Effect.flatMap(decodeRows(CountRow)),
            Effect.map((rows) => rows[0]?.n ?? 0),
            guard("requestsSince"),
          ),

        // A single conditional UPDATE is atomic, so overlapping callers can never both claim it.
        claimLease: (minGapSeconds) =>
          Effect.gen(function* () {
            const stamp = yield* now;

            yield* sql`INSERT OR IGNORE INTO meta (key, value) VALUES ('sync_lease', 0)`;

            const claimed = yield* sql`UPDATE meta SET value = ${stamp}
              WHERE key = 'sync_lease' AND value <= ${stamp - minGapSeconds} RETURNING key`;

            return claimed.length === 1;
          }).pipe(guard("claimLease")),

        raiseLease: (value) =>
          sql`INSERT INTO meta (key, value) VALUES ('sync_lease', ${value})
            ON CONFLICT(key) DO UPDATE SET value = MAX(value, excluded.value)`.pipe(
            Effect.asVoid,
            guard("raiseLease"),
          ),

        resetLease: sql`INSERT OR REPLACE INTO meta (key, value) VALUES ('sync_lease', 0)`.pipe(
          Effect.asVoid,
          guard("resetLease"),
        ),

        leaseValue: sql`SELECT value FROM meta WHERE key = 'sync_lease'`.pipe(
          Effect.flatMap(decodeRows(ValueRow)),
          Effect.map((rows) => Number(rows[0]?.value ?? 0)),
          guard("leaseValue"),
        ),

        readSetting: (key) =>
          sql`SELECT value FROM meta WHERE key = ${`setting:${key}`}`.pipe(
            Effect.flatMap(decodeRows(ValueRow)),
            Effect.map((rows) => {
              const value = rows[0]?.value;

              return value === undefined || value === null ? null : String(value);
            }),
            guard("readSetting"),
          ),

        writeSetting: (key, value) =>
          sql`INSERT OR REPLACE INTO meta (key, value) VALUES (${`setting:${key}`}, ${value})`.pipe(
            Effect.asVoid,
            guard("writeSetting"),
          ),

        startRun: (window) =>
          Effect.gen(function* () {
            const stamp = yield* now;

            const rows = yield* sql`INSERT INTO sync_runs (started_at, window_start, window_end)
              VALUES (${stamp}, ${window.start}, ${window.end}) RETURNING id`.pipe(
              Effect.flatMap(decodeRows(InsertedRow)),
            );

            return rows[0]?.id ?? 0;
          }).pipe(guard("startRun")),

        finishRun,

        history: Effect.gen(function* () {
          const success =
            yield* sql`SELECT MAX(finished_at) AS finished FROM sync_runs WHERE ok = 1`.pipe(
              Effect.flatMap(decodeRows(FinishedRow)),
            );

          const complete = yield* sql`SELECT MAX(finished_at) AS finished FROM sync_runs
            WHERE ok = 1 AND complete = 1`.pipe(Effect.flatMap(decodeRows(FinishedRow)));

          return {
            lastSuccess: success[0]?.finished ?? null,
            lastComplete: complete[0]?.finished ?? null,
          };
        }).pipe(guard("history")),

        gaps: readGaps.pipe(guard("gaps")),

        gapRetries: sql`SELECT window_start, failures, last_attempt FROM gap_retries`.pipe(
          Effect.flatMap(decodeRows(GapRetryRow)),
          Effect.map((rows) =>
            rows.map((row) => ({
              windowStart: row.window_start,
              failures: row.failures,
              lastAttempt: row.last_attempt,
            })),
          ),
          guard("gapRetries"),
        ),

        noteGapRetry: (window, at) =>
          sql`INSERT INTO gap_retries (window_start, failures, last_attempt)
            VALUES (${window.start}, 1, ${at})
            ON CONFLICT(window_start) DO UPDATE SET failures = failures + 1,
              last_attempt = excluded.last_attempt`.pipe(Effect.asVoid, guard("noteGapRetry")),

        lastSuccessfulRun: lastRun("ok").pipe(guard("lastSuccessfulRun")),
        lastAttempt: lastRun("any").pipe(guard("lastAttempt")),

        counts: Effect.gen(function* () {
          const accounts = yield* sql`SELECT COUNT(*) AS n FROM accounts`.pipe(
            Effect.flatMap(decodeRows(CountRow)),
          );

          const transactions = yield* sql`SELECT COUNT(*) AS n FROM transactions`.pipe(
            Effect.flatMap(decodeRows(CountRow)),
          );

          return { accounts: accounts[0]?.n ?? 0, transactions: transactions[0]?.n ?? 0 };
        }).pipe(guard("counts")),

        accounts:
          sql`SELECT a.id, a.ref, a.name, a.currency, a.balance, a.available_balance, a.balance_date,
              c.name AS connection, COALESCE(c.org_name, c.org_url) AS institution
            FROM accounts a LEFT JOIN connections c ON c.conn_id = a.conn_id
            ORDER BY institution, a.name`.pipe(
            Effect.flatMap(decodeRows(AccountRow)),
            guard("accounts"),
          ),

        transactions: (filter) => {
          const search = filter.search;

          const clauses = [
            ...periodClauses(filter),
            search === null
              ? sql.literal("1=1")
              : // instr matches literally and has no pattern-length limit (LIKE is capped at 50 bytes).
                sql`(instr(lower(t.description), lower(${search})) > 0
                  OR instr(lower(coalesce(t.payee, '')), lower(${search})) > 0
                  OR instr(lower(coalesce(t.memo, '')), lower(${search})) > 0)`,
            filter.minCents === null
              ? sql.literal("1=1")
              : sql`t.amount_cents >= ${filter.minCents}`,
            filter.maxCents === null
              ? sql.literal("1=1")
              : sql`t.amount_cents <= ${filter.maxCents}`,
            filter.pending === null
              ? sql.literal("1=1")
              : sql`t.pending = ${filter.pending ? 1 : 0}`,
          ];

          return sql`SELECT ${txDate} AS date, t.account_id, a.ref AS account_ref, a.name AS account_name, a.currency, t.id,
                t.amount, t.description, t.payee, t.memo, t.pending
              FROM transactions t LEFT JOIN accounts a ON a.id = t.account_id
              WHERE ${sql.and(clauses)}
              ORDER BY date DESC, t.id DESC LIMIT ${filter.limit}`.pipe(
            Effect.flatMap(decodeRows(TransactionRow)),
            guard("transactions"),
          );
        },

        balanceHistory: (account, since) =>
          sql`SELECT a.name, s.balance_date, s.balance, s.available_balance
              FROM balance_snapshots s JOIN accounts a ON a.id = s.account_id
              WHERE s.account_id IN ${namedAccounts(account)} AND s.balance_date >= ${since}
              ORDER BY s.balance_date DESC LIMIT 1000`.pipe(
            Effect.flatMap(decodeRows(BalanceRow)),
            guard("balanceHistory"),
          ),

        cashFlow: (filter) =>
          sql`SELECT a.name, a.currency, COUNT(*) AS n,
                SUM(CASE WHEN t.amount_cents > 0 THEN t.amount_cents ELSE 0 END) AS money_in,
                SUM(CASE WHEN t.amount_cents < 0 THEN -t.amount_cents ELSE 0 END) AS money_out
              FROM transactions t JOIN accounts a ON a.id = t.account_id
              WHERE t.pending = 0 AND ${sql.and(periodClauses(filter))}
              GROUP BY t.account_id ORDER BY money_out DESC`.pipe(
            Effect.flatMap(decodeRows(CashFlowRow)),
            guard("cashFlow"),
          ),

        postedEntries: (filter) =>
          sql`SELECT t.description, t.payee, t.amount_cents, ${txDate} AS date, a.name AS account
              FROM transactions t JOIN accounts a ON a.id = t.account_id
              WHERE t.pending = 0 AND ${sql.and(periodClauses(filter))}
              ORDER BY date`.pipe(
            Effect.flatMap(decodeRows(EntryRow)),
            Effect.map((rows) =>
              rows.map((row) => ({
                description: row.description,
                payee: row.payee,
                amountCents: row.amount_cents,
                date: row.date,
                account: row.account,
              })),
            ),
            guard("postedEntries"),
          ),

        earliestTransaction: sql`SELECT MIN(${txDate}) AS earliest FROM transactions t`.pipe(
          Effect.flatMap(decodeRows(EarliestRow)),
          Effect.map((rows) => rows[0]?.earliest ?? null),
          guard("earliestTransaction"),
        ),
      });
    }),
  );
}

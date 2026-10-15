import { Clock, Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";

/**
 * Ordered schema migrations, one statement per entry. Never edit an applied migration; append a
 * new one. Compared with the upstream CLI, raw `extra` payloads and connection `sfin_url`s are
 * not stored: nothing reads them, so keeping them would only widen what a breach exposes.
 */
export const MIGRATIONS: ReadonlyArray<{
  readonly id: number;
  readonly statements: ReadonlyArray<string>;
}> = [
  {
    id: 1,
    statements: [
      `CREATE TABLE connections (
        conn_id TEXT PRIMARY KEY,
        name TEXT,
        org_id TEXT,
        org_name TEXT,
        org_url TEXT,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE TABLE accounts (
        id TEXT PRIMARY KEY,
        conn_id TEXT,
        name TEXT NOT NULL,
        currency TEXT,
        balance TEXT,
        available_balance TEXT,
        balance_date INTEGER,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE TABLE balance_snapshots (
        account_id TEXT NOT NULL,
        balance_date INTEGER NOT NULL,
        balance TEXT NOT NULL,
        available_balance TEXT,
        PRIMARY KEY (account_id, balance_date)
      )`,
      `CREATE TABLE transactions (
        account_id TEXT NOT NULL,
        id TEXT NOT NULL,
        posted INTEGER NOT NULL,
        transacted_at INTEGER,
        amount TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,
        description TEXT NOT NULL,
        payee TEXT,
        memo TEXT,
        pending INTEGER NOT NULL DEFAULT 0,
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        PRIMARY KEY (account_id, id)
      )`,
      `CREATE INDEX transactions_by_tx_date
        ON transactions (COALESCE(NULLIF(posted, 0), transacted_at, first_seen))`,
      `CREATE TABLE requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        ok INTEGER NOT NULL,
        note TEXT
      )`,
      `CREATE INDEX requests_by_at ON requests (at)`,
      `CREATE TABLE meta (key TEXT PRIMARY KEY, value)`,
      `CREATE TABLE sync_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        window_start INTEGER,
        window_end INTEGER,
        ok INTEGER NOT NULL DEFAULT 0,
        complete INTEGER NOT NULL DEFAULT 0,
        accounts INTEGER,
        transactions_new INTEGER,
        transactions_updated INTEGER,
        errors TEXT
      )`,
    ],
  },
];

const AppliedMigration = Schema.Struct({ id: Schema.Int });

/** Apply pending migrations in order, each atomically. */
export const migrate = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL
  )`;

  const applied = yield* sql`SELECT id FROM schema_migrations`.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(AppliedMigration))),
  );

  const done = new Set(applied.map((row) => row.id));

  for (const migration of MIGRATIONS) {
    if (done.has(migration.id)) continue;

    yield* Effect.gen(function* () {
      for (const statement of migration.statements) yield* sql.unsafe(statement);

      const appliedAt = Math.floor((yield* Clock.currentTimeMillis) / 1000);

      yield* sql`INSERT INTO schema_migrations (id, applied_at) VALUES (${migration.id}, ${appliedAt})`;
    }).pipe(sql.withTransaction);
  }
}).pipe(Effect.withSpan("LedgerStore.migrate"));

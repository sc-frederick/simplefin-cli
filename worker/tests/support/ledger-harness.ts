import { SqliteClient } from "@effect/sql-sqlite-node";
import { Effect, Layer, Redacted, Result } from "effect";
import { TestClock } from "effect/testing";
import { LedgerQueries } from "../../src/app/ledger-queries.ts";
import { BridgeSettings, SyncService } from "../../src/app/sync-service.ts";
import { calendarFor, parseTimeZone } from "../../src/domain/dates.ts";
import { parseAccessUrl } from "../../src/simplefin/credentials.ts";
import { LedgerStore } from "../../src/store/ledger-store.ts";
import type { FakeBridge } from "./fake-bridge.ts";

/** Wall-clock start for every ledger test: 2026-10-15 12:00 in New York. */
export const START_MS = Date.UTC(2026, 9, 15, 16, 0, 0);

/** The test calendar's time zone. */
export const TIME_ZONE = Result.getOrThrow(parseTimeZone("America/New_York"));

/** Mutable test inputs the settings read on every sync. */
export interface HarnessOptions {
  readonly bridge: FakeBridge;
  /** The current access URL, or null before a claim. */
  readonly accessUrl: () => string | null;
  readonly autoSyncHours?: number;
  readonly initialSyncDays?: number;
}

/** Services over a fresh in-memory SQLite database, with time controlled by TestClock. */
export function ledgerLayer(options: HarnessOptions) {
  const settings = Layer.succeed(BridgeSettings, {
    autoSyncSeconds: (options.autoSyncHours ?? 12) * 3600,
    initialSyncDays: options.initialSyncDays ?? 365,
    calendar: calendarFor(TIME_ZONE),
    fetch: options.bridge.fetch,
    credentials: Effect.suspend(() => {
      const accessUrl = options.accessUrl();

      if (accessUrl === null) return Effect.succeed(null);

      const parsed = parseAccessUrl(Redacted.make(accessUrl));

      return Result.isFailure(parsed)
        ? Effect.fail(parsed.failure)
        : Effect.succeed(parsed.success);
    }),
  });

  const store = LedgerStore.layer.pipe(Layer.provide(SqliteClient.layer({ filename: ":memory:" })));

  return Layer.mergeAll(SyncService.layer, LedgerQueries.layer).pipe(
    Layer.provideMerge(store),
    Layer.provide(settings),
  );
}

/** Run a ledger program against fresh storage, starting the clock at {@link START_MS}. */
export function runLedger<A, E>(
  options: HarnessOptions,
  program: Effect.Effect<A, E, LedgerStore | SyncService | LedgerQueries>,
): Promise<A> {
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(START_MS);
      yield* LedgerStore.use((store) => store.migrate);

      return yield* program;
    }).pipe(Effect.provide(ledgerLayer(options)), Effect.provide(TestClock.layer())),
  );
}

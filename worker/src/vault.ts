import { SqliteClient } from "@effect/sql-sqlite-do";
import { DurableObject } from "cloudflare:workers";
import { Effect, Layer, ManagedRuntime, Result } from "effect";
import { LedgerQueries } from "./app/ledger-queries.ts";
import { AutoSyncOutcome, BridgeSettings, SyncService } from "./app/sync-service.ts";
import { bridgeSettingsFrom, parseSyncConfiguration } from "./config.ts";
import { AUTO_SYNC_RETRY_SECONDS } from "./domain/sync-plan.ts";
import type { Env } from "./env.ts";
import type { McpHttpResponse } from "./mcp/server.ts";
import { handleMcpMessage } from "./mcp/server.ts";
import { LedgerStore } from "./store/ledger-store.ts";

/** How soon to look again when no access URL has been claimed yet. */
const NOT_CONNECTED_RECHECK_SECONDS = 3600;

/** Answer for an unexpected failure; details stay in the logs, never in the response. */
const INTERNAL_ERROR: McpHttpResponse = {
  status: 500,
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: null,
    error: { code: -32603, message: "Internal error." },
  }),
};

/** Name of the one ledger object; the bridge serves one owner. */
export const VAULT_NAME = "ledger";

/** When the next alarm should fire for an auto-sync outcome, or null for none. */
export function nextAlarmSeconds(outcome: AutoSyncOutcome, nowSeconds: number): number | null {
  const later = (nextCheck: number) => Math.max(nowSeconds + 60, nextCheck);

  return AutoSyncOutcome.$match(outcome, {
    Disabled: () => null,
    NotConnected: () => nowSeconds + NOT_CONNECTED_RECHECK_SECONDS,
    Fresh: ({ nextCheck }) => later(nextCheck),
    Leased: ({ nextCheck }) => later(nextCheck),
    Synced: ({ nextCheck }) => later(nextCheck),
    Failed: ({ nextCheck }) => later(nextCheck),
  });
}

/**
 * The owner's ledger: SQLite storage, quota-safe sync on alarms, and the MCP tools. Only the
 * Worker can reach it, and only after Access authentication.
 */
export class SimplefinVault extends DurableObject<Env> {
  readonly #runtime: ManagedRuntime.ManagedRuntime<
    LedgerQueries | SyncService | LedgerStore,
    never
  >;
  readonly #autoSyncHours: number;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    const configuration = parseSyncConfiguration(env);

    if (Result.isFailure(configuration)) {
      // alchemy.run.ts validates these at deploy time, so this is a defect, not an expected state.
      throw new Error(`Invalid ${configuration.failure.setting}: ${configuration.failure.message}`);
    }

    this.#autoSyncHours = configuration.success.autoSyncSeconds / 3600;

    const settings = Layer.succeed(
      BridgeSettings,
      bridgeSettingsFrom(env, configuration.success, (input, init) => fetch(input, init)),
    );

    const store = LedgerStore.layer.pipe(
      Layer.provide(SqliteClient.layer({ storage: ctx.storage })),
    );

    const services = Layer.mergeAll(SyncService.layer, LedgerQueries.layer).pipe(
      Layer.provideMerge(store),
      Layer.provide(settings),
    );

    this.#runtime = ManagedRuntime.make(services);

    void ctx.blockConcurrencyWhile(() =>
      this.#runtime.runPromise(LedgerStore.use((ledger) => ledger.migrate)),
    );
  }

  /** Answer one authenticated MCP message. */
  async handleMcp(body: string, protocolVersion: string | null): Promise<McpHttpResponse> {
    const response = await this.#runtime
      .runPromise(handleMcpMessage(body, protocolVersion, this.#autoSyncHours))
      .catch(() => INTERNAL_ERROR);

    await this.#ensureAlarm();

    return response;
  }

  /** Called by the hourly cron so syncing starts even before the first tool call. */
  async watchdog(): Promise<void> {
    await this.#ensureAlarm();
  }

  /** Auto-sync. Never throws: a throwing alarm is retried immediately, which could burn the quota. */
  override async alarm(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    let next: number | null = now + AUTO_SYNC_RETRY_SECONDS;

    try {
      const outcome = await this.#runtime.runPromise(SyncService.use((sync) => sync.autoSync));

      next = nextAlarmSeconds(outcome, Math.floor(Date.now() / 1000));
    } catch {
      await this.#runtime
        .runPromise(Effect.logError("Auto-sync alarm failed unexpectedly; retrying in 3 hours"))
        .catch(() => undefined);
    }

    if (next !== null) await this.ctx.storage.setAlarm(next * 1000);
  }

  /** Arm the auto-sync alarm if auto-sync is on and none is pending. */
  async #ensureAlarm(): Promise<void> {
    if (this.#autoSyncHours <= 0 || (await this.ctx.storage.getAlarm()) !== null) return;

    await this.ctx.storage.setAlarm(Date.now() + 1000);
  }
}

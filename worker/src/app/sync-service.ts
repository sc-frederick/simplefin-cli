import { Clock, Context, Data, Effect, Layer, Option, Result, Schema } from "effect";
import type { Calendar, EpochSeconds } from "../domain/dates.ts";
import { DAY } from "../domain/dates.ts";
import {
  AUTO_SYNC_RETRY_SECONDS,
  BLOCKED_RETRY_SECONDS,
  DAILY_BUDGET,
  MIN_MANUAL_SYNC_SECONDS,
  RECENT_ATTEMPT_SECONDS,
  planWindows,
} from "../domain/sync-plan.ts";
import { sanitizeText } from "../domain/text.ts";
import type { FetchAccountsError, FetchFunction } from "../simplefin/bridge-client.ts";
import { fetchAccounts } from "../simplefin/bridge-client.ts";
import type { InvalidAccessUrl, SimplefinCredentials } from "../simplefin/credentials.ts";
import { credentialFingerprint } from "../simplefin/credentials.ts";
import type { StorageError, StoredCounts } from "../store/ledger-store.ts";
import { LedgerStore } from "../store/ledger-store.ts";

/** Runtime settings for syncing, parsed from Worker bindings. */
export class BridgeSettings extends Context.Service<
  BridgeSettings,
  {
    /** Current SimpleFIN credentials; `null` until the claim script stores an access URL. */
    readonly credentials: Effect.Effect<SimplefinCredentials | null, InvalidAccessUrl>;
    /** Data older than this is synced automatically; 0 turns auto-sync off. */
    readonly autoSyncSeconds: number;
    /** History requested by the first successful sync. */
    readonly initialSyncDays: number;
    readonly calendar: Calendar;
    readonly fetch: FetchFunction;
  }
>()("simplefin/BridgeSettings") {}

/** A sync would exceed the local daily request budget. */
export class QuotaExceeded extends Schema.TaggedError<QuotaExceeded>()("QuotaExceeded", {
  message: Schema.String,
}) {}

/** No access URL has been claimed yet. */
export class NotConnected extends Schema.TaggedError<NotConnected>()("NotConnected", {
  message: Schema.String,
}) {}

/** Every failure a sync can report. */
export type SyncError =
  | FetchAccountsError
  | QuotaExceeded
  | NotConnected
  | InvalidAccessUrl
  | StorageError;

/** What one completed sync did. */
export interface SyncReport {
  readonly requests: number;
  readonly window_start: string;
  readonly window_end: string;
  readonly accounts: number;
  readonly transactions_new: number;
  readonly transactions_updated: number;
  readonly complete: boolean;
  readonly errors: ReadonlyArray<string>;
}

/** The outcome of an automatic sync check, with when to check again. */
export type AutoSyncOutcome = Data.TaggedEnum<{
  Disabled: {};
  NotConnected: {};
  Fresh: { readonly nextCheck: EpochSeconds };
  Leased: { readonly nextCheck: EpochSeconds };
  Synced: { readonly nextCheck: EpochSeconds; readonly report: SyncReport };
  Failed: { readonly nextCheck: EpochSeconds; readonly error: string };
}>;

/** Constructors and matchers for {@link AutoSyncOutcome}. */
export const AutoSyncOutcome = Data.taggedEnum<AutoSyncOutcome>();

/** The sync_now result: a report, a refusal, or a safe error message. */
export type ManualSyncOutcome =
  | SyncReport
  | { readonly skipped: true; readonly reason: string; readonly last_successful_sync?: string }
  | { readonly error: string };

/** The sync_status result. */
export interface SyncStatus {
  readonly access_configured: boolean;
  readonly access_problem: string | null;
  readonly storage: "cloudflare-durable-object";
  readonly accounts: number;
  readonly transactions: number;
  readonly last_successful_sync: string | null;
  readonly last_attempt: {
    readonly started_at: string;
    readonly finished_at: string | null;
    readonly ok: boolean;
    readonly complete: boolean;
    readonly errors: ReadonlyArray<string>;
  } | null;
  readonly requests_last_24h: number;
  readonly daily_budget: number;
  readonly auto_sync_hours: number;
  readonly bridge_errors: ReadonlyArray<string>;
}

const FINGERPRINT_SETTING = "credential_fingerprint";
const ErrorList = Schema.fromJsonString(Schema.Array(Schema.String));
const decodeErrorList = Schema.decodeUnknownOption(ErrorList);

/** Sync policy: quota budget, the shared lease, backoff, and manual-sync guards. */
export class SyncService extends Context.Service<
  SyncService,
  {
    readonly autoSync: Effect.Effect<AutoSyncOutcome, StorageError>;
    readonly manualSync: Effect.Effect<ManualSyncOutcome, StorageError>;
    readonly status: Effect.Effect<SyncStatus, StorageError>;
  }
>()("simplefin/SyncService") {
  /** Wire the policy to storage, settings and the Bridge client. */
  static readonly layer = Layer.effect(
    SyncService,
    Effect.gen(function* () {
      const store = yield* LedgerStore;
      const settings = yield* BridgeSettings;
      const now = Clock.currentTimeMillis.pipe(Effect.map((ms) => Math.floor(ms / 1000)));

      const errorMessage = (error: SyncError) => sanitizeText(error.message);

      const requireCredentials = settings.credentials.pipe(
        Effect.flatMap((credentials) =>
          credentials === null
            ? Effect.fail(
                new NotConnected({
                  message:
                    "Not connected. The owner must claim a SimpleFIN setup token with the bridge's claim " +
                    "script; never ask for a setup token or access URL in chat.",
                }),
              )
            : Effect.succeed(credentials),
        ),
      );

      /** Run one sync; `holdsLease` is true when auto-sync already claimed the lease. */
      const sync = Effect.fn("SyncService.sync")(function* (holdsLease: boolean) {
        const credentials = yield* requireCredentials;
        const startedAt = yield* now;
        const windows = planWindows(startedAt, yield* store.history, settings.initialSyncDays);
        const used = yield* store.requestsSince(startedAt - DAY);
        const oldest = windows.at(-1);
        const newest = windows[0];

        if (oldest === undefined || newest === undefined) {
          return yield* new QuotaExceeded({ message: "Nothing to sync." });
        }

        if (used + windows.length > DAILY_BUDGET) {
          return yield* new QuotaExceeded({
            message:
              `${used} SimpleFIN requests in the last 24h; this sync needs ${windows.length} more and the ` +
              `local budget is ${DAILY_BUDGET}/day (the Bridge disables tokens that keep exceeding ~24/day). ` +
              "Try again later.",
          });
        }

        // Manual syncs always run, but they push back automatic ones.
        if (!holdsLease) yield* store.setLease(startedAt);

        const runId = yield* store.startRun({ start: oldest.start, end: newest.end });
        const errors: Array<string> = [];
        const accounts = new Set<string>();
        let counts: StoredCounts = { new: 0, updated: 0 };
        let complete = true;

        const fetched = yield* Effect.gen(function* () {
          for (const window of windows) {
            const requestId = yield* store.beginRequest;

            const set = yield* fetchAccounts(settings.fetch, credentials, window).pipe(
              Effect.tapError((error) => store.finishRequest(requestId, false, error._tag)),
            );

            yield* store.finishRequest(requestId, true, "");

            const stored = yield* store.storeAccountSet(set, window);

            complete = complete && !set.hasDataErrors;
            counts = { new: counts.new + stored.new, updated: counts.updated + stored.updated };

            for (const account of set.accounts) accounts.add(account.id);

            for (const message of set.messages) if (!errors.includes(message)) errors.push(message);
          }
        }).pipe(
          Effect.tapError((error) =>
            store.finishRun(runId, { ok: false, errors: [...errors, errorMessage(error)] }),
          ),
        );

        yield* Effect.succeed(fetched);
        yield* store.finishRun(runId, {
          ok: true,
          complete,
          accounts: accounts.size,
          counts,
          errors,
        });

        yield* Effect.logInfo("SimpleFIN sync finished").pipe(
          Effect.annotateLogs({
            requests: windows.length,
            accounts: accounts.size,
            transactionsNew: counts.new,
            transactionsUpdated: counts.updated,
            complete,
            bridgeMessages: errors.length,
          }),
        );

        return {
          requests: windows.length,
          window_start: settings.calendar.format(oldest.start),
          window_end: settings.calendar.format(newest.end),
          accounts: accounts.size,
          transactions_new: counts.new,
          transactions_updated: counts.updated,
          complete,
          errors,
        } satisfies SyncReport;
      });

      /** Clear backoff when a new access URL was claimed since the last check. */
      const noticeNewCredentials = (credentials: SimplefinCredentials) =>
        Effect.gen(function* () {
          const fingerprint = yield* Effect.promise(() => credentialFingerprint(credentials));
          const previous = yield* store.readSetting(FINGERPRINT_SETTING);

          if (previous === fingerprint) return;

          yield* store.setLease(0);
          yield* store.writeSetting(FINGERPRINT_SETTING, fingerprint);
        });

      const autoSync: Effect.Effect<AutoSyncOutcome, StorageError> = Effect.gen(function* () {
        if (settings.autoSyncSeconds <= 0) return AutoSyncOutcome.Disabled();

        const credentials = yield* settings.credentials.pipe(Effect.orElseSucceed(() => null));

        if (credentials === null) return AutoSyncOutcome.NotConnected();

        yield* noticeNewCredentials(credentials);

        const checkedAt = yield* now;
        const { lastSuccess } = yield* store.history;

        if (lastSuccess !== null && checkedAt - lastSuccess < settings.autoSyncSeconds) {
          return AutoSyncOutcome.Fresh({ nextCheck: lastSuccess + settings.autoSyncSeconds });
        }

        if (!(yield* store.claimLease(AUTO_SYNC_RETRY_SECONDS))) {
          const lease = yield* store.leaseValue;

          return AutoSyncOutcome.Leased({
            nextCheck: Math.max(checkedAt + 60, lease + AUTO_SYNC_RETRY_SECONDS),
          });
        }

        const failed = (error: SyncError, retryAfter: number) =>
          Effect.logWarning("SimpleFIN auto-sync failed").pipe(
            Effect.annotateLogs({ error: error._tag }),
            Effect.as(
              AutoSyncOutcome.Failed({
                nextCheck: checkedAt + retryAfter,
                error: errorMessage(error),
              }),
            ),
          );

        // Revoked access and unpaid subscriptions don't fix themselves: back off a day. A new
        // claim changes the credential fingerprint, which clears this.
        const blocked = (error: SyncError) =>
          store
            .setLease(checkedAt + BLOCKED_RETRY_SECONDS - AUTO_SYNC_RETRY_SECONDS)
            .pipe(Effect.andThen(failed(error, BLOCKED_RETRY_SECONDS)));

        return yield* sync(true).pipe(
          Effect.map((report) =>
            AutoSyncOutcome.Synced({ nextCheck: checkedAt + settings.autoSyncSeconds, report }),
          ),
          Effect.catchTags({ AccessRevoked: blocked, PaymentRequired: blocked }),
          Effect.catch((error) => failed(error, AUTO_SYNC_RETRY_SECONDS)),
        );
      });

      const manualSync: Effect.Effect<ManualSyncOutcome, StorageError> = Effect.gen(function* () {
        const requestedAt = yield* now;
        const lease = yield* store.leaseValue;

        if (lease > 0 && requestedAt - lease >= 0 && requestedAt - lease < RECENT_ATTEMPT_SECONDS) {
          return {
            skipped: true,
            reason: "Another sync started in the last 10 minutes; check sync_status shortly.",
          } as const;
        }

        const { lastSuccess } = yield* store.history;

        if (lastSuccess !== null && requestedAt - lastSuccess < MIN_MANUAL_SYNC_SECONDS) {
          return {
            skipped: true,
            reason: "Last sync was under an hour ago; the Bridge only refreshes about daily.",
            last_successful_sync: settings.calendar.format(lastSuccess),
          } as const;
        }

        const reportable = (error: Exclude<SyncError, StorageError>) =>
          Effect.succeed({ error: errorMessage(error) });

        return yield* sync(false).pipe(
          Effect.catchTags({
            AccessRevoked: reportable,
            PaymentRequired: reportable,
            EdgeBlocked: reportable,
            BridgeUnavailable: reportable,
            InvalidBridgeResponse: reportable,
            InvalidAccessUrl: reportable,
            QuotaExceeded: reportable,
            NotConnected: reportable,
          }),
        );
      });

      const status: Effect.Effect<SyncStatus, StorageError> = Effect.gen(function* () {
        const credentials = yield* settings.credentials.pipe(Effect.result);
        const lastSuccess = yield* store.lastSuccessfulRun;
        const lastAttempt = yield* store.lastAttempt;
        const counts = yield* store.counts;
        const checkedAt = yield* now;

        const errorsOf = (text: string | null) =>
          text === null
            ? []
            : Option.getOrElse(decodeErrorList(text), (): ReadonlyArray<string> => []);

        return {
          access_configured: Result.isSuccess(credentials) && credentials.success !== null,
          access_problem: Result.isFailure(credentials) ? credentials.failure.message : null,
          storage: "cloudflare-durable-object",
          accounts: counts.accounts,
          transactions: counts.transactions,
          last_successful_sync:
            lastSuccess?.finished_at === null || lastSuccess === null
              ? null
              : settings.calendar.format(lastSuccess.finished_at),
          last_attempt:
            lastAttempt === null
              ? null
              : {
                  started_at: settings.calendar.format(lastAttempt.started_at),
                  finished_at:
                    lastAttempt.finished_at === null
                      ? null
                      : settings.calendar.format(lastAttempt.finished_at),
                  ok: lastAttempt.ok === 1,
                  complete: lastAttempt.complete === 1,
                  errors: errorsOf(lastAttempt.errors),
                },
          requests_last_24h: yield* store.requestsSince(checkedAt - DAY),
          daily_budget: DAILY_BUDGET,
          auto_sync_hours: settings.autoSyncSeconds / 3600,
          bridge_errors: lastSuccess === null ? [] : errorsOf(lastSuccess.errors),
        };
      });

      return SyncService.of({ autoSync, manualSync, status });
    }),
  );
}

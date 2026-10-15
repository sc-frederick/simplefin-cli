import { Effect, Redacted, Result, Schema } from "effect";
import type { BridgeSettings } from "./app/sync-service.ts";
import type { Calendar } from "./domain/dates.ts";
import { calendarFor, parseTimeZone } from "./domain/dates.ts";
import type { AccessPolicy } from "./edge/access-token.ts";
import type { Env } from "./env.ts";
import type { FetchFunction } from "./simplefin/bridge-client.ts";
import { parseAccessUrl } from "./simplefin/credentials.ts";

/** A binding value that alchemy.run.ts should have rejected at deploy time. */
export class InvalidConfiguration extends Schema.TaggedError<InvalidConfiguration>()(
  "InvalidConfiguration",
  { setting: Schema.String, message: Schema.String },
) {}

const TEAM_DOMAIN = /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/u;
const IDENTIFIER = /^[A-Za-z0-9._-]{1,200}$/u;
const WHOLE_NUMBER = /^\d{1,4}(?:\.\d{1,2})?$/u;

const invalid = (setting: string, message: string) =>
  Result.fail(new InvalidConfiguration({ setting, message }));

/** Parse the Access checks the edge enforces. */
export function parseAccessPolicy(env: Env): Result.Result<AccessPolicy, InvalidConfiguration> {
  if (!TEAM_DOMAIN.test(env.ACCESS_TEAM_DOMAIN)) {
    return invalid("ACCESS_TEAM_DOMAIN", "Expected https://<team>.cloudflareaccess.com.");
  }

  if (!IDENTIFIER.test(env.ACCESS_AUD))
    return invalid("ACCESS_AUD", "Expected an Access audience tag.");

  if (!IDENTIFIER.test(env.EXECUTOR_CLIENT_ID)) {
    return invalid("EXECUTOR_CLIENT_ID", "Expected an Access service token client ID.");
  }

  return Result.succeed({
    teamDomain: env.ACCESS_TEAM_DOMAIN,
    audience: env.ACCESS_AUD,
    clientId: env.EXECUTOR_CLIENT_ID,
  });
}

/** Sync and calendar settings, without the injected fetch and credentials. */
export interface SyncConfiguration {
  readonly autoSyncSeconds: number;
  readonly initialSyncDays: number;
  readonly calendar: Calendar;
}

/** Parse the sync and calendar settings. */
export function parseSyncConfiguration(
  env: Env,
): Result.Result<SyncConfiguration, InvalidConfiguration> {
  const timeZone = parseTimeZone(env.TIME_ZONE);

  if (Result.isFailure(timeZone)) return invalid("TIME_ZONE", timeZone.failure.message);

  if (!WHOLE_NUMBER.test(env.AUTO_SYNC_HOURS))
    return invalid("AUTO_SYNC_HOURS", "Expected hours, e.g. 12.");

  const hours = Number(env.AUTO_SYNC_HOURS);
  const days = Number(env.INITIAL_SYNC_DAYS);

  if (!/^\d{1,4}$/u.test(env.INITIAL_SYNC_DAYS) || days < 1 || days > 730) {
    return invalid("INITIAL_SYNC_DAYS", "Expected 1-730 days.");
  }

  return Result.succeed({
    // Anything below the 3-hour retry gap would only be refused by the lease.
    autoSyncSeconds: hours === 0 ? 0 : Math.max(3, hours) * 3600,
    initialSyncDays: days,
    calendar: calendarFor(timeZone.success),
  });
}

/**
 * Build the BridgeSettings service value. Credentials are read from Secrets Store on every
 * sync, so a new claim takes effect without a redeploy.
 */
export function bridgeSettingsFrom(
  env: Env,
  configuration: SyncConfiguration,
  fetch: FetchFunction,
): BridgeSettings["Service"] {
  return {
    ...configuration,
    fetch,
    credentials: Effect.promise(async () => {
      try {
        return Redacted.make(await env.SIMPLEFIN_ACCESS_URL.get(), {
          label: "SimpleFIN access URL",
        });
      } catch {
        // The secret does not exist until the owner runs the claim script.
        return null;
      }
    }).pipe(
      Effect.flatMap((accessUrl) => {
        if (accessUrl === null || Redacted.value(accessUrl).trim() === "")
          return Effect.succeed(null);

        const parsed = parseAccessUrl(accessUrl);

        return Result.isFailure(parsed)
          ? Effect.fail(parsed.failure)
          : Effect.succeed(parsed.success);
      }),
    ),
  };
}

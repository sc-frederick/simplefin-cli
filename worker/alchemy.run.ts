/**
 * Cloudflare infrastructure for the private SimpleFIN bridge.
 *
 * Only the Alchemy CLI evaluates this file. Deploy only with the owner's authorization, and read
 * docs/deployment.md before running any command against an account.
 */
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Config, ConfigProvider, Effect, Result, Schema } from "effect";
import { ACCESS_URL_SECRET_NAME, COMPATIBILITY_DATE } from "./src/deployment.ts";
import { parseTimeZone } from "./src/domain/dates.ts";
import type { SimplefinVault } from "./src/vault.ts";

/**
 * One owner, one ledger: there is deliberately no staging copy of the financial data, so the
 * stack deploys a single stage.
 */
const STAGE = "production";

// A fixed name lets `alchemy deploy --adopt` recover the Worker if state is lost.
const WORKER_NAME = "simplefin-bridge";

const refuseDeploy = (message: string) =>
  new Config.ConfigError(new ConfigProvider.SourceError({ message }));

const pattern = (expression: RegExp, name: string) =>
  Config.schema(Schema.String.check(Schema.isPattern(expression)), name);

// Read at deploy time only; a missing or malformed value fails before any resource is declared.
const Hostname = pattern(/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/u, "SIMPLEFIN_HOSTNAME");
const ZoneName = pattern(/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/u, "SIMPLEFIN_ZONE");

const AccessTeamDomain = pattern(
  /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/u,
  "ACCESS_TEAM_DOMAIN",
);

const ExecutorTokenId = pattern(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
  "EXECUTOR_SERVICE_TOKEN_ID",
);

const ExecutorClientId = pattern(/^[A-Za-z0-9._-]{1,200}$/u, "EXECUTOR_CLIENT_ID");

const TimeZone = pattern(/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/u, "TIME_ZONE").pipe(
  Config.withDefault("America/New_York"),
);

const AutoSyncHours = pattern(/^\d{1,4}(?:\.\d{1,2})?$/u, "AUTO_SYNC_HOURS").pipe(
  Config.withDefault("12"),
);

const InitialSyncDays = pattern(/^\d{1,3}$/u, "INITIAL_SYNC_DAYS").pipe(Config.withDefault("365"));

export default Alchemy.Stack(
  "simplefin-bridge",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const stage = yield* Alchemy.Stage;

    if (stage !== STAGE) {
      return yield* Effect.fail(
        refuseDeploy(
          `This stack deploys only stage "${STAGE}"; there is one owner and one ledger.`,
        ),
      );
    }

    const hostname = yield* Hostname;
    const zoneName = yield* ZoneName;

    if (hostname !== zoneName && !hostname.endsWith(`.${zoneName}`)) {
      return yield* Effect.fail(
        refuseDeploy(`SIMPLEFIN_HOSTNAME must be inside SIMPLEFIN_ZONE (${zoneName}).`),
      );
    }

    const executorTokenId = yield* ExecutorTokenId;
    const timeZone = yield* TimeZone;
    const initialSyncDays = yield* InitialSyncDays;

    // Apply the Worker's own parsers, so a value the runtime would reject fails the deploy instead.
    if (Result.isFailure(parseTimeZone(timeZone))) {
      return yield* Effect.fail(
        refuseDeploy(`TIME_ZONE ${JSON.stringify(timeZone)} is not a known time zone.`),
      );
    }

    if (Number(initialSyncDays) < 1 || Number(initialSyncDays) > 730) {
      return yield* Effect.fail(refuseDeploy("INITIAL_SYNC_DAYS must be between 1 and 730."));
    }

    // Edge authentication: only Executor's service token gets through. Alchemy finishes the
    // application before the Worker, which reads its audience tag.
    const access = yield* Cloudflare.Access.Application("Access", {
      type: "self_hosted",
      name: "SimpleFIN bridge",
      domain: hostname,
      sessionDuration: "15m",
      appLauncherVisible: false,
      policies: [
        {
          name: "Executor service token only",
          decision: "non_identity",
          include: [{ serviceToken: executorTokenId }],
        },
      ],
    });

    // Adopts the account's one store; Alchemy never deletes it and never sees the secret's value.
    const store = yield* Cloudflare.SecretsStore.Store("SecretsStore", {});

    const bridge = yield* Cloudflare.Worker("Bridge", {
      name: WORKER_NAME,
      main: "./src/worker.ts",
      compatibility: { date: COMPATIBILITY_DATE },
      // The custom domain behind Access is the only way in: no workers.dev or preview URLs.
      workersDev: { enabled: false, previewsEnabled: false },
      domain: { name: hostname, zoneName },
      // Invocation logs capture request headers; the Worker logs only safe structured events.
      observability: { enabled: true, logs: { enabled: true, invocationLogs: false } },
      // Hourly watchdog that arms the sync alarm even before the first tool call.
      crons: ["17 * * * *"],
      env: {
        VAULT: Cloudflare.DurableObject<SimplefinVault>("SimplefinVault"),
        ACCESS_TEAM_DOMAIN: yield* AccessTeamDomain,
        ACCESS_AUD: access.aud,
        EXECUTOR_CLIENT_ID: yield* ExecutorClientId,
        TIME_ZONE: timeZone,
        AUTO_SYNC_HOURS: yield* AutoSyncHours,
        INITIAL_SYNC_DAYS: initialSyncDays,
        APP_STAGE: Alchemy.Stage,
      },
    });

    // Bound by store and name, so no deploy ever carries or overwrites the access URL.
    yield* bridge.bind("secrets-store:SIMPLEFIN_ACCESS_URL", {
      bindings: [
        {
          type: "secrets_store_secret",
          name: "SIMPLEFIN_ACCESS_URL",
          storeId: store.storeId,
          secretName: ACCESS_URL_SECRET_NAME,
        },
      ],
    });

    return {
      mcpUrl: `https://${hostname}/mcp`,
      secretsStoreId: store.storeId,
      accessUrlSecret: ACCESS_URL_SECRET_NAME,
    };
  }),
);

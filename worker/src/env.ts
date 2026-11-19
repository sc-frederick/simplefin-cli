import type { SimplefinVault } from "./vault.ts";

/** Bindings the Worker and Durable Object receive; alchemy.run.ts declares each one. */
export interface Env {
  /** The single Durable Object holding the ledger. */
  readonly VAULT: DurableObjectNamespace<SimplefinVault>;
  /**
   * The SimpleFIN access URL in Cloudflare Secrets Store. Bound by store and secret name, so
   * deployments never carry or overwrite its value; it is missing until the claim script runs.
   */
  readonly SIMPLEFIN_ACCESS_URL: SecretsStoreSecret;
  /** https://<team>.cloudflareaccess.com */
  readonly ACCESS_TEAM_DOMAIN: string;
  /** The Access application's audience tag. */
  readonly ACCESS_AUD: string;
  /** Client ID of the only Access service token allowed to call the bridge (Executor's). */
  readonly EXECUTOR_CLIENT_ID: string;
  /** IANA time zone for interpreting dates and rendering timestamps. */
  readonly TIME_ZONE: string;
  /** Hours after which data is synced automatically; "0" disables auto-sync. */
  readonly AUTO_SYNC_HOURS: string;
  /** Days of history the first successful sync requests. */
  readonly INITIAL_SYNC_DAYS: string;
  /** Deployment stage name. */
  readonly APP_STAGE: string;
}

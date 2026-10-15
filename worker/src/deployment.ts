/** Secrets Store secret holding the access URL. Only scripts/claim.ts writes it; deploys never do. */
export const ACCESS_URL_SECRET_NAME = "simplefin-access-url";

/** Compatibility date for the deployed Worker; tests run on the newest date local workerd supports. */
export const COMPATIBILITY_DATE = "2026-10-06";

/**
 * Value the claim script writes before spending a setup token, to prove it can write the secret.
 * The bridge treats it as "not connected".
 */
export const ACCESS_URL_PLACEHOLDER = "pending-claim";

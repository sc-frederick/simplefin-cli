/**
 * The Cloudflare Secrets Store calls shared by `pnpm bootstrap` and `pnpm --silent claim`. Nothing here
 * prints a token, a secret value, or a response body.
 */
import { Exit, Redacted, Schema } from "effect";
import { ACCESS_URL_PLACEHOLDER, ACCESS_URL_SECRET_NAME } from "../src/deployment.ts";

const API = "https://api.cloudflare.com/client/v4";

/** The name Cloudflare and Alchemy give an account's default store; Alchemy adopts it on deploy. */
const DEFAULT_STORE_NAME = "default_secrets_store";

/** Comment on the placeholder secret before a setup token is claimed. */
export const PENDING_COMMENT =
  "SimpleFIN access URL for the simplefin-bridge Worker: claim pending.";

/** Comment on the secret once it holds a claimed access URL. */
export const CLAIMED_COMMENT =
  "SimpleFIN access URL for the simplefin-bridge Worker. Written by scripts/claim.ts.";

/** A failure safe to print: it never contains a token, URL credential, or response body. */
export class ClaimStopped extends Error {}

const ApiEnvelope = <S extends Schema.Top>(result: S) =>
  Schema.Struct({
    success: Schema.Boolean,
    errors: Schema.Array(Schema.Struct({ code: Schema.Number, message: Schema.String })),
    result: Schema.NullOr(result),
    result_info: Schema.optionalKey(Schema.Struct({ total_pages: Schema.optionalKey(Schema.Int) })),
  });

const Store = Schema.Struct({ id: Schema.String, name: Schema.String });
const Stores = ApiEnvelope(Schema.Array(Store));
const CreatedStore = ApiEnvelope(Store);

const Secret = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  comment: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

/** One Secrets Store secret's metadata; the API never returns values. */
export type Secret = typeof Secret.Type;

const Secrets = ApiEnvelope(Schema.Array(Secret));

/** Any envelope whose result this script doesn't read. */
export const Anything = ApiEnvelope(Schema.Unknown);

/** Bodies this script sends to the Secrets Store API. */
type SecretsRequest =
  | { readonly name: string }
  | ReadonlyArray<{
      readonly name: string;
      readonly value: string;
      readonly scopes: ReadonlyArray<"workers">;
      readonly comment: string;
    }>
  | { readonly value?: string; readonly comment: string };

/** The ordinary fetch signature, injected so tests can stand in for the Cloudflare API. */
export type ApiFetch = (input: string, init: RequestInit) => Promise<Response>;

/** Minimal Cloudflare API client scoped to one account's Secrets Store. */
export interface SecretsStoreApi {
  readonly call: <S extends Schema.Top & { readonly DecodingServices: never }>(
    schema: S,
    method: string,
    path: string,
    body?: SecretsRequest | null,
  ) => Promise<S["Type"]>;
}

/** Build the client. The token goes only in the Authorization header. */
export function secretsStoreApi(
  token: Redacted.Redacted<string>,
  accountId: string,
  fetchApi: ApiFetch = fetch,
): SecretsStoreApi {
  return {
    call: async (schema, method, path, body = null) => {
      const headers = new Headers({ authorization: `Bearer ${Redacted.value(token)}` });

      if (body !== null) headers.set("content-type", "application/json");

      const response = await fetchApi(`${API}/accounts/${accountId}${path}`, {
        method,
        redirect: "manual",
        headers,
        body: body === null ? null : JSON.stringify(body),
      });

      const decoded = Schema.decodeUnknownExit(Schema.fromJsonString(schema))(
        await response.text(),
      );

      if (Exit.isFailure(decoded)) {
        throw new ClaimStopped(
          `Cloudflare API ${method} ${path.split("/secrets/")[0]} returned HTTP ${response.status}.`,
        );
      }

      return decoded.value;
    },
  };
}

/**
 * The account's Secrets Store id: SECRETS_STORE_ID if given, else the only store. With
 * `createIfMissing`, an account with no store gets the default one, which Alchemy then adopts.
 */
export async function findStore(
  api: SecretsStoreApi,
  configuredId: string | undefined,
  createIfMissing: boolean,
): Promise<string> {
  if (configuredId !== undefined) return configuredId;

  const stores = await api.call(Stores, "GET", "/secrets_store/stores");

  if (stores.success && stores.result?.length === 1 && stores.result[0] !== undefined) {
    return stores.result[0].id;
  }

  if (stores.success && (stores.result ?? []).length === 0 && createIfMissing) {
    const created = await api.call(CreatedStore, "POST", "/secrets_store/stores", {
      name: DEFAULT_STORE_NAME,
    });

    if (created.success && created.result !== null) return created.result.id;
  }

  throw new ClaimStopped(
    "Could not find exactly one Secrets Store. Set SECRETS_STORE_ID, or check the token's permissions.",
  );
}

/** Every secret's metadata in the store. */
export async function listSecrets(
  api: SecretsStoreApi,
  storeId: string,
): Promise<ReadonlyArray<Secret>> {
  const secrets: Array<Secret> = [];

  for (let page = 1; ; page += 1) {
    const listed = await api.call(
      Secrets,
      "GET",
      `/secrets_store/stores/${storeId}/secrets?per_page=100&page=${page}`,
    );

    if (!listed.success) throw new ClaimStopped("The API token cannot list Secrets Store secrets.");

    secrets.push(...(listed.result ?? []));

    if ((listed.result ?? []).length === 0 || page >= (listed.result_info?.total_pages ?? page))
      break;
  }

  return secrets;
}

/** Create the access URL secret holding the placeholder the bridge treats as "not connected". */
export async function createPlaceholder(api: SecretsStoreApi, storeId: string): Promise<string> {
  const created = await api.call(Secrets, "POST", `/secrets_store/stores/${storeId}/secrets`, [
    {
      name: ACCESS_URL_SECRET_NAME,
      value: ACCESS_URL_PLACEHOLDER,
      scopes: ["workers"],
      comment: PENDING_COMMENT,
    },
  ]);

  const secretId = created.result?.find((secret) => secret.name === ACCESS_URL_SECRET_NAME)?.id;

  if (!created.success || secretId === undefined) {
    throw new ClaimStopped(
      "The API token cannot write Secrets Store secrets; it needs Secrets Store Edit.",
    );
  }

  return secretId;
}

/**
 * Make sure the secret the Worker binds exists before the first deploy: Cloudflare rejects a
 * Worker upload that binds a missing Secrets Store secret (error 10182). Creates the store and a
 * placeholder secret when missing. An existing secret, claimed or not, is never written.
 */
export async function bootstrapAccessUrlSecret(
  api: SecretsStoreApi,
  configuredStoreId: string | undefined,
): Promise<"created" | "exists"> {
  const storeId = await findStore(api, configuredStoreId, true);
  const secrets = await listSecrets(api, storeId);

  if (secrets.some((secret) => secret.name === ACCESS_URL_SECRET_NAME)) return "exists";

  await createPlaceholder(api, storeId);

  return "created";
}

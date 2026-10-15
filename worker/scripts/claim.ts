/**
 * Claim a SimpleFIN setup token and store the resulting access URL in Cloudflare Secrets Store,
 * where only the bridge Worker can read it. Run by the owner in a terminal; never by an agent.
 *
 *   pnpm claim             prompt for the setup token (input hidden)
 *   pnpm claim --stdin     read the setup token from stdin, e.g. from a password manager
 *   pnpm claim --replace   replace an access URL stored earlier
 *   pnpm claim --forget    delete the stored access URL
 *
 * Needs a Cloudflare API token limited to "Account › Secrets Store › Edit", read from
 * CLOUDFLARE_API_TOKEN or prompted for (hidden), and CLOUDFLARE_ACCOUNT_ID.
 *
 * The access URL is a password for read access to every connected account. It exists only in
 * this process's memory and in Secrets Store, which never returns stored values. It is never
 * printed, logged, or written to disk.
 */
import { Effect, Exit, Redacted, Result, Schema } from "effect";
import { ACCESS_URL_PLACEHOLDER, ACCESS_URL_SECRET_NAME } from "../src/deployment.ts";
import { claimAccessUrl } from "../src/simplefin/bridge-client.ts";
import { decodeSetupToken } from "../src/simplefin/credentials.ts";

const API = "https://api.cloudflare.com/client/v4";

const ApiEnvelope = <S extends Schema.Top>(result: S) =>
  Schema.Struct({
    success: Schema.Boolean,
    errors: Schema.Array(Schema.Struct({ code: Schema.Number, message: Schema.String })),
    result: Schema.NullOr(result),
    result_info: Schema.optionalKey(Schema.Struct({ total_pages: Schema.optionalKey(Schema.Int) })),
  });

const Stores = ApiEnvelope(Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })));

const Secret = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  comment: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

const Secrets = ApiEnvelope(Schema.Array(Secret));

const PENDING_COMMENT = "SimpleFIN access URL for the simplefin-bridge Worker: claim pending.";

const CLAIMED_COMMENT =
  "SimpleFIN access URL for the simplefin-bridge Worker. Written by scripts/claim.ts.";

const DISABLE_ADVICE =
  "The setup token was spent, but the access URL could not be stored and has been discarded. " +
  "Disable this app's connection at https://bridge.simplefin.org, create a new setup token, and run the claim again.";

const Anything = ApiEnvelope(Schema.Unknown);

/** Bodies this script sends to the Secrets Store API. */
type SecretsRequest =
  | ReadonlyArray<{
      readonly name: string;
      readonly value: string;
      readonly scopes: ReadonlyArray<"workers">;
      readonly comment: string;
    }>
  | { readonly value?: string; readonly comment: string };

/** A failure safe to print: it never contains a token, URL credential, or response body. */
class ClaimStopped extends Error {}

function readHidden(prompt: string): Promise<string> {
  const input = process.stdin;

  if (!input.isTTY) {
    return Promise.reject(
      new ClaimStopped("Run this in a terminal, or pass --stdin to pipe the token in."),
    );
  }

  // Leave the terminal usable even if the process is stopped mid-prompt.
  const restore = () => input.setRawMode(false);

  process.once("exit", restore);
  process.once("SIGTERM", () => {
    restore();
    process.exit(143);
  });

  process.stdout.write(prompt);
  input.setRawMode(true);
  input.resume();
  input.setEncoding("utf8");

  return new Promise((resolve, reject) => {
    let value = "";

    const finish = (outcome: () => void) => {
      restore();
      input.pause();
      input.removeListener("data", onData);
      process.stdout.write("\n");
      outcome();
    };

    const onData = (chunk: string) => {
      for (const character of chunk) {
        if (character === "\r" || character === "\n") return finish(() => resolve(value));

        if (character === "\u0003") return finish(() => reject(new ClaimStopped("Cancelled.")));

        if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
        // Tokens are printable ASCII; drop control keys and escape sequences' ESC bytes.
        else if (character >= "!" && character <= "~") value += character;
      }
    };

    input.on("data", onData);
  });
}

async function readStdin(): Promise<string> {
  const chunks: Array<Buffer> = [];

  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));

  return Buffer.concat(chunks).toString("utf8");
}

/** Minimal Cloudflare API client scoped to the account's Secrets Store. */
function cloudflare(token: Redacted.Redacted<string>, accountId: string) {
  const call = async <S extends Schema.Top & { readonly DecodingServices: never }>(
    schema: S,
    method: string,
    path: string,
    body: SecretsRequest | null = null,
  ): Promise<S["Type"]> => {
    const headers = new Headers({ authorization: `Bearer ${Redacted.value(token)}` });

    if (body !== null) headers.set("content-type", "application/json");

    const response = await fetch(`${API}/accounts/${accountId}${path}`, {
      method,
      redirect: "manual",
      headers,
      body: body === null ? null : JSON.stringify(body),
    });

    const decoded = Schema.decodeUnknownExit(Schema.fromJsonString(schema))(await response.text());

    if (Exit.isFailure(decoded)) {
      throw new ClaimStopped(
        `Cloudflare API ${method} ${path.split("/secrets/")[0]} returned HTTP ${response.status}.`,
      );
    }

    return decoded.value;
  };

  return { call };
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const known = new Set(["--stdin", "--replace", "--forget"]);
  const unknown = [...args].filter((arg) => !known.has(arg));

  if (unknown.length > 0) throw new ClaimStopped(`Unknown option ${unknown.join(" ")}.`);

  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";

  if (!/^[0-9a-f]{32}$/u.test(accountId))
    throw new ClaimStopped("Set CLOUDFLARE_ACCOUNT_ID to the 32-character account ID.");

  const token = Redacted.make(
    process.env.CLOUDFLARE_API_TOKEN ??
      (await readHidden("Cloudflare API token (Secrets Store Edit; input hidden): ")),
  );

  const api = cloudflare(token, accountId);

  // Check every Cloudflare prerequisite before spending the one-time setup token.
  const stores = await api.call(Stores, "GET", "/secrets_store/stores");

  const storeId =
    process.env.SECRETS_STORE_ID ??
    (stores.result?.length === 1 ? stores.result[0]?.id : undefined);

  if (!stores.success || storeId === undefined) {
    throw new ClaimStopped(
      "Could not find exactly one Secrets Store. Set SECRETS_STORE_ID, or check the token's permissions.",
    );
  }

  const secrets: Array<typeof Secret.Type> = [];

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

  const existing = secrets.find((secret) => secret.name === ACCESS_URL_SECRET_NAME);
  const pending = existing?.comment === PENDING_COMMENT;

  if (args.has("--forget")) {
    if (existing === undefined) {
      console.log("No access URL is stored.");

      return;
    }

    const removed = await api.call(
      Anything,
      "DELETE",
      `/secrets_store/stores/${storeId}/secrets/${existing.id}`,
    );

    if (!removed.success) throw new ClaimStopped("Cloudflare refused to delete the secret.");

    console.log(
      "Deleted the stored access URL. Also disable this app's connection at https://bridge.simplefin.org.",
    );

    return;
  }

  if (existing !== undefined && !pending && !args.has("--replace")) {
    throw new ClaimStopped("An access URL is already stored. Pass --replace to overwrite it.");
  }

  // Prove the token can write the secret before spending the one-time setup token. A new
  // secret starts as a placeholder the bridge treats as "not connected".
  const probe =
    existing === undefined
      ? await api.call(Secrets, "POST", `/secrets_store/stores/${storeId}/secrets`, [
          {
            name: ACCESS_URL_SECRET_NAME,
            value: ACCESS_URL_PLACEHOLDER,
            scopes: ["workers"],
            comment: PENDING_COMMENT,
          },
        ])
      : await api.call(
          Anything,
          "PATCH",
          `/secrets_store/stores/${storeId}/secrets/${existing.id}`,
          {
            comment: pending ? PENDING_COMMENT : CLAIMED_COMMENT,
          },
        );

  const secretId =
    existing?.id ??
    (Array.isArray(probe.result)
      ? probe.result.find((secret) => secret.name === ACCESS_URL_SECRET_NAME)?.id
      : undefined);

  if (!probe.success || secretId === undefined) {
    throw new ClaimStopped(
      "The API token cannot write Secrets Store secrets; it needs Secrets Store Edit.",
    );
  }

  const setupToken = args.has("--stdin")
    ? await readStdin()
    : await readHidden("SimpleFIN setup token (input hidden): ");

  const claimUrl = decodeSetupToken(setupToken);

  if (Result.isFailure(claimUrl)) throw new ClaimStopped(claimUrl.failure.message);

  const claimed = await Effect.runPromise(Effect.result(claimAccessUrl(fetch, claimUrl.success)));

  if (Result.isFailure(claimed)) throw new ClaimStopped(claimed.failure.message);

  const stored = await api
    .call(Anything, "PATCH", `/secrets_store/stores/${storeId}/secrets/${secretId}`, {
      value: Redacted.value(claimed.success),
      comment: CLAIMED_COMMENT,
    })
    .catch(() => undefined);

  if (stored === undefined || !stored.success) throw new ClaimStopped(DISABLE_ADVICE);

  console.log(
    "Claimed. The access URL is in Secrets Store and was never displayed or written to disk.",
  );
  console.log("The bridge syncs within the hour, or call the sync_now tool through Executor.");
}

main().catch((cause: unknown) => {
  // Unexpected errors print only their type; their messages could echo a request URL.
  const message =
    cause instanceof ClaimStopped
      ? cause.message
      : `Claim failed (${cause instanceof Error ? cause.name : "unknown error"}).`;

  console.error(message);
  process.exit(1);
});

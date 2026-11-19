/**
 * Claim a SimpleFIN setup token and store the resulting access URL in Cloudflare Secrets Store,
 * where only the bridge Worker can read it. Run by the owner in a terminal; never by an agent.
 *
 *   pnpm --silent claim             prompt for the setup token (input hidden)
 *   pnpm --silent claim --stdin     read the setup token from stdin, e.g. from a password manager
 *   pnpm --silent claim --replace   replace an access URL stored earlier
 *   pnpm --silent claim --forget    delete the stored access URL
 *   pnpm bootstrap                  before the first deploy: create a placeholder secret if none exists
 *
 * `--silent` stops pnpm from echoing the command line, so a token pasted after it by mistake is
 * never printed. (`pnpm -s` does not do this in pnpm 12.)
 *
 * Needs a Cloudflare API token limited to "Account › Secrets Store › Edit", read from
 * CLOUDFLARE_API_TOKEN or prompted for (hidden), and CLOUDFLARE_ACCOUNT_ID.
 *
 * The access URL is a password for read access to every connected account. It exists only in
 * this process's memory and in Secrets Store, which never returns stored values. It is never
 * printed, logged, or written to disk.
 */
import { Effect, Redacted, Result } from "effect";
import { claimAccessUrl } from "../src/simplefin/bridge-client.ts";
import { decodeSetupToken } from "../src/simplefin/credentials.ts";
import { ACCESS_URL_SECRET_NAME } from "../src/deployment.ts";
import {
  Anything,
  bootstrapAccessUrlSecret,
  CLAIMED_COMMENT,
  ClaimStopped,
  createPlaceholder,
  findStore,
  listSecrets,
  PENDING_COMMENT,
  secretsStoreApi,
} from "./secrets-store.ts";

const USAGE = "Usage: pnpm --silent claim [--stdin | --replace | --forget | --bootstrap]";

const DISABLE_ADVICE =
  "The setup token was spent, but the access URL could not be stored and has been discarded. " +
  "Disable this app's connection at https://bridge.simplefin.org, create a new setup token, and run the claim again.";

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

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const known = new Set(["--stdin", "--replace", "--forget", "--bootstrap"]);

  // Never echo arguments: a setup token pasted on the command line would end up in the output.
  if ([...args].some((arg) => !known.has(arg))) throw new ClaimStopped(`Unknown option. ${USAGE}`);

  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";

  if (!/^[0-9a-f]{32}$/u.test(accountId))
    throw new ClaimStopped("Set CLOUDFLARE_ACCOUNT_ID to the 32-character account ID.");

  const token = Redacted.make(
    process.env.CLOUDFLARE_API_TOKEN ??
      (await readHidden("Cloudflare API token (Secrets Store Edit; input hidden): ")),
  );

  const api = secretsStoreApi(token, accountId);

  if (args.has("--bootstrap")) {
    const outcome = await bootstrapAccessUrlSecret(api, process.env.SECRETS_STORE_ID);

    console.log(
      outcome === "created"
        ? "Created a placeholder access URL secret, so the Worker can deploy. Claim after deploying."
        : "The access URL secret already exists; left it unchanged.",
    );

    return;
  }

  // Check every Cloudflare prerequisite before spending the one-time setup token.
  const storeId = await findStore(api, process.env.SECRETS_STORE_ID, false);
  const secrets = await listSecrets(api, storeId);
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
  let secretId: string;

  if (existing === undefined) {
    secretId = await createPlaceholder(api, storeId);
  } else {
    const probe = await api.call(
      Anything,
      "PATCH",
      `/secrets_store/stores/${storeId}/secrets/${existing.id}`,
      { comment: pending ? PENDING_COMMENT : CLAIMED_COMMENT },
    );

    if (!probe.success) {
      throw new ClaimStopped(
        "The API token cannot write Secrets Store secrets; it needs Secrets Store Edit.",
      );
    }

    secretId = existing.id;
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

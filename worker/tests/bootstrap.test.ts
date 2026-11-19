import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { Redacted } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { bootstrapAccessUrlSecret, secretsStoreApi } from "../scripts/secrets-store.ts";
import { ACCESS_URL_PLACEHOLDER, ACCESS_URL_SECRET_NAME } from "../src/deployment.ts";
import type { JsonValue } from "./support/json.ts";

const ACCOUNT = "0123456789abcdef0123456789abcdef";

interface FakeSecret {
  readonly id: string;
  readonly name: string;
  readonly comment: string;
  readonly value: string;
}

/** A stand-in for the Secrets Store API that records every write. */
function fakeCloudflare(initial: { stores: Array<string>; secrets: Array<FakeSecret> }) {
  const writes: Array<{ readonly method: string; readonly path: string; readonly body: string }> =
    [];

  const envelope = (result: JsonValue) =>
    Response.json({ success: true, errors: [], result, result_info: { total_pages: 1 } });

  const fetchApi = async (input: string, init: RequestInit) => {
    const path = new URL(input).pathname.replace(`/client/v4/accounts/${ACCOUNT}`, "");
    const method = init.method ?? "GET";
    const body = await new Response(init.body ?? null).text();

    if (method !== "GET") writes.push({ method, path, body });

    if (path === "/secrets_store/stores" && method === "GET") {
      return envelope(initial.stores.map((id) => ({ id, name: "default_secrets_store" })));
    }

    if (path === "/secrets_store/stores" && method === "POST") {
      initial.stores.push("new-store");

      return envelope({ id: "new-store", name: JSON.parse(body).name });
    }

    if (path.endsWith("/secrets") && method === "GET") {
      return envelope(initial.secrets.map(({ id, name, comment }) => ({ id, name, comment })));
    }

    if (path.endsWith("/secrets") && method === "POST") {
      const [request] = JSON.parse(body);

      initial.secrets.push({ id: "s-new", ...request });

      return envelope([{ id: "s-new", name: request.name, comment: request.comment }]);
    }

    return Response.json({ success: false, errors: [{ code: 1, message: "no" }], result: null });
  };

  return {
    api: secretsStoreApi(Redacted.make("cf-token"), ACCOUNT, fetchApi),
    writes,
    state: initial,
  };
}

describe("bootstrap before the first deploy", () => {
  test("a fresh account gets a store and a placeholder secret the Worker can bind", async () => {
    const cloudflare = fakeCloudflare({ stores: [], secrets: [] });

    expect(await bootstrapAccessUrlSecret(cloudflare.api, undefined)).toBe("created");
    expect(cloudflare.writes.map((write) => `${write.method} ${write.path}`)).toEqual([
      "POST /secrets_store/stores",
      "POST /secrets_store/stores/new-store/secrets",
    ]);
    expect(cloudflare.state.secrets).toMatchObject([
      { name: ACCESS_URL_SECRET_NAME, value: ACCESS_URL_PLACEHOLDER, scopes: ["workers"] },
    ]);
  });

  test("an existing store without the secret gets only the placeholder", async () => {
    const cloudflare = fakeCloudflare({ stores: ["store-1"], secrets: [] });

    expect(await bootstrapAccessUrlSecret(cloudflare.api, undefined)).toBe("created");
    expect(cloudflare.writes.map((write) => `${write.method} ${write.path}`)).toEqual([
      "POST /secrets_store/stores/store-1/secrets",
    ]);
  });

  test("never writes over a secret that already exists, claimed or pending", async () => {
    const claimed = {
      id: "s-1",
      name: ACCESS_URL_SECRET_NAME,
      comment: "claimed",
      value: "https://user:pass@bridge.simplefin.org/simplefin",
    };

    const cloudflare = fakeCloudflare({ stores: ["store-1"], secrets: [claimed] });

    expect(await bootstrapAccessUrlSecret(cloudflare.api, undefined)).toBe("exists");
    expect(await bootstrapAccessUrlSecret(cloudflare.api, "store-1")).toBe("exists");
    expect(cloudflare.writes).toEqual([]);
    expect(cloudflare.state.secrets).toEqual([claimed]);
  });

  test("the runbook bootstraps the secret before the first deploy", async () => {
    const runbook = await readFile(
      new URL("../docs/deployment.md", import.meta.url).pathname,
      "utf8",
    );

    const bootstrap = runbook.indexOf("pnpm bootstrap");

    expect(bootstrap).toBeGreaterThan(0);
    expect(bootstrap).toBeLessThan(runbook.indexOf("pnpm deploy "));
    expect(bootstrap).toBeLessThan(runbook.indexOf("pnpm plan "));
  });
});

describe("claim script arguments", () => {
  const root = new URL("..", import.meta.url).pathname;
  const token = "aHR0cHM6Ly9icmlkZ2Uuc2ltcGxlZmluLm9yZy9jbGFpbS9zZWNyZXQ";

  /** Every claim invocation the owner is shown, in docs and in the script's own usage text. */
  const documented = async () => {
    const files = ["docs/deployment.md", "docs/security.md", "README.md", "scripts/claim.ts"];
    const texts = await Promise.all(files.map((file) => readFile(`${root}${file}`, "utf8")));

    return texts.flatMap((text) => [...text.matchAll(/pnpm(?: --?[a-z]+)* claim\b/gu)].map(String));
  };

  test("the runbook's claim command never echoes a mistyped argument", async () => {
    const runbook = await readFile(`${root}docs/deployment.md`, "utf8");
    const command = /^\s*(pnpm(?: --?[a-z]+)* claim)\b/mu.exec(runbook)?.[1];

    expect(command).toBeDefined();

    // Run exactly what the runbook shows, with a setup token pasted after it by mistake.
    const [program = "", ...args] = (command ?? "").split(" ");

    const run = spawnSync(program, [...args, token], {
      cwd: root,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    });

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("Unknown option.");
    expect(`${run.stdout}${run.stderr}`).not.toContain(token);
  });

  test("every documented claim command is the quiet one", async () => {
    const commands = await documented();

    expect(commands.length).toBeGreaterThan(5);
    expect(commands.filter((command) => command !== "pnpm --silent claim")).toEqual([]);
  });
});

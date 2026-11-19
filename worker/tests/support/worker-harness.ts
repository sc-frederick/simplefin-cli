import { webcrypto } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Miniflare as MiniflareInstance, Request as MiniflareRequest } from "miniflare";
import { Miniflare, Response as MiniflareResponse, supportedCompatibilityDate } from "miniflare";
import { build } from "vite";
import type { FakeBridge } from "./fake-bridge.ts";
import type { JsonObject } from "./json.ts";

/** Test Access team; its signing keys are served by the outbound fake below. */
export const TEAM_DOMAIN = "https://example-team.cloudflareaccess.com";

/** Test Access application audience tag. */
export const AUDIENCE = "f".repeat(64);

/** Client ID of the service token the bridge accepts. */
export const EXECUTOR_CLIENT_ID = "0123456789abcdef0123456789abcdef.access";

/** Bundle src/worker.ts the way a deploy would: one ESM file for workerd. */
export async function bundleWorker(): Promise<{
  readonly scriptPath: string;
  readonly cleanup: () => Promise<void>;
}> {
  const outDir = await mkdtemp(join(tmpdir(), "simplefin-worker-"));

  await build({
    configFile: false,
    logLevel: "warn",
    root: new URL("../..", import.meta.url).pathname,
    build: {
      ssr: "src/worker.ts",
      outDir,
      emptyOutDir: true,
      target: "es2024",
      minify: false,
      rollupOptions: {
        external: [/^cloudflare:/u],
        output: { format: "es", entryFileNames: "worker.js" },
      },
    },
    ssr: {
      target: "webworker",
      noExternal: true,
      resolve: {
        conditions: ["workerd", "worker", "browser"],
        externalConditions: ["workerd", "worker"],
      },
    },
  });

  return {
    scriptPath: join(outDir, "worker.js"),
    cleanup: () => rm(outDir, { recursive: true, force: true }),
  };
}

/** An Access signing key pair and a function that issues tokens with it. */
export interface TestSigner {
  readonly jwks: string;
  readonly sign: (
    claims: Record<string, string | number | ReadonlyArray<string>>,
    kid?: string,
  ) => Promise<string>;
}

const RSA = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

const base64Url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

/** Generate a signing key whose public half is published as the team's JWKS. */
export async function makeSigner(kid = "test-key"): Promise<TestSigner> {
  const keys = await webcrypto.subtle.generateKey(
    { ...RSA, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ["sign", "verify"],
  );

  const publicJwk = await webcrypto.subtle.exportKey("jwk", keys.publicKey);

  return {
    jwks: JSON.stringify({
      keys: [{ kid, kty: "RSA", alg: "RS256", n: publicJwk.n, e: publicJwk.e }],
    }),
    sign: async (claims, signingKid = kid) => {
      const header = base64Url(
        Buffer.from(JSON.stringify({ alg: "RS256", kid: signingKid, typ: "JWT" })),
      );

      const payload = base64Url(Buffer.from(JSON.stringify(claims)));

      const signature = await crypto.subtle.sign(
        RSA,
        keys.privateKey,
        Buffer.from(`${header}.${payload}`),
      );

      return `${header}.${payload}.${base64Url(new Uint8Array(signature))}`;
    },
  };
}

/** Claims Access issues for Executor's service token, valid for five minutes. */
export function serviceTokenClaims(nowSeconds = Math.floor(Date.now() / 1000)) {
  return {
    aud: [AUDIENCE],
    iss: TEAM_DOMAIN,
    iat: nowSeconds,
    exp: nowSeconds + 300,
    type: "app",
    sub: "",
    common_name: EXECUTOR_CLIENT_ID,
  };
}

/** A started Worker and the log of its outbound requests. */
export interface RunningWorker {
  readonly miniflare: Miniflare;
  readonly outbound: OutboundLog;
}

/** Every request the Worker made to the internet, by hostname. */
export interface OutboundLog {
  readonly hosts: Array<string>;
}

/**
 * Start the bundled Worker and its SQLite Durable Object in workerd. The only reachable hosts
 * are the Access team (signing keys) and the fake Bridge; anything else gets 502.
 */
export function startWorker(options: {
  readonly scriptPath: string;
  readonly signer: TestSigner;
  readonly bridge: FakeBridge;
  readonly autoSyncHours: string;
  /** Keep Durable Object and Secrets Store data here, so a later start sees it. */
  readonly persistRoot?: string | undefined;
}): RunningWorker {
  const outbound: OutboundLog = { hosts: [] };

  const miniflare = new Miniflare({
    modules: true,
    scriptPath: options.scriptPath,
    modulesRoot: dirname(options.scriptPath),
    compatibilityDate: supportedCompatibilityDate,
    defaultPersistRoot: options.persistRoot,
    durableObjects: { VAULT: { className: "SimplefinVault", useSQLite: true } },
    bindings: {
      ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
      ACCESS_AUD: AUDIENCE,
      EXECUTOR_CLIENT_ID,
      TIME_ZONE: "America/New_York",
      AUTO_SYNC_HOURS: options.autoSyncHours,
      INITIAL_SYNC_DAYS: "365",
      APP_STAGE: "test",
    },
    secretsStoreSecrets: {
      SIMPLEFIN_ACCESS_URL: { store_id: "test-store", secret_name: "simplefin-access-url" },
    },
    outboundService: async (request: MiniflareRequest) => {
      const url = new URL(request.url);

      outbound.hosts.push(url.hostname);

      if (url.href === `${TEAM_DOMAIN}/cdn-cgi/access/certs`) {
        return new MiniflareResponse(options.signer.jwks, {
          headers: { "content-type": "application/json" },
        });
      }

      if (url.hostname === "bridge.simplefin.org") {
        const answer = await options.bridge.fetch(request.url, {
          method: request.method,
          headers: Object.fromEntries(request.headers.entries()),
          redirect: "manual",
        });

        return new MiniflareResponse(await answer.text(), {
          status: answer.status,
          headers: { "content-type": answer.headers.get("content-type") ?? "text/plain" },
        });
      }

      return new MiniflareResponse("blocked by test", { status: 502 });
    },
  });

  return { miniflare, outbound };
}

/**
 * Pretend `seconds` have passed for a stopped Worker's persisted ledger by moving its sync
 * bookkeeping (runs, requests, lease) back. Data time ranges, such as recorded gaps, stay put.
 */
export async function ageLedger(persistRoot: string, seconds: number): Promise<void> {
  const files = await readdir(join(persistRoot, "do"), { recursive: true });
  let aged = 0;

  for (const file of files.filter((name) => name.endsWith(".sqlite"))) {
    const database = new DatabaseSync(join(persistRoot, "do", file));

    try {
      const tables = database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sync_runs'")
        .all();

      if (tables.length === 0) continue;

      database
        .prepare("UPDATE sync_runs SET started_at = started_at - ?, finished_at = finished_at - ?")
        .run(seconds, seconds);
      database.prepare("UPDATE requests SET at = at - ?").run(seconds);
      database
        .prepare("UPDATE meta SET value = value - ? WHERE key = 'sync_lease' AND value > 0")
        .run(seconds);
      aged += 1;
    } finally {
      database.close();
    }
  }

  if (aged !== 1) throw new Error(`Expected one persisted ledger, found ${aged}.`);
}

/** A temporary directory for {@link startWorker}'s `persistRoot`. */
export function makePersistRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "simplefin-persist-"));
}

/** Call one MCP tool as Executor, with a fresh service-token JWT. */
export async function callTool(
  miniflare: MiniflareInstance,
  signer: TestSigner,
  name: string,
  args: JsonObject = {},
) {
  const token = await signer.sign(serviceTokenClaims());

  const response = await miniflare.dispatchFetch("https://simplefin.example.test/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-11-25",
      "cf-access-jwt-assertion": token,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });

  const raw = await response.text();

  return { status: response.status, raw, result: JSON.parse(raw).result };
}

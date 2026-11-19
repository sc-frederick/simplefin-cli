import type { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import {
  makeFakeBridge,
  sampleTransactions,
  TEST_ACCESS_URL,
  TEST_PASSWORD,
} from "./support/fake-bridge.ts";
import type { JsonObject } from "./support/json.ts";
import type { OutboundLog, TestSigner } from "./support/worker-harness.ts";
import {
  bundleWorker,
  EXECUTOR_CLIENT_ID,
  makeSigner,
  serviceTokenClaims,
  startWorker,
  TEAM_DOMAIN,
} from "./support/worker-harness.ts";

const ORIGIN = "https://simplefin.example.test";
const NOW = Math.floor(Date.now() / 1000);

let bundle: Awaited<ReturnType<typeof bundleWorker>>;
let signer: TestSigner;

beforeAll(async () => {
  bundle = await bundleWorker();
  signer = await makeSigner();
}, 120_000);

afterAll(async () => {
  await bundle.cleanup();
});

const rpc = (id: number, method: string, params: JsonObject = {}) =>
  JSON.stringify({ jsonrpc: "2.0", id, method, params });

async function post(
  miniflare: Miniflare,
  options: {
    readonly token?: string;
    readonly body?: string;
    readonly path?: string;
    readonly headers?: Record<string, string>;
    readonly method?: string;
  },
) {
  const headers = new Headers({
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": "2025-11-25",
  });

  if (options.token !== undefined) headers.set("cf-access-jwt-assertion", options.token);

  for (const [name, value] of Object.entries(options.headers ?? {})) headers.set(name, value);

  const method = options.method ?? "POST";

  const response = await miniflare.dispatchFetch(`${ORIGIN}${options.path ?? "/mcp"}`, {
    method,
    headers: Object.fromEntries(headers.entries()),
    body: method === "GET" ? null : (options.body ?? rpc(1, "ping")),
  });

  return { status: response.status, text: await response.text(), headers: response.headers };
}

async function callTool(miniflare: Miniflare, name: string, args: JsonObject = {}) {
  const token = await signer.sign(serviceTokenClaims());

  const answer = await post(miniflare, {
    token,
    body: rpc(7, "tools/call", { name, arguments: args }),
  });

  expect(answer.status).toBe(200);

  return { raw: answer.text, result: JSON.parse(answer.text).result };
}

describe("edge authentication", () => {
  let miniflare: Miniflare;

  beforeAll(() => {
    miniflare = startWorker({
      scriptPath: bundle.scriptPath,
      signer,
      bridge: makeFakeBridge([]),
      autoSyncHours: "0",
    }).miniflare;
  });

  afterAll(async () => {
    await miniflare.dispose();
  });

  test("rejects requests without an Access token before routing", async () => {
    for (const path of ["/mcp", "/", "/admin"]) {
      const answer = await post(miniflare, { path });

      expect(answer.status).toBe(403);
      expect(answer.text).toBe("Forbidden");
      expect(answer.headers.get("cache-control")).toBe("no-store");
    }
  });

  test("rejects forged, misdirected, expired and other clients' tokens", async () => {
    const forger = await makeSigner("test-key");
    const valid = serviceTokenClaims(NOW);

    const tokens = {
      forgedSignature: await forger.sign(valid),
      unknownKey: await signer.sign(valid, "another-key"),
      wrongAudience: await signer.sign({ ...valid, aud: ["a".repeat(64)] }),
      wrongIssuer: await signer.sign({ ...valid, iss: "https://other-team.cloudflareaccess.com" }),
      expired: await signer.sign({ ...valid, iat: NOW - 7200, exp: NOW - 3600 }),
      otherServiceToken: await signer.sign({
        ...valid,
        common_name: "ffffffffffffffffffffffffffffffff.access",
      }),
      userIdentityToken: await signer.sign({
        aud: valid.aud,
        iss: TEAM_DOMAIN,
        iat: NOW,
        exp: NOW + 300,
        email: "someone@example.com",
        sub: "user-1",
      }),
      unsignedAlgorithm: `${Buffer.from('{"alg":"none","kid":"test-key"}').toString("base64url")}.${Buffer.from(JSON.stringify(valid)).toString("base64url")}.`,
      garbage: "not.a.jwt",
    };

    for (const [name, token] of Object.entries(tokens)) {
      const answer = await post(miniflare, { token });

      expect({ name, status: answer.status }).toEqual({ name, status: 403 });
    }
  });

  test("an authenticated client still cannot use browsers, other methods, paths or payloads", async () => {
    const token = await signer.sign(serviceTokenClaims());

    expect(
      (await post(miniflare, { token, headers: { origin: "https://evil.example" } })).status,
    ).toBe(403);
    expect((await post(miniflare, { token, method: "GET" })).status).toBe(405);
    expect((await post(miniflare, { token, path: "/admin" })).status).toBe(404);
    expect(
      (await post(miniflare, { token, headers: { "content-type": "text/plain" } })).status,
    ).toBe(415);
    expect(
      (await post(miniflare, { token, body: JSON.stringify({ padding: "x".repeat(70_000) }) }))
        .status,
    ).toBe(413);
  });

  test("accepts Executor's service token and speaks MCP", async () => {
    const token = await signer.sign(serviceTokenClaims());

    const initialize = await post(miniflare, {
      token,
      body: rpc(1, "initialize", { protocolVersion: "2025-11-25", capabilities: {} }),
    });

    expect(initialize.status).toBe(200);
    expect(initialize.headers.get("content-type")).toBe("application/json");
    expect(initialize.headers.get("mcp-session-id")).toBeNull();
    expect(JSON.parse(initialize.text).result.serverInfo.name).toBe("simplefin");

    const status = await callTool(miniflare, "sync_status");

    expect(status.result.structuredContent).toMatchObject({
      access_configured: false,
      accounts: 0,
    });
    expect(EXECUTOR_CLIENT_ID).toContain(".access");
  });
});

describe("claimed bridge", () => {
  let miniflare: Miniflare;
  let outbound: OutboundLog;
  const bridge = makeFakeBridge(sampleTransactions(NOW), NOW - 600);

  beforeAll(async () => {
    ({ miniflare, outbound } = startWorker({
      scriptPath: bundle.scriptPath,
      signer,
      bridge,
      autoSyncHours: "0",
    }));

    const secret = await miniflare.getSecretsStoreSecretAPI("SIMPLEFIN_ACCESS_URL");

    await secret().create(TEST_ACCESS_URL);
  });

  afterAll(async () => {
    await miniflare.dispose();
  });

  test("syncs from the Bridge with the stored credential and never reveals it", async () => {
    const synced = await callTool(miniflare, "sync_now");

    expect(synced.result.structuredContent).toMatchObject({
      requests: 9,
      accounts: 2,
      complete: true,
    });
    expect(bridge.received[0]?.authorization).toBe(`Basic ${btoa(`demo-user:${TEST_PASSWORD}`)}`);

    const again = await callTool(miniflare, "sync_now");

    expect(again.result.structuredContent).toMatchObject({ skipped: true });

    const outputs = [
      synced.raw,
      again.raw,
      (await callTool(miniflare, "sync_status")).raw,
      (await callTool(miniflare, "list_accounts")).raw,
      (await callTool(miniflare, "list_transactions", { since: null, limit: 1000 })).raw,
      (await callTool(miniflare, "find_recurring_charges")).raw,
    ];

    expect(JSON.parse(outputs[4] ?? "{}").result.structuredContent.transactions).toHaveLength(37);

    for (const output of outputs) {
      expect(output).not.toContain(TEST_PASSWORD);
      expect(output).not.toContain("demo-user");
      expect(output).not.toContain(btoa(`demo-user:${TEST_PASSWORD}`));
    }

    expect(new Set(outbound.hosts)).toEqual(
      new Set(["example-team.cloudflareaccess.com", "bridge.simplefin.org"]),
    );
  });
});

describe("automatic sync", () => {
  test("the cron watchdog arms an alarm that syncs without any tool call", async () => {
    const bridge = makeFakeBridge(sampleTransactions(NOW), NOW - 600);

    const { miniflare } = startWorker({
      scriptPath: bundle.scriptPath,
      signer,
      bridge,
      autoSyncHours: "12",
    });

    try {
      const secret = await miniflare.getSecretsStoreSecretAPI("SIMPLEFIN_ACCESS_URL");

      await secret().create(TEST_ACCESS_URL);

      const worker = await miniflare.getWorker();

      await worker.scheduled({ cron: "17 * * * *" });

      const deadline = Date.now() + 20_000;

      while (bridge.received.length < 9 && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 200));

      expect(bridge.received).toHaveLength(9);

      const status = await callTool(miniflare, "sync_status");

      expect(status.result.structuredContent).toMatchObject({
        access_configured: true,
        transactions: 37,
      });
    } finally {
      await miniflare.dispose();
    }
  }, 60_000);
});

describe("Durable Object limits", () => {
  let miniflare: Miniflare;

  const busyCard = Array.from({ length: 150 }, (_, index) => ({
    id: `busy-${index}`,
    accountId: "card-1",
    posted: NOW - (index % 40) * 86_400 - 3600,
    amount: "-3.25",
    description: `CORNER STORE ${index}`,
  }));

  const bridge = makeFakeBridge([...sampleTransactions(NOW), ...busyCard], NOW - 600);

  beforeAll(async () => {
    ({ miniflare } = startWorker({
      scriptPath: bundle.scriptPath,
      signer,
      bridge,
      autoSyncHours: "0",
    }));

    const secret = await miniflare.getSecretsStoreSecretAPI("SIMPLEFIN_ACCESS_URL");

    await secret().create(TEST_ACCESS_URL);
  });

  afterAll(async () => {
    await miniflare.dispose();
  });

  test("parallel sync_now calls run one sync, within the request budget", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => callTool(miniflare, "sync_now")),
    );

    const outcomes = results.map((result) => result.result.structuredContent);

    expect(bridge.received).toHaveLength(9);
    expect(outcomes.filter((outcome) => outcome.requests === 9)).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.skipped === true)).toHaveLength(7);
  });

  test("a window with more than 100 transactions per account is stored", async () => {
    const listed = await callTool(miniflare, "list_transactions", {
      account: "Rewards",
      since: null,
      limit: 1000,
    });

    expect(listed.result.isError).toBe(false);
    expect(listed.result.structuredContent.transactions.length).toBeGreaterThan(150);
  });

  test("long searches and account names work despite SQLite's LIKE pattern limit", async () => {
    const search = await callTool(miniflare, "list_transactions", {
      search: "x".repeat(100),
      since: null,
    });

    const account = await callTool(miniflare, "list_transactions", {
      account: "y".repeat(200),
      since: null,
    });

    expect(search.result).toMatchObject({
      isError: false,
      structuredContent: { transactions: [] },
    });
    expect(account.result).toMatchObject({
      isError: false,
      structuredContent: { transactions: [] },
    });
  });
});

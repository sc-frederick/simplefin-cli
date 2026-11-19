import { rm } from "node:fs/promises";
import type { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import type { FakeTransaction } from "./support/fake-bridge.ts";
import { makeFakeBridge, sampleTransactions, TEST_ACCESS_URL } from "./support/fake-bridge.ts";
import type { TestSigner } from "./support/worker-harness.ts";
import {
  ageLedger,
  bundleWorker,
  callTool,
  makePersistRoot,
  makeSigner,
  startWorker,
} from "./support/worker-harness.ts";

/**
 * Sync and alarm behaviour against the bundled Worker and its SQLite Durable Object in workerd.
 * Tests that need time to pass stop the Worker, age its persisted ledger, and start it again.
 */

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;
const HOUR = 3600;

let bundle: Awaited<ReturnType<typeof bundleWorker>>;
let signer: TestSigner;
const roots: Array<string> = [];

beforeAll(async () => {
  bundle = await bundleWorker();
  signer = await makeSigner();
}, 120_000);

afterAll(async () => {
  await bundle.cleanup();

  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function persistRoot(): Promise<string> {
  const root = await makePersistRoot();

  roots.push(root);

  return root;
}

/** Start the Worker; with `claim`, store the test access URL first, as `pnpm claim` would. */
async function start(
  bridge: ReturnType<typeof makeFakeBridge>,
  autoSyncHours: string,
  root: string | undefined,
  claim: boolean,
): Promise<Miniflare> {
  const { miniflare } = startWorker({
    scriptPath: bundle.scriptPath,
    signer,
    bridge,
    autoSyncHours,
    persistRoot: root,
  });

  if (claim) {
    const secret = await miniflare.getSecretsStoreSecretAPI("SIMPLEFIN_ACCESS_URL");

    await secret().create(TEST_ACCESS_URL);
  }

  return miniflare;
}

const tool = async (miniflare: Miniflare, name: string, args = {}) =>
  (await callTool(miniflare, signer, name, args)).result.structuredContent;

/** Fire the hourly cron, then wait for the alarm's sync to be recorded as finished. */
async function runAlarmSync(miniflare: Miniflare, previousStart: string | null) {
  const worker = await miniflare.getWorker();

  await worker.scheduled({ cron: "17 * * * *" });

  const deadline = Date.now() + 20_000;

  for (;;) {
    const status = await tool(miniflare, "sync_status");
    const attempt = status.last_attempt;

    if (attempt !== null && attempt.finished_at !== null && attempt.started_at !== previousStart) {
      return status;
    }

    if (Date.now() > deadline) throw new Error("The alarm never finished a sync.");

    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

const transactionIds = async (miniflare: Miniflare, search: string | null = null) =>
  (
    await tool(miniflare, "list_transactions", { since: null, limit: 1000, search })
  ).transactions.map((transaction: { readonly id: string }) => transaction.id);

describe("incomplete backfills", () => {
  test("a window that failed for one account is re-fetched before the checkpoint advances", async () => {
    const history: Array<FakeTransaction> = [
      {
        id: "old-cafe",
        accountId: "card-1",
        posted: NOW - 180 * DAY,
        amount: "-4.50",
        description: "OLD CORNER CAFE",
      },
      {
        id: "older-cafe",
        accountId: "card-1",
        posted: NOW - 300 * DAY,
        amount: "-5.50",
        description: "OLDER CORNER CAFE",
      },
    ];

    const bridge = makeFakeBridge([...sampleTransactions(NOW), ...history], NOW - 600);
    const root = await persistRoot();

    // 1. The card's institution fails during the whole 365-day backfill.
    bridge.errlist = [{ code: "act.sync", msg: "Temporary problem", account_id: "card-1" }];

    let miniflare = await start(bridge, "0", root, true);
    const backfill = await tool(miniflare, "sync_now");

    expect(backfill).toMatchObject({ requests: 9, complete: false, windows_to_retry: 9 });
    expect(await transactionIds(miniflare, "CORNER CAFE")).toEqual([]);

    await miniflare.dispose();

    // 2. The card recovers. Thirteen hours later the alarm syncs the recent window plus the
    // four newest missed windows, which reach the 180-day-old charge.
    bridge.errlist = [];
    await ageLedger(root, 13 * HOUR);
    miniflare = await start(bridge, "12", root, false);

    const before = (await tool(miniflare, "sync_status")).last_attempt.started_at;
    const retried = await runAlarmSync(miniflare, before);

    expect(await transactionIds(miniflare, "CORNER CAFE")).toEqual(["old-cafe"]);
    expect(bridge.received).toHaveLength(9 + 5);
    expect(retried.last_attempt).toMatchObject({ ok: true, complete: false });

    await miniflare.dispose();

    // 3. The next sync fetches the rest, and only then reports the history complete.
    await ageLedger(root, 13 * HOUR);
    miniflare = await start(bridge, "0", root, false);

    try {
      const finished = await tool(miniflare, "sync_now");

      expect(finished).toMatchObject({ requests: 5, complete: true, windows_to_retry: 0 });
      expect(await transactionIds(miniflare, "CORNER CAFE")).toEqual(["old-cafe", "older-cafe"]);
    } finally {
      await miniflare.dispose();
    }
  }, 90_000);
});

describe("pending transactions", () => {
  test("an unreadable copy of a pending transaction does not delete the stored one", async () => {
    const transactions = sampleTransactions(NOW);
    const bridge = makeFakeBridge(transactions, NOW - 600);
    const root = await persistRoot();
    let miniflare = await start(bridge, "0", root, true);

    expect(await tool(miniflare, "sync_now")).toMatchObject({ complete: true });
    expect(await transactionIds(miniflare, "PUBLIX")).toEqual(["pending-groceries"]);

    await miniflare.dispose();

    bridge.transactions = transactions.map((transaction) =>
      transaction.id === "pending-groceries" ? { ...transaction, amount: "lots" } : transaction,
    );

    await ageLedger(root, 2 * HOUR);
    miniflare = await start(bridge, "0", root, false);

    try {
      const synced = await tool(miniflare, "sync_now");

      expect(synced).toMatchObject({ complete: false });
      expect(synced.errors).toContain(
        "1 transaction record(s) could not be read and were skipped.",
      );
      expect(await transactionIds(miniflare, "PUBLIX")).toEqual(["pending-groceries"]);
    } finally {
      await miniflare.dispose();
    }
  }, 60_000);
});

describe("upstream ids", () => {
  test("ids that differ only past 256 characters or in hidden characters are kept apart", async () => {
    const prefix = "x".repeat(300);

    const lookalikes = [`${prefix}-1`, `${prefix}-2`, "zw\u200bid", "zw\u2060id"].map(
      (id, index): FakeTransaction => ({
        id,
        accountId: "checking-1",
        posted: NOW - (index + 1) * DAY,
        amount: "-1.00",
        description: `LOOKALIKE ${index}`,
      }),
    );

    const bridge = makeFakeBridge(lookalikes, NOW - 600);
    const miniflare = await start(bridge, "0", undefined, true);

    try {
      expect(await tool(miniflare, "sync_now")).toMatchObject({ complete: true });

      const ids = await transactionIds(miniflare, "LOOKALIKE");

      expect(ids).toHaveLength(4);
      // Agents still see cleaned, bounded ids.
      expect(ids).toEqual([`${"x".repeat(255)}…`, `${"x".repeat(255)}…`, "zw id", "zw id"]);
    } finally {
      await miniflare.dispose();
    }
  }, 60_000);
});

describe("invalid Bridge responses", () => {
  test("an HTTP 200 without accounts fails the alarm's sync and records no success", async () => {
    const bridge = makeFakeBridge([]);

    bridge.failure = { status: 200, body: "{}" };

    const miniflare = await start(bridge, "12", undefined, true);

    try {
      const status = await runAlarmSync(miniflare, null);

      expect(bridge.received).toHaveLength(1);
      expect(status).toMatchObject({
        last_successful_sync: null,
        last_attempt: { ok: false, complete: false },
      });
      expect(status.last_attempt.errors).toContain("SimpleFIN returned an unexpected response.");
    } finally {
      await miniflare.dispose();
    }
  }, 60_000);

  test("a general Bridge error leaves the sync incomplete, with its windows to retry", async () => {
    const bridge = makeFakeBridge(sampleTransactions(NOW), NOW - 600);

    bridge.errlist = [{ code: "gen.maintenance", msg: "Bridge maintenance" }];

    const miniflare = await start(bridge, "0", undefined, true);

    try {
      expect(await tool(miniflare, "sync_now")).toMatchObject({
        requests: 9,
        complete: false,
        windows_to_retry: 9,
        errors: ["Bridge maintenance"],
      });
    } finally {
      await miniflare.dispose();
    }
  }, 60_000);
});

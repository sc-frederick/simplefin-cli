import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, test } from "vite-plus/test";
import { LedgerQueries } from "../src/app/ledger-queries.ts";
import { AutoSyncOutcome, SyncService } from "../src/app/sync-service.ts";
import { LedgerStore } from "../src/store/ledger-store.ts";
import {
  makeFakeBridge,
  sampleTransactions,
  TEST_ACCESS_URL,
  TEST_PASSWORD,
} from "./support/fake-bridge.ts";
import { runLedger, START_MS } from "./support/ledger-harness.ts";

const NOW = START_MS / 1000;
const autoSync = SyncService.use((sync) => sync.autoSync);
const manualSync = SyncService.use((sync) => sync.manualSync);
const status = SyncService.use((sync) => sync.status);

describe("automatic sync", () => {
  test("first sync backfills history, then waits for the configured interval", async () => {
    const bridge = makeFakeBridge(sampleTransactions(NOW), NOW - 600);

    const result = await runLedger(
      { bridge, accessUrl: () => TEST_ACCESS_URL },
      Effect.gen(function* () {
        const first = yield* autoSync;
        const second = yield* autoSync;
        const report = yield* status;

        return { first, second, report };
      }),
    );

    expect(AutoSyncOutcome.$is("Synced")(result.first)).toBe(true);
    // 365 days of history in 45-day windows.
    expect(bridge.received).toHaveLength(9);
    expect(bridge.received.every((request) => request.redirect === "manual")).toBe(true);
    expect(bridge.received.every((request) => !request.url.href.includes(TEST_PASSWORD))).toBe(
      true,
    );
    expect(bridge.received[0]?.url.origin).toBe("https://bridge.simplefin.org");
    expect(result.second).toEqual(AutoSyncOutcome.Fresh({ nextCheck: NOW + 12 * 3600 }));
    expect(result.report).toMatchObject({
      access_configured: true,
      accounts: 2,
      transactions: 37,
      requests_last_24h: 9,
    });
  });

  test("does nothing until an access URL is claimed", async () => {
    const bridge = makeFakeBridge([]);

    const outcome = await runLedger({ bridge, accessUrl: () => null }, autoSync);

    expect(outcome).toEqual(AutoSyncOutcome.NotConnected());
    expect(bridge.received).toHaveLength(0);
  });

  test("revoked access backs off for a day, and a new claim clears the backoff", async () => {
    const bridge = makeFakeBridge(sampleTransactions(NOW), NOW - 600);
    let accessUrl = TEST_ACCESS_URL;

    bridge.failure = { status: 403, body: "Forbidden" };

    const result = await runLedger(
      { bridge, accessUrl: () => accessUrl },
      Effect.gen(function* () {
        const revoked = yield* autoSync;

        yield* TestClock.adjust("4 hours");

        const stillBlocked = yield* autoSync;

        bridge.failure = null;
        accessUrl = TEST_ACCESS_URL.replace("demo-user", "new-user");

        const afterClaim = yield* autoSync;

        return { revoked, stillBlocked, afterClaim };
      }),
    );

    expect(result.revoked).toEqual(
      AutoSyncOutcome.Failed({
        nextCheck: NOW + 86_400,
        error:
          "SimpleFIN rejected the access credentials (revoked or invalid). Create a new setup token and run the claim script again.",
      }),
    );
    expect(AutoSyncOutcome.$is("Leased")(result.stillBlocked)).toBe(true);
    expect(AutoSyncOutcome.$is("Synced")(result.afterClaim)).toBe(true);
  });

  test("ordinary failures retry no sooner than three hours", async () => {
    const bridge = makeFakeBridge([]);

    bridge.failure = { status: 503, body: "Service Unavailable" };

    const result = await runLedger(
      { bridge, accessUrl: () => TEST_ACCESS_URL },
      Effect.gen(function* () {
        const failed = yield* autoSync;

        yield* TestClock.adjust("1 hour");

        return { failed, retry: yield* autoSync };
      }),
    );

    expect(result.failed).toEqual(
      AutoSyncOutcome.Failed({
        nextCheck: NOW + 3 * 3600,
        error: "GET /accounts failed with HTTP 503.",
      }),
    );
    expect(AutoSyncOutcome.$is("Leased")(result.retry)).toBe(true);
    expect(bridge.received).toHaveLength(1);
  });

  test("CDN blocks and redirects are reported without following them", async () => {
    const bridge = makeFakeBridge([]);

    const result = await runLedger(
      { bridge, accessUrl: () => TEST_ACCESS_URL },
      Effect.gen(function* () {
        bridge.failure = { status: 403, body: "error code: 1010" };

        const blocked = yield* manualSync;

        yield* TestClock.adjust("11 minutes");
        bridge.failure = { status: 302, body: "", location: "http://attacker.example/" };

        return { blocked, redirected: yield* manualSync };
      }),
    );

    expect(result.blocked).toEqual({
      error: "Request blocked by the Bridge's CDN (error code: 1010), not by SimpleFIN auth.",
    });

    expect(result.redirected).toEqual({ error: "GET /accounts failed with HTTP 302." });
    expect(bridge.received.map((request) => request.url.hostname)).toEqual([
      "bridge.simplefin.org",
      "bridge.simplefin.org",
    ]);
  });
});

describe("manual sync", () => {
  test("refuses within an hour of a sync and respects the daily budget", async () => {
    const bridge = makeFakeBridge(sampleTransactions(NOW), NOW - 600);

    const result = await runLedger(
      { bridge, accessUrl: () => TEST_ACCESS_URL },
      Effect.gen(function* () {
        yield* autoSync;
        yield* TestClock.adjust("20 minutes");

        const tooSoon = yield* manualSync;

        // Burn the rest of the budget: 9 backfill requests plus 11 more is the 20/day limit.
        for (let index = 0; index < 11; index += 1)
          yield* LedgerStore.use((store) => store.beginRequest);

        yield* TestClock.adjust("2 hours");

        return { tooSoon, overBudget: yield* manualSync };
      }),
    );

    expect(result.tooSoon).toMatchObject({ skipped: true });
    expect(result.overBudget).toMatchObject({
      error: expect.stringContaining("local budget is 20/day"),
    });
    expect(bridge.received).toHaveLength(9);
  });

  test("replaces pending transactions that posted under a new id", async () => {
    const transactions = sampleTransactions(NOW);
    const bridge = makeFakeBridge(transactions, NOW - 600);

    const pending = await runLedger(
      { bridge, accessUrl: () => TEST_ACCESS_URL },
      Effect.gen(function* () {
        yield* autoSync;

        const before = yield* LedgerQueries.use((queries) =>
          queries.transactions({
            account: null,
            since: null,
            until: null,
            search: "PUBLIX",
            minAmount: null,
            maxAmount: null,
            pending: null,
            limit: 10,
          }),
        );

        bridge.transactions = [
          ...transactions.filter((transaction) => transaction.pending !== true),
          {
            id: "posted-groceries",
            accountId: "card-1",
            posted: NOW - 3600,
            amount: "-82.13",
            description: "PUBLIX SUPER MARKETS 100% ORGANIC",
          },
        ];

        yield* TestClock.adjust("2 hours");
        yield* manualSync;

        const after = yield* LedgerQueries.use((queries) =>
          queries.transactions({
            account: null,
            since: null,
            until: null,
            search: "PUBLIX",
            minAmount: null,
            maxAmount: null,
            pending: null,
            limit: 10,
          }),
        );

        return { before: before.transactions, after: after.transactions };
      }),
    );

    expect(pending.before.map((transaction) => [transaction.id, transaction.pending])).toEqual([
      ["pending-groceries", true],
    ]);
    expect(pending.after.map((transaction) => [transaction.id, transaction.pending])).toEqual([
      ["posted-groceries", false],
    ]);
  });
});

describe("queries", () => {
  test("filter, summarize and detect subscriptions without exposing credentials", async () => {
    const bridge = makeFakeBridge(sampleTransactions(NOW), NOW - 600);

    const result = await runLedger(
      { bridge, accessUrl: () => TEST_ACCESS_URL },
      Effect.gen(function* () {
        yield* autoSync;

        const queries = yield* LedgerQueries;

        return {
          accounts: yield* queries.accounts,
          bigCharges: yield* queries.transactions({
            account: "checking",
            since: null,
            until: null,
            search: null,
            minAmount: null,
            maxAmount: "-200",
            pending: false,
            limit: 100,
          }),
          literalPercent: yield* queries.transactions({
            account: null,
            since: null,
            until: null,
            search: "100%",
            minAmount: null,
            maxAmount: null,
            pending: null,
            limit: 5,
          }),
          wildcard: yield* queries.transactions({
            account: null,
            since: null,
            until: null,
            search: "%",
            minAmount: null,
            maxAmount: null,
            pending: null,
            limit: 5,
          }),
          cashFlow: yield* queries.cashFlow({ account: "Rewards", since: "90d", until: null }),
          recurring: yield* queries.recurring({
            since: null,
            minOccurrences: 2,
            includeInactive: false,
            includeIncome: true,
          }),
          merchants: yield* queries.topMerchants({
            since: "200d",
            until: null,
            limit: 3,
            includeTransfers: false,
          }),
          status: yield* status,
        };
      }),
    );

    expect(result.accounts.accounts.map((account) => account.institution)).toEqual([
      "Example Card Co",
      "First Example Bank",
    ]);

    expect(result.bigCharges.transactions.map((transaction) => transaction.amount)).toEqual(
      Array(6).fill("-500.00"),
    );
    expect(result.literalPercent.transactions).toHaveLength(1);
    expect(result.wildcard.transactions).toHaveLength(1);
    expect(result.cashFlow.accounts).toEqual([
      {
        account: "Rewards Card (9876)",
        currency: "USD",
        transactions: 9,
        money_in: "0.00",
        money_out: expect.any(String),
      },
    ]);

    const series = new Map(result.recurring.recurring.map((entry) => [entry.merchant, entry]));

    expect(series.get("NETFLIX.COM")).toMatchObject({
      cadence: "monthly",
      kind: "subscription",
      confidence: "high",
      typical_amount: "15.49",
    });
    expect(series.get("SPOTIFY")).toMatchObject({ cadence: "monthly", typical_amount: "11.99" });
    expect(series.get("ACME CORP PAYROLL")).toMatchObject({ direction: "in" });
    expect(series.has("ONLINE TRANSFER TO SAVINGS")).toBe(false);
    // Tap-to-pay purchases that vary in price are shopping, not subscriptions.
    expect(series.has("BLUE BOTTLE")).toBe(false);
    expect(result.merchants.merchants.map((merchant) => merchant.merchant)).toEqual([
      "FPL DIRECT DEBIT",
      "NETFLIX.COM",
      "SPOTIFY",
    ]);

    expect(JSON.stringify(result)).not.toContain(TEST_PASSWORD);
    expect(JSON.stringify(result)).not.toContain("demo-user");
  });
});

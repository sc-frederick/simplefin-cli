import { inspect } from "node:util";
import { Redacted, Result } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { calendarFor, DAY } from "../src/domain/dates.ts";
import { merchantKey } from "../src/domain/merchants.ts";
import { formatCents, parseAmountCents } from "../src/domain/money.ts";
import { planWindows, WINDOW_DAYS } from "../src/domain/sync-plan.ts";
import { sanitizeText } from "../src/domain/text.ts";
import { parseAccountSet } from "../src/simplefin/account-set.ts";
import { decodeSetupToken, parseAccessUrl } from "../src/simplefin/credentials.ts";
import { TIME_ZONE } from "./support/ledger-harness.ts";

describe("merchant names", () => {
  test("strip processors, store numbers and states like the upstream CLI", () => {
    expect(merchantKey("PAYPAL *AUTODESK 4029357733 CA")).toBe("AUTODESK");
    expect(merchantKey("AplPay CHICK-FIL-A #JACKSONVILLE FL")).toBe("CHICK-FIL-A");
    expect(merchantKey("APPLE.COM/BILL 866-712-7753 CA")).toBe("APPLE.COM");
    expect(merchantKey("SQ *BLUE BOTTLE COFFEE")).toBe("BLUE BOTTLE COFFEE");
    expect(merchantKey("   ")).toBe("UNKNOWN");
  });
});

describe("money", () => {
  test("parses decimal strings into cents, rounding half to even", () => {
    expect(Result.getOrThrow(parseAmountCents("-12.34"))).toBe(-1234);
    expect(Result.getOrThrow(parseAmountCents("5"))).toBe(500);
    expect(Result.getOrThrow(parseAmountCents("0.125"))).toBe(12);
    expect(Result.getOrThrow(parseAmountCents("0.135"))).toBe(14);
    expect(Result.getOrThrow(parseAmountCents("-0.001"))).toBe(0);
    expect(Result.isFailure(parseAmountCents("1,000.00"))).toBe(true);
    expect(Result.isFailure(parseAmountCents("1e9"))).toBe(true);
  });

  test("formats cents with sign and two decimals", () => {
    expect(formatCents(-1234)).toBe("-12.34");
    expect(formatCents(5)).toBe("0.05");
    expect(formatCents(0)).toBe("0.00");
  });
});

describe("calendar", () => {
  const calendar = calendarFor(TIME_ZONE);
  const now = Date.UTC(2026, 9, 15, 16) / 1000;

  test("renders timestamps with the zone's offset across DST", () => {
    expect(calendar.format(Date.UTC(2026, 6, 1, 12) / 1000)).toBe("2026-07-01T08:00:00-04:00");
    expect(calendar.format(Date.UTC(2026, 11, 1, 12) / 1000)).toBe("2026-12-01T07:00:00-05:00");
  });

  test("parses calendar dates as local midnight, relative days, and explicit offsets", () => {
    expect(Result.getOrThrow(calendar.parseFilter("2026-12-01", now))).toBe(
      Date.UTC(2026, 11, 1, 5) / 1000,
    );
    expect(Result.getOrThrow(calendar.parseFilter("30d", now))).toBe(now - 30 * DAY);
    expect(Result.getOrThrow(calendar.parseFilter("2026-10-01T00:00:00Z", now))).toBe(
      Date.UTC(2026, 9, 1) / 1000,
    );
    expect(Result.isFailure(calendar.parseFilter("2026-02-30", now))).toBe(true);
    expect(Result.isFailure(calendar.parseFilter("yesterday", now))).toBe(true);
  });
});

describe("sync windows", () => {
  const now = 1_800_000_000;

  test("the first sync backfills the configured history in 45-day windows", () => {
    const windows = planWindows(now, { lastSuccess: null, lastComplete: null }, 365);

    expect(windows).toHaveLength(Math.ceil((365 + 1) / WINDOW_DAYS));
    expect(windows[0]?.end).toBe(now + DAY);
    expect(windows.at(-1)?.start).toBe(now - 365 * DAY);
  });

  test("routine syncs never reach back more than two windows", () => {
    expect(
      planWindows(now, { lastSuccess: now - 3600, lastComplete: now - 3600 }, 365),
    ).toHaveLength(1);
    expect(planWindows(now, { lastSuccess: now, lastComplete: now - 400 * DAY }, 365)).toHaveLength(
      2,
    );
    // Without a complete sync, fetch one window rather than repeating the backfill.
    expect(planWindows(now, { lastSuccess: now - 3600, lastComplete: null }, 365)).toHaveLength(1);
  });
});

describe("credentials", () => {
  test("setup tokens must decode to an HTTPS claim URL on a SimpleFIN host", () => {
    const valid = btoa("https://bridge.simplefin.org/simplefin/claim/abc123");

    expect(Result.getOrThrow(decodeSetupToken(`  ${valid}\n`)).href).toBe(
      "https://bridge.simplefin.org/simplefin/claim/abc123",
    );

    for (const forged of [
      btoa("https://attacker.example/simplefin/claim/abc"),
      btoa("http://bridge.simplefin.org/simplefin/claim/abc"),
      btoa("https://bridge.simplefin.org:8443/claim"),
      "not base64 at all!",
      "",
    ]) {
      expect(Result.isFailure(decodeSetupToken(forged))).toBe(true);
    }
  });

  test("access URLs split into a credential-free base URL and a redacted header", () => {
    const parsed = Result.getOrThrow(
      parseAccessUrl(Redacted.make("https://user:p%40ss@bridge.simplefin.org/simplefin/")),
    );

    expect(parsed.baseUrl).toBe("https://bridge.simplefin.org/simplefin");
    expect(Redacted.value(parsed.authorization)).toBe(`Basic ${btoa("user:p@ss")}`);
    expect(inspect(parsed.authorization)).not.toContain("p@ss");
    expect(JSON.stringify(parsed)).not.toContain(btoa("user:p@ss"));

    for (const rejected of [
      "https://bridge.simplefin.org/simplefin",
      "https://user:pass@evil.example/simplefin",
      "http://user:pass@bridge.simplefin.org/simplefin",
      "https://user:pass@bridge.simplefin.org/simplefin?x=1",
      "https://user:%zz@bridge.simplefin.org/simplefin",
    ]) {
      expect(Result.isFailure(parseAccessUrl(Redacted.make(rejected)))).toBe(true);
    }
  });
});

describe("bank text", () => {
  test("hidden and control characters are removed and length is bounded", () => {
    const [rightToLeftOverride, bell, zeroWidthSpace] = [0x202e, 0x07, 0x200b].map((code) =>
      String.fromCodePoint(code),
    );

    expect(sanitizeText(`PAY${rightToLeftOverride}LAP${bell} ${zeroWidthSpace}ME\n\nNOW`)).toBe(
      "PAY LAP ME NOW",
    );
    expect(sanitizeText("x".repeat(1000))).toHaveLength(300);
  });
});

describe("account set parsing", () => {
  test("skips unreadable records, keeps the rest, and flags the window for re-fetch", () => {
    const parsed = Result.getOrThrow(
      parseAccountSet(
        JSON.stringify({
          errlist: [{ code: "act.auth", msg: "Reconnect\u0000 your bank", account_id: "a1" }],
          connections: [{ conn_id: "c1", org_name: "Bank" }],
          accounts: [
            {
              id: "a1",
              conn_id: "c1",
              name: "Checking",
              balance: "10.00",
              "balance-date": 1_800_000_000,
              transactions: [
                { id: "t1", posted: 1_800_000_000, amount: "-1.50", description: "Coffee" },
                { id: "t2", posted: 1_800_000_000, amount: "lots", description: "Broken" },
                { posted: 1_800_000_000, amount: "-3.00" },
              ],
            },
            { name: "no id" },
          ],
        }),
      ),
    );

    expect(parsed.accounts.map((account) => account.id)).toEqual(["a1"]);
    expect(parsed.accounts[0]?.transactions?.map((transaction) => transaction.amountCents)).toEqual(
      [-150],
    );
    expect(parsed.hasDataErrors).toBe(true);
    expect(parsed.accountsWithErrors.has("a1")).toBe(true);
    expect(parsed.messages).toContain("Reconnect your bank");
    expect(parsed.messages.some((message) => message.includes("2 transaction record(s)"))).toBe(
      true,
    );
    expect(parsed.messages.some((message) => message.includes("1 account record(s)"))).toBe(true);
  });

  test("rejects bodies that are not JSON objects", () => {
    expect(Result.isFailure(parseAccountSet("<html>"))).toBe(true);
    expect(Result.isFailure(parseAccountSet('"accounts"'))).toBe(true);
  });
});

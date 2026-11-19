import type { FetchFunction } from "../../src/simplefin/bridge-client.ts";

/** The access URL tests claim; its password must never appear in any output. */
export const TEST_ACCESS_URL =
  "https://demo-user:correct-horse-battery-staple@bridge.simplefin.org/simplefin";

/** The secret part of {@link TEST_ACCESS_URL}. */
export const TEST_PASSWORD = "correct-horse-battery-staple";

/** One fake transaction, posted at `posted` (epoch seconds). */
export interface FakeTransaction {
  readonly id: string;
  readonly accountId: string;
  readonly posted: number;
  readonly amount: string;
  readonly description: string;
  readonly payee?: string;
  readonly pending?: boolean;
}

/** One request the fake Bridge received. */
export interface ReceivedRequest {
  readonly url: URL;
  readonly authorization: string | null;
  readonly redirect: string | undefined;
}

/** A stand-in for SimpleFIN Bridge's /accounts endpoint with scripted failures. */
export interface FakeBridge {
  readonly fetch: FetchFunction;
  readonly received: Array<ReceivedRequest>;
  transactions: Array<FakeTransaction>;
  /** When set, every request gets this response instead of data. */
  failure: { readonly status: number; readonly body: string; readonly location?: string } | null;
  /**
   * Bridge-level error entries added to every response. Like the real Bridge, an account with an
   * act.* entry comes back without its transactions.
   */
  errlist: Array<BridgeError>;
  /** Extra error entries for one request window, on top of {@link errlist}. */
  windowErrors: (start: number, end: number) => Array<BridgeError>;
  /** The accounts every response lists. */
  accounts: Array<FakeAccount>;
  /** Raw records appended to every response's account list, unchecked. */
  extraAccounts: Array<unknown>;
}

/** One Bridge errlist entry. */
export interface BridgeError {
  readonly code: string;
  readonly msg: string;
  readonly account_id?: string;
}

/** One account the fake Bridge lists. */
export interface FakeAccount {
  readonly id: string;
  readonly conn_id: string;
  readonly name: string;
  readonly currency: string;
  readonly balance: string;
}

const DAY = 86_400;

/** A household's worth of history ending at `now`: subscriptions, bills, shopping and transfers. */
export function sampleTransactions(now: number): Array<FakeTransaction> {
  const transactions: Array<FakeTransaction> = [];

  for (let month = 0; month < 6; month += 1) {
    const at = now - (month * 30 + 3) * DAY;

    transactions.push(
      {
        id: `netflix-${month}`,
        accountId: "card-1",
        posted: at,
        amount: "-15.49",
        description: "NETFLIX.COM 866-579-7172 CA",
      },
      {
        id: `spotify-${month}`,
        accountId: "card-1",
        posted: at - DAY,
        amount: "-11.99",
        description: "PAYPAL *SPOTIFY 4029357733 CA",
      },
      {
        id: `power-${month}`,
        accountId: "checking-1",
        posted: at - 2 * DAY,
        amount: `-${(120 + month * 7).toFixed(2)}`,
        description: "FPL DIRECT DEBIT ELEC PYMT",
      },
      {
        id: `transfer-${month}`,
        accountId: "checking-1",
        posted: at - 4 * DAY,
        amount: "-500.00",
        description: "ONLINE TRANSFER TO SAVINGS 1234",
      },
      {
        id: `salary-${month}`,
        accountId: "checking-1",
        posted: at - 5 * DAY,
        amount: "3200.00",
        description: "ACME CORP PAYROLL",
      },
      {
        id: `coffee-${month}`,
        accountId: "card-1",
        posted: at - 6 * DAY,
        amount: `-${(4 + month).toFixed(2)}`,
        description: "AplPay BLUE BOTTLE #123 JACKSONVILLE FL",
      },
    );
  }

  transactions.push({
    id: "pending-groceries",
    accountId: "card-1",
    posted: 0,
    amount: "-82.13",
    description: "PUBLIX SUPER MARKETS 100% ORGANIC",
    pending: true,
  });

  return transactions;
}

const ACCOUNTS: ReadonlyArray<FakeAccount> = [
  {
    id: "checking-1",
    conn_id: "conn-bank",
    name: "Everyday Checking (1234)",
    currency: "USD",
    balance: "4210.55",
  },
  {
    id: "card-1",
    conn_id: "conn-card",
    name: "Rewards Card (9876)",
    currency: "USD",
    balance: "-512.40",
  },
];

/**
 * Build a fake Bridge serving `transactions` within each requested window. Pending transactions
 * are dated `pendingAt`, as the real Bridge reports one transacted_at per pending charge.
 */
export function makeFakeBridge(
  transactions: Array<FakeTransaction>,
  pendingAt = 1_792_080_000,
): FakeBridge {
  const bridge: FakeBridge = {
    received: [],
    transactions,
    failure: null,
    errlist: [],
    windowErrors: () => [],
    accounts: [...ACCOUNTS],
    extraAccounts: [],
    fetch: async (input, init) => {
      const url = new URL(input);
      const headers = new Headers(init.headers);

      bridge.received.push({
        url,
        authorization: headers.get("authorization"),
        redirect: init.redirect,
      });

      if (bridge.failure !== null) {
        const failureHeaders: Record<string, string> =
          bridge.failure.location === undefined ? {} : { location: bridge.failure.location };

        return new Response(bridge.failure.body, {
          status: bridge.failure.status,
          headers: failureHeaders,
        });
      }

      const start = Number(url.searchParams.get("start-date"));
      const end = Number(url.searchParams.get("end-date"));

      const errlist = [...bridge.errlist, ...bridge.windowErrors(start, end)];

      const failing = new Set(
        errlist.flatMap((error) =>
          error.code.startsWith("act.") && error.account_id !== undefined ? [error.account_id] : [],
        ),
      );

      const body = {
        errors: [],
        errlist,
        connections: [
          {
            conn_id: "conn-bank",
            name: "Bank login",
            org_id: "bank",
            org_name: "First Example Bank",
            org_url: "https://bank.example",
          },
          {
            conn_id: "conn-card",
            name: "Card login",
            org_id: "card",
            org_name: "Example Card Co",
            org_url: "https://card.example",
          },
        ],
        accounts: [
          ...bridge.accounts.map((account) => ({
            ...account,
            "available-balance": account.balance,
            "balance-date": pendingAt,
            transactions: bridge.transactions
              .filter((transaction) => transaction.accountId === account.id)
              .filter(() => !failing.has(account.id))
              .filter((transaction) => {
                const at = transaction.pending === true ? pendingAt : transaction.posted;

                return at >= start && at < end;
              })
              .map((transaction) => ({
                id: transaction.id,
                posted: transaction.posted,
                transacted_at: transaction.pending === true ? pendingAt : transaction.posted,
                amount: transaction.amount,
                description: transaction.description,
                payee: transaction.payee ?? null,
                memo: null,
                pending: transaction.pending === true,
              })),
          })),
          ...bridge.extraAccounts,
        ],
      };

      return Response.json(body);
    },
  };

  return bridge;
}

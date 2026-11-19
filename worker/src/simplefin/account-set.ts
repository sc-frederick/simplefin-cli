import { Result, Schema } from "effect";
import type { EpochSeconds } from "../domain/dates.ts";
import { parseAmountCents } from "../domain/money.ts";
import { sanitizeOptionalText, sanitizeText } from "../domain/text.ts";

const Identifier = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512));
const OptionalText = Schema.optional(Schema.NullOr(Schema.String));
const OptionalTimestamp = Schema.optional(Schema.NullOr(Schema.Finite));
const DecimalValue = Schema.Union([Schema.String, Schema.Finite]);

/**
 * Raw /accounts envelope; records inside are decoded one at a time so one bad record can't block
 * a sync. `accounts` is required: a body without it is not an account set, even with HTTP 200.
 */
const AccountSetResponse = Schema.Struct({
  connections: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
  accounts: Schema.Array(Schema.Unknown),
  errlist: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
  errors: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
});

const ConnectionResponse = Schema.Struct({
  conn_id: Identifier,
  name: OptionalText,
  org_id: OptionalText,
  org_name: OptionalText,
  org_url: OptionalText,
  sfin_url: OptionalText,
});

const AccountResponse = Schema.Struct({
  id: Identifier,
  conn_id: OptionalText,
  name: OptionalText,
  currency: OptionalText,
  balance: Schema.optional(Schema.NullOr(DecimalValue)),
  "available-balance": Schema.optional(Schema.NullOr(DecimalValue)),
  "balance-date": OptionalTimestamp,
  transactions: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
});

const TransactionResponse = Schema.Struct({
  id: Identifier,
  posted: OptionalTimestamp,
  transacted_at: OptionalTimestamp,
  amount: DecimalValue,
  description: OptionalText,
  payee: OptionalText,
  memo: OptionalText,
  pending: Schema.optional(Schema.NullOr(Schema.Boolean)),
});

const ErrorResponse = Schema.Struct({ code: OptionalText, msg: OptionalText });

/** A SimpleFIN connection (one institution login). */
export interface Connection {
  /** The upstream id, unchanged: the storage key. */
  readonly connId: string;
  readonly name: string | null;
  readonly orgId: string | null;
  readonly orgName: string | null;
  readonly orgUrl: string | null;
}

/** One transaction as stored. */
export interface Transaction {
  /** The upstream id, unchanged: the storage key. Show it only through {@link displayId}. */
  readonly id: string;
  readonly posted: EpochSeconds;
  readonly transactedAt: EpochSeconds | null;
  readonly amount: string;
  readonly amountCents: number;
  readonly description: string;
  readonly payee: string | null;
  readonly memo: string | null;
  readonly pending: boolean;
}

/** One account with its balance and, when requested, its transactions in the window. */
export interface Account {
  /** The upstream id, unchanged: the storage key. Show it only through {@link displayId}. */
  readonly id: string;
  readonly connId: string | null;
  readonly name: string;
  readonly currency: string | null;
  readonly balance: string | null;
  readonly availableBalance: string | null;
  readonly balanceDate: EpochSeconds | null;
  readonly transactions: ReadonlyArray<Transaction> | null;
  /**
   * True when `transactions` is the account's whole list for the window: every record was
   * readable, no other record in the response carries or might carry this account's id, and the
   * response carries no error of any kind. Only then may stored pending rows missing from the
   * list be pruned.
   */
  readonly transactionsComplete: boolean;
}

/** One parsed /accounts response. */
export interface AccountSet {
  readonly connections: ReadonlyArray<Connection>;
  readonly accounts: ReadonlyArray<Account>;
  /**
   * True when the Bridge reported any error, general or for an account or connection, or a
   * record could not be read. The window is then incomplete and must be fetched again.
   */
  readonly hasDataErrors: boolean;
  /** Sanitized Bridge messages plus notes about records that could not be read. */
  readonly messages: ReadonlyArray<string>;
}

/** A response that is not a SimpleFIN account set at all. */
export class InvalidBridgeResponse extends Schema.TaggedError<InvalidBridgeResponse>()(
  "InvalidBridgeResponse",
  { message: Schema.String },
) {}

const decodeEnvelope = Schema.decodeUnknownResult(Schema.fromJsonString(AccountSetResponse));
const decodeConnection = Schema.decodeUnknownResult(ConnectionResponse);
const decodeAccount = Schema.decodeUnknownResult(AccountResponse);
const decodeTransaction = Schema.decodeUnknownResult(TransactionResponse);
const decodeError = Schema.decodeUnknownResult(ErrorResponse);
const decodeMessage = Schema.decodeUnknownResult(Schema.String);

/**
 * Just the id of an account record, read without decoding the rest of it, so a malformed record
 * still counts against the account it belongs to.
 */
const decodeAccountId = Schema.decodeUnknownResult(Schema.Struct({ id: Identifier }));

/** 2100-01-01. Timestamps outside 1970–2100 are corrupt and would break date rendering. */
const MAX_TIMESTAMP = 4_102_444_800;

/** A timestamp within 1970–2100, truncated to whole seconds, or undefined. */
function timestamp(value: number | null | undefined): number | undefined {
  return value === null || value === undefined || value < 0 || value > MAX_TIMESTAMP
    ? undefined
    : Math.trunc(value);
}

/**
 * An upstream id as shown to agents, with the same cleaning as bank text. Never use it as a key:
 * distinct ids can share a display form.
 */
export function displayId(id: string): string {
  const clean = sanitizeText(id, 256);

  return clean === "" ? "(unprintable id)" : clean;
}

/**
 * The handle agents use to pick an account: "acct_" and the first 16 hex digits of the SHA-256
 * of its upstream id. Display ids can be too long for tool input or look alike; a ref is short
 * and, for distinct ids, distinct. The accounts table enforces that, so a collision fails the
 * sync instead of merging two accounts.
 */
export async function accountRef(id: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(id)),
  );

  return `acct_${[...digest.subarray(0, 8)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** A balance as a canonical decimal string, or null when absent or not a decimal amount. */
function decimal(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;

  const text = String(value).trim();

  return Result.isSuccess(parseAmountCents(text)) ? text : null;
}

function bounded(text: string | null | undefined, maxLength: number): string | null {
  const visible = sanitizeOptionalText(text);

  return visible === null ? null : visible.slice(0, maxLength);
}

/** Parse an /accounts JSON body into an account set, skipping and reporting unreadable records. */
export function parseAccountSet(json: string): Result.Result<AccountSet, InvalidBridgeResponse> {
  const envelope = decodeEnvelope(json);

  if (Result.isFailure(envelope)) {
    return Result.fail(
      new InvalidBridgeResponse({ message: "SimpleFIN returned an unexpected response." }),
    );
  }

  const messages = new Set<string>();
  // Any error at all, whoever it names, stops pruning for every account in this response.
  let hasErrors = false;
  let skippedAccounts = 0;
  let skippedTransactions = 0;
  let unreadableErrors = 0;
  let withoutTransactions = 0;

  for (const raw of envelope.success.errlist ?? []) {
    const decoded = decodeError(raw);

    hasErrors = true;

    if (Result.isFailure(decoded)) {
      unreadableErrors += 1;
      continue;
    }

    const error = decoded.success;
    const message = sanitizeText(error.msg || error.code || "Unspecified Bridge error");

    if (message !== "") messages.add(message);
  }

  for (const raw of envelope.success.errors ?? []) {
    const decoded = decodeMessage(raw);

    hasErrors = true;

    if (Result.isFailure(decoded)) unreadableErrors += 1;
    else if (sanitizeText(decoded.success) !== "") messages.add(sanitizeText(decoded.success));
  }

  const connections: Array<Connection> = [];

  for (const raw of envelope.success.connections ?? []) {
    const decoded = decodeConnection(raw);

    if (Result.isFailure(decoded)) continue;

    connections.push({
      connId: decoded.success.conn_id,
      name: bounded(decoded.success.name, 200),
      orgId: bounded(decoded.success.org_id, 200),
      orgName: bounded(decoded.success.org_name, 200),
      orgUrl: bounded(decoded.success.org_url, 300),
    });
  }

  // How many records carry each id, malformed ones included. A record without a readable id
  // could belong to any account, so then no account's list can be trusted to be whole.
  const recordsPerId = new Map<string, number>();
  let unidentified = 0;

  for (const raw of envelope.success.accounts) {
    const record = decodeAccountId(raw);

    if (Result.isFailure(record)) unidentified += 1;
    else recordsPerId.set(record.success.id, (recordsPerId.get(record.success.id) ?? 0) + 1);
  }

  const duplicated = [...recordsPerId.values()].filter((count) => count > 1).length;

  const accounts: Array<Account> = [];

  for (const raw of envelope.success.accounts) {
    const decoded = decodeAccount(raw);

    if (Result.isFailure(decoded)) {
      skippedAccounts += 1;
      continue;
    }

    const account = decoded.success;
    const rawConnId = account.conn_id;

    // A connection id too long to be a key is unusable, like a missing one.
    const connId =
      rawConnId === null || rawConnId === undefined || rawConnId === "" || rawConnId.length > 512
        ? null
        : rawConnId;

    let transactions: Array<Transaction> | null = null;
    let unreadable = 0;

    if (account.transactions !== undefined && account.transactions !== null) {
      transactions = [];

      for (const rawTransaction of account.transactions) {
        const transaction = decodeTransaction(rawTransaction);

        const cents = Result.isSuccess(transaction)
          ? parseAmountCents(String(transaction.success.amount))
          : undefined;

        const posted = Result.isSuccess(transaction)
          ? timestamp(transaction.success.posted ?? 0)
          : undefined;

        if (
          Result.isFailure(transaction) ||
          cents === undefined ||
          Result.isFailure(cents) ||
          posted === undefined
        ) {
          unreadable += 1;
          continue;
        }

        const value = transaction.success;

        transactions.push({
          id: value.id,
          posted,
          transactedAt: timestamp(value.transacted_at) ?? null,
          amount: String(value.amount),
          amountCents: cents.success,
          description: bounded(value.description, 500) ?? "",
          payee: bounded(value.payee, 300),
          memo: bounded(value.memo, 500),
          pending: value.pending === true,
        });
      }
    }

    skippedTransactions += unreadable;

    // Every request asks for transactions, so an account without a list is missing data.
    if (transactions === null) withoutTransactions += 1;

    accounts.push({
      id: account.id,
      connId,
      name: bounded(account.name, 200) ?? displayId(account.id),
      currency: bounded(account.currency, 40),
      balance: decimal(account.balance),
      availableBalance: decimal(account["available-balance"]),
      balanceDate: timestamp(account["balance-date"]) ?? null,
      transactions,
      // When in doubt, don't prune: a list that might be partial proves nothing is gone.
      transactionsComplete:
        transactions !== null &&
        unreadable === 0 &&
        unidentified === 0 &&
        recordsPerId.get(account.id) === 1 &&
        !hasErrors,
    });
  }

  if (duplicated > 0) messages.add(`${duplicated} account id(s) appeared in more than one record.`);

  if (unreadableErrors > 0)
    messages.add(`${unreadableErrors} Bridge error record(s) could not be read.`);

  if (withoutTransactions > 0)
    messages.add(`${withoutTransactions} account(s) came back without a transaction list.`);

  if (skippedAccounts > 0)
    messages.add(`${skippedAccounts} account record(s) could not be read and were skipped.`);

  if (skippedTransactions > 0) {
    messages.add(
      `${skippedTransactions} transaction record(s) could not be read and were skipped.`,
    );
  }

  return Result.succeed({
    connections,
    accounts,
    // Skipped records leave a gap, so the window must be fetched again like any reported error.
    hasDataErrors:
      hasErrors || skippedAccounts > 0 || skippedTransactions > 0 || withoutTransactions > 0,
    messages: [...messages],
  });
}

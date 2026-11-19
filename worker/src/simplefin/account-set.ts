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
  org: Schema.optional(Schema.NullOr(Schema.Struct({ id: OptionalText }))),
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

const ErrorResponse = Schema.Struct({
  code: OptionalText,
  msg: OptionalText,
  account_id: OptionalText,
  conn_id: OptionalText,
});

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
   * readable, the account appeared once, and no error applies to the account, its connection or the
   * response. Only then may stored pending rows missing from the list be pruned.
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
  const accountsWithErrors = new Set<string>();
  const connectionsWithErrors = new Set<string>();
  let hasGeneralErrors = false;
  let skippedAccounts = 0;
  let skippedTransactions = 0;
  let unreadableErrors = 0;
  let withoutTransactions = 0;

  for (const raw of envelope.success.errlist ?? []) {
    const decoded = decodeError(raw);

    // An error the bridge can't read could be about any account, so it spoils the whole window.
    if (Result.isFailure(decoded)) {
      unreadableErrors += 1;
      hasGeneralErrors = true;
      continue;
    }

    const error = decoded.success;
    const code = error.code ?? "";

    if (code.startsWith("act.") && error.account_id) accountsWithErrors.add(error.account_id);
    else if (code.startsWith("con.") && error.conn_id) connectionsWithErrors.add(error.conn_id);
    else hasGeneralErrors = true;

    const message = sanitizeText(error.msg || error.code || "Unspecified Bridge error");

    if (message !== "") messages.add(message);
  }

  // Version 1 error strings carry no account, so any of them makes the whole response suspect.
  for (const raw of envelope.success.errors ?? []) {
    const decoded = decodeMessage(raw);

    hasGeneralErrors = true;

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

  const accounts: Array<Account> = [];

  for (const raw of envelope.success.accounts) {
    const decoded = decodeAccount(raw);

    if (Result.isFailure(decoded)) {
      skippedAccounts += 1;
      continue;
    }

    const account = decoded.success;
    const rawConnId = account.conn_id ?? account.org?.id ?? null;

    // A connection id too long to be a key is unusable, like a missing one.
    const connId =
      rawConnId === null || rawConnId === "" || rawConnId.length > 512 ? null : rawConnId;

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
      transactionsComplete:
        transactions !== null &&
        unreadable === 0 &&
        !hasGeneralErrors &&
        !accountsWithErrors.has(account.id) &&
        (connId === null || !connectionsWithErrors.has(connId)),
    });
  }

  // An id listed twice has two lists. Both are stored, but neither alone proves a pending row is
  // gone, so the account is not pruned.
  const seen = new Map<string, number>();

  for (const account of accounts) seen.set(account.id, (seen.get(account.id) ?? 0) + 1);

  const duplicated = accounts.filter((account) => (seen.get(account.id) ?? 0) > 1).length;

  const checked = accounts.map((account) =>
    (seen.get(account.id) ?? 0) > 1 ? { ...account, transactionsComplete: false } : account,
  );

  if (duplicated > 0) messages.add(`${duplicated} account record(s) shared an id with another.`);

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
    accounts: checked,
    // Skipped records leave a gap, so the window must be fetched again like any reported error.
    hasDataErrors:
      hasGeneralErrors ||
      accountsWithErrors.size > 0 ||
      connectionsWithErrors.size > 0 ||
      skippedAccounts > 0 ||
      skippedTransactions > 0 ||
      withoutTransactions > 0,
    messages: [...messages],
  });
}

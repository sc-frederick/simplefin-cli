import { Result, Schema } from "effect";
import type { EpochSeconds } from "../domain/dates.ts";
import { parseAmountCents } from "../domain/money.ts";
import { sanitizeOptionalText, sanitizeText } from "../domain/text.ts";

const Identifier = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512));
const OptionalText = Schema.optional(Schema.NullOr(Schema.String));
const OptionalTimestamp = Schema.optional(Schema.NullOr(Schema.Finite));
const DecimalValue = Schema.Union([Schema.String, Schema.Finite]);

/** Raw /accounts envelope; records inside are decoded one at a time so one bad record can't block a sync. */
const AccountSetResponse = Schema.Struct({
  connections: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
  accounts: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
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
  readonly connId: string;
  readonly name: string | null;
  readonly orgId: string | null;
  readonly orgName: string | null;
  readonly orgUrl: string | null;
}

/** One transaction as stored. */
export interface Transaction {
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
  readonly id: string;
  readonly connId: string | null;
  readonly name: string;
  readonly currency: string | null;
  readonly balance: string | null;
  readonly availableBalance: string | null;
  readonly balanceDate: EpochSeconds | null;
  readonly transactions: ReadonlyArray<Transaction> | null;
}

/** One parsed /accounts response. */
export interface AccountSet {
  readonly connections: ReadonlyArray<Connection>;
  readonly accounts: ReadonlyArray<Account>;
  /** Accounts the Bridge reported an act.* error for; their pending rows are not pruned. */
  readonly accountsWithErrors: ReadonlySet<string>;
  /** Connections the Bridge reported a con.* error for. */
  readonly connectionsWithErrors: ReadonlySet<string>;
  /** True when any account or connection reported an error, so the window must be re-fetched. */
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
  let hasDataErrors = false;
  let skippedAccounts = 0;
  let skippedTransactions = 0;

  for (const raw of envelope.success.errlist ?? []) {
    const decoded = decodeError(raw);

    if (Result.isFailure(decoded)) continue;

    const error = decoded.success;
    const code = error.code ?? "";

    if (code.startsWith("act.") || code.startsWith("con.")) hasDataErrors = true;

    if (code.startsWith("act.") && error.account_id) accountsWithErrors.add(error.account_id);
    else if (code.startsWith("con.") && error.conn_id) connectionsWithErrors.add(error.conn_id);

    const message = sanitizeText(error.msg || error.code || "Unspecified Bridge error");

    if (message !== "") messages.add(message);
  }

  for (const raw of envelope.success.errors ?? []) {
    const decoded = decodeMessage(raw);

    if (Result.isSuccess(decoded) && sanitizeText(decoded.success) !== "") {
      messages.add(sanitizeText(decoded.success));
    }
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

  for (const raw of envelope.success.accounts ?? []) {
    const decoded = decodeAccount(raw);

    if (Result.isFailure(decoded)) {
      skippedAccounts += 1;
      continue;
    }

    const account = decoded.success;
    let transactions: Array<Transaction> | null = null;

    if (account.transactions !== undefined && account.transactions !== null) {
      transactions = [];

      for (const rawTransaction of account.transactions) {
        const transaction = decodeTransaction(rawTransaction);

        const cents = Result.isSuccess(transaction)
          ? parseAmountCents(String(transaction.success.amount))
          : undefined;

        if (Result.isFailure(transaction) || cents === undefined || Result.isFailure(cents)) {
          skippedTransactions += 1;
          continue;
        }

        const value = transaction.success;

        transactions.push({
          id: value.id,
          posted: Math.trunc(value.posted ?? 0),
          transactedAt:
            value.transacted_at === undefined || value.transacted_at === null
              ? null
              : Math.trunc(value.transacted_at),
          amount: String(value.amount),
          amountCents: cents.success,
          description: bounded(value.description, 500) ?? "",
          payee: bounded(value.payee, 300),
          memo: bounded(value.memo, 500),
          pending: value.pending === true,
        });
      }
    }

    accounts.push({
      id: account.id,
      connId: account.conn_id ?? account.org?.id ?? null,
      name: bounded(account.name, 200) ?? account.id,
      currency: bounded(account.currency, 40),
      balance:
        account.balance === undefined || account.balance === null ? null : String(account.balance),
      availableBalance:
        account["available-balance"] === undefined || account["available-balance"] === null
          ? null
          : String(account["available-balance"]),
      balanceDate:
        account["balance-date"] === undefined || account["balance-date"] === null
          ? null
          : Math.trunc(account["balance-date"]),
      transactions,
    });
  }

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
    accountsWithErrors,
    connectionsWithErrors,
    // Skipped records leave a gap, so the window must be fetched again like any data error.
    hasDataErrors: hasDataErrors || skippedAccounts > 0 || skippedTransactions > 0,
    messages: [...messages],
  });
}

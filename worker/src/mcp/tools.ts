import { Effect, Schema } from "effect";
import type { JsonSchema } from "effect";
import type { QueryError } from "../app/ledger-queries.ts";
import { LedgerQueries } from "../app/ledger-queries.ts";
import { SyncService } from "../app/sync-service.ts";
import type { StorageError } from "../store/ledger-store.ts";

/** MCP tool annotations; hints only, but Executor uses readOnlyHint to decide approvals. */
export interface ToolAnnotations {
  readonly title: string;
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

/** A tools/call request after envelope decoding; `arguments` is still unparsed JSON. */
export interface ToolCallRequest {
  readonly name: string;
  readonly arguments?: unknown;
}

/** An MCP CallToolResult. Failures are results with isError, so the model can correct itself. */
export interface ToolResult {
  readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>;
  readonly structuredContent?: object;
  readonly isError: boolean;
}

/** A JSON Schema object as advertised in tools/list. */
export type JsonSchemaObject = JsonSchema.JsonSchema;

/** A registered tool with its contract erased to what the MCP adapter needs. */
export interface RegisteredTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchemaObject;
  readonly annotations: ToolAnnotations;
  readonly call: (
    request: ToolCallRequest,
  ) => Effect.Effect<ToolResult, never, LedgerQueries | SyncService>;
}

const MAX_ERROR_TEXT = 1000;

const failureResult = (message: string): ToolResult => ({
  content: [{ type: "text", text: message.slice(0, MAX_ERROR_TEXT) }],
  isError: true,
});

const successResult = <A extends object>(value: A): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  structuredContent: value,
  isError: false,
});

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

function tool<P extends Schema.Top & { readonly DecodingServices: never }>(spec: {
  readonly name: string;
  readonly description: string;
  readonly parameters: P;
  readonly annotations: ToolAnnotations;
  readonly run: (
    params: P["Type"],
  ) => Effect.Effect<object, QueryError | StorageError, LedgerQueries | SyncService>;
}): RegisteredTool {
  const decode = Schema.decodeUnknownEffect(spec.parameters, {
    onExcessProperty: "error",
    errors: "all",
  });

  const document = Schema.toJsonSchemaDocument(spec.parameters);

  const definitions =
    Object.keys(document.definitions).length > 0 ? { $defs: document.definitions } : {};

  return {
    name: spec.name,
    description: spec.description,
    inputSchema: {
      ...document.schema,
      ...definitions,
      type: "object",
      additionalProperties: false,
    },
    annotations: spec.annotations,
    call: (request) =>
      decode(request.arguments ?? {}).pipe(
        Effect.mapError((error) => `Invalid arguments for ${spec.name}: ${error.message}`),
        Effect.flatMap((params) =>
          spec.run(params).pipe(Effect.mapError((error) => error.message)),
        ),
        // A bug must not take down the request or leak a stack: report a generic tool error.
        Effect.catchDefect((defect) =>
          Effect.logError("Tool failed unexpectedly").pipe(
            Effect.annotateLogs({
              tool: spec.name,
              defect: defect instanceof Error ? defect.name : "unknown",
            }),
            Effect.andThen(Effect.fail("The tool failed unexpectedly.")),
          ),
        ),
        Effect.match({ onFailure: failureResult, onSuccess: successResult }),
        Effect.withSpan(`tool.${spec.name}`),
      ),
  };
}

const AccountRef = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)).annotate({
  description: "Account id or part of its name",
});

const DateFilter = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(40)).annotate({
  description: 'YYYY-MM-DD, an ISO timestamp, or a relative value like "30d"',
});

const Amount = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(24)).annotate({
  description: 'Signed decimal amount, e.g. "-100" for charges of $100 or more',
});

const optionalNullable = <S extends Schema.Top>(schema: S) =>
  Schema.optionalKey(Schema.NullOr(schema));

// An empty Struct accepts any object even with onExcessProperty "error"; a record of Never
// rejects every key, so tools without parameters refuse smuggled arguments.
const NoParameters = Schema.Record(Schema.String, Schema.Never);

const ListTransactionsParameters = Schema.Struct({
  account: optionalNullable(AccountRef),
  since: optionalNullable(DateFilter),
  until: optionalNullable(DateFilter),
  search: optionalNullable(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)).annotate({
      description: "Matches description, payee or memo",
    }),
  ),
  min_amount: optionalNullable(Amount),
  max_amount: optionalNullable(Amount),
  pending: optionalNullable(Schema.Boolean),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 }))),
});

const BalanceHistoryParameters = Schema.Struct({
  account: AccountRef,
  since: optionalNullable(DateFilter),
});

const CashFlowParameters = Schema.Struct({
  since: optionalNullable(DateFilter),
  until: optionalNullable(DateFilter),
  account: optionalNullable(AccountRef),
});

const RecurringParameters = Schema.Struct({
  since: optionalNullable(DateFilter),
  include_inactive: Schema.optionalKey(Schema.Boolean),
  include_income: Schema.optionalKey(Schema.Boolean),
  min_occurrences: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: 50 })),
  ),
});

const TopMerchantsParameters = Schema.Struct({
  since: optionalNullable(DateFilter),
  until: optionalNullable(DateFilter),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))),
  include_transfers: Schema.optionalKey(Schema.Boolean),
});

/** Apply the upstream default ("30d") when a period start is omitted; an explicit null means no bound. */
const sinceOrDefault = (since: string | null | undefined) => (since === undefined ? "30d" : since);

/** Every tool the bridge serves, in tools/list order. Names and defaults match the upstream CLI. */
export const TOOLS: ReadonlyArray<RegisteredTool> = [
  tool({
    name: "list_accounts",
    description: "List every synced account with institution, current balance and balance date.",
    parameters: NoParameters,
    annotations: { title: "List accounts", ...READ_ONLY },
    run: () => LedgerQueries.use((queries) => queries.accounts),
  }),
  tool({
    name: "list_transactions",
    description:
      'List transactions, newest first. account: account id or part of its name. since/until: YYYY-MM-DD or e.g. "90d" (since defaults to 30d; null means no lower bound). search: matches description, payee or memo. min_amount/max_amount: signed amounts, e.g. max_amount="-100" for charges of $100 or more. pending: only pending (true) or posted (false). limit: 1-1000, default 100.',
    parameters: ListTransactionsParameters,
    annotations: { title: "List transactions", ...READ_ONLY },
    run: (params) =>
      LedgerQueries.use((queries) =>
        queries.transactions({
          account: params.account ?? null,
          since: sinceOrDefault(params.since),
          until: params.until ?? null,
          search: params.search ?? null,
          minAmount: params.min_amount ?? null,
          maxAmount: params.max_amount ?? null,
          pending: params.pending ?? null,
          limit: params.limit ?? 100,
        }),
      ),
  }),
  tool({
    name: "get_balance_history",
    description: "Balance snapshots recorded at each sync for an account (id or part of its name).",
    parameters: BalanceHistoryParameters,
    annotations: { title: "Balance history", ...READ_ONLY },
    run: (params) =>
      LedgerQueries.use((queries) =>
        queries.balanceHistory({ account: params.account, since: params.since ?? null }),
      ),
  }),
  tool({
    name: "summarize_cash_flow",
    description:
      "Total money in and out per account over a period, from posted transactions. since defaults to 30d.",
    parameters: CashFlowParameters,
    annotations: { title: "Summarize cash flow", ...READ_ONLY },
    run: (params) =>
      LedgerQueries.use((queries) =>
        queries.cashFlow({
          since: sinceOrDefault(params.since),
          until: params.until ?? null,
          account: params.account ?? null,
        }),
      ),
  }),
  tool({
    name: "find_recurring_charges",
    description:
      "Detect subscriptions, bills and other charges that repeat on a regular cadence. Returns each series with merchant, kind (subscription, bill, installment plan fee), cadence, typical amount, monthly and yearly cost, last and next expected charge, confidence and status, plus the total monthly cost of active outflows. Card payments and transfers are excluded. include_inactive adds series that seem to have stopped; include_income adds regular deposits. Limited by synced history: yearly charges need over a year of data.",
    parameters: RecurringParameters,
    annotations: { title: "Find recurring charges", ...READ_ONLY },
    run: (params) =>
      LedgerQueries.use((queries) =>
        queries.recurring({
          since: params.since ?? null,
          minOccurrences: params.min_occurrences ?? 2,
          includeInactive: params.include_inactive ?? false,
          includeIncome: params.include_income ?? false,
        }),
      ),
  }),
  tool({
    name: "top_merchants",
    description:
      "Spending grouped by merchant (names normalized across card networks and PayPal/Apple Pay prefixes), largest first. Excludes pending charges, and transfers/card payments by default. since defaults to 30d; limit 1-200, default 20.",
    parameters: TopMerchantsParameters,
    annotations: { title: "Top merchants", ...READ_ONLY },
    run: (params) =>
      LedgerQueries.use((queries) =>
        queries.topMerchants({
          since: sinceOrDefault(params.since),
          until: params.until ?? null,
          limit: params.limit ?? 20,
          includeTransfers: params.include_transfers ?? false,
        }),
      ),
  }),
  tool({
    name: "sync_status",
    description:
      "When data was last synced, request quota used, and any errors the Bridge reported.",
    parameters: NoParameters,
    annotations: { title: "Sync status", ...READ_ONLY },
    run: () => SyncService.use((sync) => sync.status),
  }),
  tool({
    name: "sync_now",
    description:
      "Fetch new data from SimpleFIN Bridge. Uses the Bridge's small daily request quota, so call it only when sync_status shows stale data. Refuses if the last sync was under an hour ago or another sync started in the last 10 minutes.",
    parameters: NoParameters,
    annotations: {
      title: "Sync now",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    run: () => SyncService.use((sync) => sync.manualSync),
  }),
];

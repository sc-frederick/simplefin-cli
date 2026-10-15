import { Effect, Schema } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { handleMcpMessage } from "../src/mcp/server.ts";
import { makeFakeBridge, TEST_ACCESS_URL } from "./support/fake-bridge.ts";
import type { JsonObject } from "./support/json.ts";
import { runLedger } from "./support/ledger-harness.ts";

const RpcAnswer = Schema.Struct({
  id: Schema.NullOr(Schema.Union([Schema.String, Schema.Number])),
  result: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.Struct({ code: Schema.Int, message: Schema.String })),
});

const decodeAnswer = Schema.decodeUnknownSync(Schema.fromJsonString(RpcAnswer));

/** Send JSON-RPC messages in order through one fresh ledger and return each HTTP answer. */
async function exchange(
  messages: ReadonlyArray<{ readonly body: string; readonly version?: string }>,
) {
  const bridge = makeFakeBridge([]);

  return runLedger(
    { bridge, accessUrl: () => TEST_ACCESS_URL },
    Effect.forEach(messages, (message) =>
      handleMcpMessage(message.body, message.version ?? null, 12),
    ),
  );
}

const request = (id: number, method: string, params: JsonObject = {}) =>
  JSON.stringify({ jsonrpc: "2.0", id, method, params });

describe("MCP over stateless Streamable HTTP", () => {
  test("negotiates a supported protocol version without issuing a session", async () => {
    const [current, older, unknown] = await exchange([
      {
        body: request(1, "initialize", {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "t", version: "1" },
        }),
      },
      { body: request(2, "initialize", { protocolVersion: "2025-06-18", capabilities: {} }) },
      { body: request(3, "initialize", { protocolVersion: "1999-01-01", capabilities: {} }) },
    ]);

    expect(decodeAnswer(current?.body ?? "").result).toMatchObject({
      protocolVersion: "2025-11-25",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "simplefin" },
      instructions: expect.stringContaining("untrusted data"),
    });

    expect(decodeAnswer(older?.body ?? "").result).toMatchObject({ protocolVersion: "2025-06-18" });
    expect(decodeAnswer(unknown?.body ?? "").result).toMatchObject({
      protocolVersion: "2025-11-25",
    });
  });

  test("accepts notifications and rejects batches, bad JSON and unsupported versions", async () => {
    const [notification, batch, garbage, version, missingMethod] = await exchange([
      { body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) },
      { body: JSON.stringify([JSON.parse(request(1, "ping"))]) },
      { body: "{not json" },
      { body: request(2, "ping"), version: "2024-11-05" },
      { body: request(3, "no/such/method") },
    ]);

    expect(notification).toEqual({ status: 202, body: null });
    expect(batch?.status).toBe(400);
    expect(garbage).toMatchObject({ status: 400 });
    expect(decodeAnswer(garbage?.body ?? "").error?.code).toBe(-32700);
    expect(version?.status).toBe(400);
    expect(decodeAnswer(missingMethod?.body ?? "").error?.code).toBe(-32601);
  });

  test("lists eight strict tools and marks only sync_now as having side effects", async () => {
    const [answer] = await exchange([{ body: request(1, "tools/list"), version: "2025-11-25" }]);

    const ToolList = Schema.Struct({
      tools: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          inputSchema: Schema.Struct({
            type: Schema.Literal("object"),
            additionalProperties: Schema.Literal(false),
          }),
          annotations: Schema.Struct({ readOnlyHint: Schema.Boolean }),
        }),
      ),
    });

    const { tools } = Schema.decodeUnknownSync(ToolList)(decodeAnswer(answer?.body ?? "").result);

    expect(tools.map((tool) => tool.name)).toEqual([
      "list_accounts",
      "list_transactions",
      "get_balance_history",
      "summarize_cash_flow",
      "find_recurring_charges",
      "top_merchants",
      "sync_status",
      "sync_now",
    ]);

    expect(tools.filter((tool) => !tool.annotations.readOnlyHint).map((tool) => tool.name)).toEqual(
      ["sync_now"],
    );
  });

  test("returns tool results and reports bad arguments as tool errors", async () => {
    const [accounts, extraKey, badLimit, unknownTool, badDate] = await exchange([
      { body: request(1, "tools/call", { name: "list_accounts", arguments: {} }) },
      {
        body: request(2, "tools/call", {
          name: "list_accounts",
          arguments: { sql: "DROP TABLE accounts" },
        }),
      },
      {
        body: request(3, "tools/call", { name: "list_transactions", arguments: { limit: 100000 } }),
      },
      { body: request(4, "tools/call", { name: "read_secrets", arguments: {} }) },
      {
        body: request(5, "tools/call", {
          name: "list_transactions",
          arguments: { since: "last tuesday" },
        }),
      },
    ]);

    expect(decodeAnswer(accounts?.body ?? "").result).toEqual({
      content: [{ type: "text", text: '{"accounts":[]}' }],
      structuredContent: { accounts: [] },
      isError: false,
    });

    expect(decodeAnswer(extraKey?.body ?? "").result).toMatchObject({ isError: true });
    expect(decodeAnswer(badLimit?.body ?? "").result).toMatchObject({ isError: true });
    expect(decodeAnswer(unknownTool?.body ?? "").error?.code).toBe(-32602);
    expect(decodeAnswer(badDate?.body ?? "").result).toMatchObject({
      isError: true,
      content: [{ type: "text", text: expect.stringContaining("YYYY-MM-DD") }],
    });
  });
});

import { Effect, Result } from "effect";
import type { McpHttpResponse } from "../mcp/server.ts";
import type { AccessPolicy, KeyResolver } from "./access-token.ts";
import { verifyAccessToken } from "./access-token.ts";

/** Path of the MCP endpoint; everything else is 404 after authentication. */
export const MCP_PATH = "/mcp";

/** Largest accepted MCP message. Tool calls are a few hundred bytes. */
export const MAX_BODY_BYTES = 64 * 1024;

/** What the edge needs to authenticate a request and reach the ledger. */
export interface EdgeDependencies {
  readonly policy: AccessPolicy;
  readonly resolveKey: KeyResolver;
  readonly nowSeconds: () => number;
  readonly forward: (body: string, protocolVersion: string | null) => Promise<McpHttpResponse>;
  /** Records a safe, structured note about a refused request. Never receives tokens or bodies. */
  readonly refused: (reason: string) => void;
}

const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
} as const;

function plain(status: number, text: string, extra: Record<string, string> = {}): Response {
  return new Response(text, {
    status,
    headers: { ...SECURITY_HEADERS, "content-type": "text/plain; charset=utf-8", ...extra },
  });
}

/** Read a body as UTF-8 text, refusing anything over the limit without buffering it. */
async function readBoundedBody(request: Request): Promise<string | undefined> {
  if (request.body === null) return "";

  const reader = request.body.getReader();
  const chunks: Array<Uint8Array> = [];
  let total = 0;

  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
    total += chunk.value.byteLength;

    if (total > MAX_BODY_BYTES) {
      await reader.cancel();

      return undefined;
    }

    chunks.push(chunk.value);
  }

  const body = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body);
  } catch {
    return undefined;
  }
}

/**
 * Authenticate and route one request. Every request must carry a valid Access application
 * token for the configured service token before anything else is evaluated, so unauthenticated
 * callers learn nothing about routes or methods.
 */
export async function handleEdgeRequest(
  request: Request,
  dependencies: EdgeDependencies,
): Promise<Response> {
  const token = request.headers.get("cf-access-jwt-assertion");

  if (token === null) {
    dependencies.refused("missing access token");

    return plain(403, "Forbidden");
  }

  const verified = await Effect.runPromise(
    Effect.result(
      verifyAccessToken(
        token,
        dependencies.policy,
        dependencies.resolveKey,
        dependencies.nowSeconds(),
      ),
    ),
  ).catch(() => undefined);

  if (verified === undefined || Result.isFailure(verified)) {
    dependencies.refused(verified === undefined ? "access check failed" : verified.failure.reason);

    return plain(403, "Forbidden");
  }

  // MCP clients here are servers. A browser Origin means a cross-site or rebinding attempt.
  if (request.headers.has("origin")) {
    dependencies.refused("browser origin");

    return plain(403, "Forbidden");
  }

  if (new URL(request.url).pathname !== MCP_PATH) return plain(404, "Not found");

  // No server-initiated SSE stream and no sessions to delete.
  if (request.method !== "POST") return plain(405, "Method not allowed", { allow: "POST" });

  const contentType = request.headers.get("content-type") ?? "";

  if (!/^application\/json(?:\s*;|$)/iu.test(contentType))
    return plain(415, "Expected application/json");

  if (Number(request.headers.get("content-length") ?? "0") > MAX_BODY_BYTES)
    return plain(413, "Too large");

  const body = await readBoundedBody(request);

  if (body === undefined) return plain(413, "Too large or not UTF-8");

  const answer = await dependencies
    .forward(body, request.headers.get("mcp-protocol-version"))
    .catch(() => undefined);

  if (answer === undefined) {
    dependencies.refused("ledger unavailable");

    return plain(500, "Internal error");
  }

  if (answer.body === null)
    return new Response(null, { status: answer.status, headers: SECURITY_HEADERS });

  return new Response(answer.body, {
    status: answer.status,
    headers: { ...SECURITY_HEADERS, "content-type": "application/json" },
  });
}

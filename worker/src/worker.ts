import { Result } from "effect";
import { parseAccessPolicy } from "./config.ts";
import type { KeyResolver } from "./edge/access-token.ts";
import { cachedKeyResolver } from "./edge/access-token.ts";
import { handleEdgeRequest } from "./edge/handler.ts";
import type { Env } from "./env.ts";
import { VAULT_NAME } from "./vault.ts";

export { SimplefinVault } from "./vault.ts";

/** Team signing keys cached per isolate, keyed by team domain. */
const keyResolvers = new Map<string, KeyResolver>();

async function fetchText(url: string): Promise<string> {
  // Workers support only "follow" and "manual"; a redirect here is refused like any non-200.
  const response = await fetch(url, {
    redirect: "manual",
    headers: { accept: "application/json" },
  });

  if (response.status !== 200)
    throw new Error(`Signing keys request failed with HTTP ${response.status}`);

  return response.text();
}

function resolverFor(teamDomain: string): KeyResolver {
  const existing = keyResolvers.get(teamDomain);

  if (existing !== undefined) return existing;

  const resolver = cachedKeyResolver(teamDomain, fetchText);

  keyResolvers.set(teamDomain, resolver);

  return resolver;
}

export default {
  async fetch(request, env) {
    const policy = parseAccessPolicy(env);

    if (Result.isFailure(policy)) {
      console.error(JSON.stringify({ event: "misconfigured", setting: policy.failure.setting }));

      return new Response("Service unavailable", {
        status: 503,
        headers: { "cache-control": "no-store" },
      });
    }

    return handleEdgeRequest(request, {
      policy: policy.success,
      resolveKey: resolverFor(policy.success.teamDomain),
      nowSeconds: () => Math.floor(Date.now() / 1000),
      forward: (body, protocolVersion) =>
        env.VAULT.getByName(VAULT_NAME).handleMcp(body, protocolVersion),
      refused: (reason) => console.warn(JSON.stringify({ event: "refused", reason })),
    });
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(env.VAULT.getByName(VAULT_NAME).watchdog());
  },
} satisfies ExportedHandler<Env>;

import { defineProvider, header, object, secrets, string } from "apps";
import { mcpHealth } from "apps/mcp";
import { host } from "./host.js";

/** The bridge's MCP endpoint behind Cloudflare Access. */
export const url = `https://${host}/mcp`;

/**
 * A Cloudflare Access service token. Both fields are secrets: app code holds only handles, and
 * Executor substitutes the values only as these two exact headers, over HTTPS, to the bridge host.
 */
export const provider = defineProvider({
  name: "SimpleFIN bridge",
  hosts: [host],
  auth: {
    serviceToken: secrets({
      label: "Cloudflare Access service token",
      fields: object({
        clientId: string({ minLength: 1 }),
        clientSecret: string({ minLength: 1 }),
      }),
      request: ({ clientId, clientSecret }) => [
        header("cf-access-client-id", clientId),
        header("cf-access-client-secret", clientSecret),
      ],
    }),
  },
  // Connects with the token, lists tools, and confirms the bridge refuses the same request without it.
  health: (check) => mcpHealth(check, { url, headers: check.account.headers() }),
});

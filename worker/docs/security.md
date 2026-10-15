# Security model

## What needs protecting

| Asset                                                        | Where it lives                                          | Who can use it                                  |
| ------------------------------------------------------------ | ------------------------------------------------------- | ----------------------------------------------- |
| SimpleFIN access URL: read access to every connected account | Cloudflare Secrets Store, secret `simplefin-access-url` | The Durable Object, when syncing                |
| Synced ledger: balances and transaction history              | The Durable Object's SQLite database                    | MCP tools, after authentication                 |
| Access service token: the key to the MCP endpoint            | Executor (as handles) and Cloudflare (hashed)           | Executor, on behalf of the member who linked it |
| SimpleFIN setup token, one-time                              | The owner's terminal, for seconds                       | `scripts/claim.ts`                              |

SimpleFIN is read-only: none of these can move money. A leak still exposes balances,
transactions and account names.

## Layers

**1. Edge: Cloudflare Access.** `alchemy.run.ts` declares a self-hosted Access application on
the custom domain with one Service Auth policy that includes only Executor's service token.
Requests without that token never reach the Worker. workers.dev and preview URLs are disabled,
so the custom domain is the only way in. Turn on strict service-token authentication for the
Access organization, so failed token requests get 401/403 instead of a login redirect.

**2. Worker: verify again, fail closed** (`src/edge/`). Every request must carry a
`Cf-Access-Jwt-Assertion` that verifies against the team's published keys (RS256 only). It must
also name this application's audience and the team issuer, be within its validity window, be
an application token (`type: "app"`), and be issued to Executor's client ID (`common_name`,
compared in constant time). Authentication happens before routing, so unauthenticated callers
can't probe paths or methods. If Access were removed or misconfigured, every request would get 403. Authenticated requests must then pass these checks:

- No `Origin` header. MCP clients here are servers, so a browser origin means cross-site use or DNS rebinding.
- `POST /mcp`, JSON content type, body at most 64 KiB, valid UTF-8.
- One JSON-RPC message per request. Batches, unknown methods and unsupported `MCP-Protocol-Version` values are rejected.
- Tool arguments are decoded with Effect Schema: bounded strings and numbers, and unknown keys rejected.

Responses carry `cache-control: no-store`, `nosniff`, and a deny-all content security policy.
The server keeps no MCP sessions, so there is no session state to steal or fixate.

**3. Durable Object: one ledger, no other entrances** (`src/vault.ts`). Only the Worker can
reach it, and only after layer 2. It exposes `handleMcp` and an hourly `watchdog`. All SQL is
parameterized, and search text is matched literally (`LIKE` wildcards are escaped). Every tool
is read-only except `sync_now`, which only fetches from SimpleFIN.

**4. SimpleFIN client: the credential goes one place** (`src/simplefin/`):

- Setup tokens and access URLs must be HTTPS on `bridge.simplefin.org` or `beta-bridge.simplefin.org`, on the default port, with no query string. A forged setup token can't point the bridge elsewhere.
- Credentials travel only in the `Authorization` header, never in a URL.
- Redirects are never followed (`redirect: "manual"`, and any 3xx response is an error), so a redirect can't carry credentials to another host or to plain HTTP.
- Responses are size-bounded (25 MiB) and must be strict UTF-8. Each record is schema-decoded on its own, so one malformed record is skipped and reported instead of stopping the sync.

**5. The access URL is never handled loosely.** `scripts/claim.ts` checks the Cloudflare token
and the Secrets Store before spending the one-time setup token. It reads the setup token with
echo off (or from stdin), claims it, and writes the access URL straight into Secrets Store.
Secrets Store never returns stored values. The access URL is never printed, logged or written
to disk, and unexpected errors print only their type. Inside the Worker it is wrapped in Effect
`Redacted` from the moment it is read, and only the outgoing request header unwraps it. Because
`alchemy.run.ts` binds the secret by store and name, Alchemy state, CI and deploy environments
never contain it. A SHA-256 fingerprint is stored so a re-claim can clear backoff; it can't be
reversed, because the access URL carries a long random password.

**6. Executor holds the service token as handles** (`executor-app/`):

- The provider declares the bridge as its only host and uses `request` placement. Executor substitutes the client ID and secret only as the two exact `CF-Access-*` header values, over HTTPS, to that host. App code never sees the values.
- The account is a per-user requirement, so other members of the Executor organization get no tools.
- `sync_now` requires approval.

**7. Logs carry no data.** Invocation logs are disabled because they capture request headers.
The code logs only event names, refusal reasons, error tags and counts. It never logs request
bodies, amounts, descriptions, tokens or URLs.

**8. Text from banks is untrusted.** Merchant names, payees and memos are attacker-controlled in
the prompt-injection sense. Control characters, bidirectional overrides and zero-width
characters are stripped, values are length-bounded, and the server instructions tell agents to
treat the text as data.

**9. Quota abuse can't get the token disabled.** Requests are recorded before they're sent, and
the 20-a-day budget is checked before any sync. The lease is claimed with one atomic SQL update,
so the alarm and `sync_now` can't both start a sync. The alarm handler never throws, which
avoids the runtime's immediate retries.

## What remains

- **Executor compromise.** Someone who controls Executor, or the member account that linked the token, can read the ledger through the tools. Revoke the service token in Zero Trust to cut it off at the edge.
- **Cloudflare account compromise** exposes everything. Use a hardware key on the Cloudflare login, and give the claim script's API token only _Secrets Store: Edit_.
- **Data at rest** is encrypted by Cloudflare (AES-256), not by the app. Field-level encryption would make SQL queries impossible. Cloudflare's 30-day point-in-time recovery may keep deleted data restorable for that long.
- **Service tokens expire** (default: one year). Access sends an alert a week before. Rotate the token and update Executor's account.
- **Header forwarding.** Cloudflare doesn't document whether Access strips `CF-Access-Client-*` headers before the Worker sees them. The Worker never logs headers either way.
- **Bridge reachability from Workers.** The Bridge's CDN blocks some clients (error 1010). If it blocks Cloudflare Workers egress, sync fails visibly with `EdgeBlocked`, and only a first live sync can confirm either way.
- **Recurring detection** relies on synced history only, as in the CLI.

## Revoking everything

1. Disable the app's connection at https://bridge.simplefin.org. This kills the access URL at the source.
2. `pnpm claim --forget` deletes the secret.
3. Delete the service token in Zero Trust → Access controls → Service credentials.
4. `pnpm exec alchemy destroy --stage production` deletes the Worker, the Durable Object and its data, and the Access application.

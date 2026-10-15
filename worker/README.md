# SimpleFIN bridge on Cloudflare

A port of [simplefin-cli](../README.md) to a Cloudflare Worker and one SQLite-backed Durable
Object. It syncs your accounts from [SimpleFIN Bridge](https://bridge.simplefin.org) on alarms
and serves the same read-only tools as the CLI's MCP server to [Executor](https://executor.sh).
There is no local process to keep running and no web UI.

```text
Executor app ──HTTPS + CF-Access-Client-Id/Secret──▶ Cloudflare Access (service-token policy)
                                                        │ Cf-Access-Jwt-Assertion
                                                        ▼
                         Worker: verify JWT, POST /mcp only ──RPC──▶ Durable Object "ledger"
                                                                   SQLite · alarms · MCP tools
                                                                        │ Basic auth, host-pinned
                                                                        ▼
                                                         bridge.simplefin.org/simplefin/accounts
```

The SimpleFIN access URL lives only in Cloudflare Secrets Store. The claim script writes it,
the Durable Object reads it, and deployments never carry it. See [docs/security.md](docs/security.md)
for the threat model and [docs/deployment.md](docs/deployment.md) for the runbook.

## Set up, in this order

1. Deploy the bridge with an Access service token for Executor
   ([deployment.md § 1–4](docs/deployment.md#1-access-team-settings)).
2. Connect Executor and confirm `sync_status` answers with `access_configured: false`
   ([§ 5](docs/deployment.md#5-connect-executor)).
3. **Only now set up SimpleFIN.** Subscribe at bridge.simplefin.org, connect your banks,
   create a setup token, and run `pnpm claim` straight away
   ([§ 6](docs/deployment.md#6-claim-simplefin)). Setup tokens work once, and anyone who claims
   yours first can read your accounts, so don't create one before the bridge can claim it.
4. The hourly watchdog starts the first sync, which loads 365 days of history in nine
   requests. After that the bridge syncs every 12 hours.

## Tools

The same eight tools as the CLI's MCP server, with the same names, parameters and defaults.

| Tool                     | What it does                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `list_accounts`          | Accounts with institution, balance and balance date                                                                 |
| `list_transactions`      | Newest first. Filters: `account`, `since`/`until`, `search`, `min_amount`/`max_amount`, `pending`, `limit` (1–1000) |
| `summarize_cash_flow`    | Money in and out per account over a period                                                                          |
| `get_balance_history`    | Balance recorded at each sync                                                                                       |
| `find_recurring_charges` | Subscriptions, bills and installment fees that repeat                                                               |
| `top_merchants`          | Spending by normalized merchant; transfers excluded                                                                 |
| `sync_status`            | Last sync, requests used today, Bridge errors                                                                       |
| `sync_now`               | Fetch from SimpleFIN now. The only tool not marked read-only, so Executor asks before running it                    |

Differences from the CLI's MCP server:

- List results are wrapped in an object (`{ "accounts": [...] }`) so they can travel as MCP
  structured content.
- Raw `extra` payloads and connection `sfin_url`s are not stored, because nothing reads them.
- Setup tokens and access URLs must point at `bridge.simplefin.org` or
  `beta-bridge.simplefin.org`.
- Unknown tool arguments are rejected rather than ignored.
- Dates use `TIME_ZONE` (default `America/New_York`), since Workers run in UTC.

Quota rules are the CLI's: a local budget of 20 requests a day, at most one automatic attempt
every 3 hours, a one-day backoff after the Bridge revokes access or asks for payment, and
`sync_now` refuses within an hour of a sync. A new claim clears the backoff.

## Commands

```sh
pnpm install --frozen-lockfile && pnpm effect:setup
pnpm verify            # format, lint, types, unit + workerd end-to-end tests
pnpm test:auth         # just the Access and request-filtering tests
pnpm executor:check    # type-check the Executor app against its pinned framework
pnpm plan              # preview infrastructure changes (needs Cloudflare credentials)
pnpm deploy            # verify, then deploy stage "production" from a clean checkout
pnpm claim             # claim a setup token into Secrets Store (owner only, in a terminal)
pnpm claim --replace   # re-claim after creating a new setup token
pnpm claim --forget    # delete the stored access URL
```

The toolchain follows Stephen's project-kit web template: pnpm, Vite+, TypeScript 7 checks,
Effect 4 with Effect SQL, the vendored anti-slop lint rules, and Alchemy as the provisioning
source of truth. It has no SvelteKit app, no D1, and one stage.

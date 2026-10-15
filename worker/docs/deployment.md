# Deployment runbook

Alchemy is the source of truth for the Worker, the Durable Object, the custom domain and the
Access application. The stack deploys one stage, `production`: there is one owner and one
ledger, and a staging copy of bank data would double the exposure for no benefit.

Secrets never go through this repository, chat, CI, or Alchemy state:

| Secret                      | Created by                       | Stored in                                |
| --------------------------- | -------------------------------- | ---------------------------------------- |
| Access service token secret | You, in the Zero Trust dashboard | Executor's account form, pasted directly |
| SimpleFIN setup token       | You, at bridge.simplefin.org     | Nowhere; `pnpm claim` spends it          |
| SimpleFIN access URL        | `pnpm claim`                     | Cloudflare Secrets Store                 |
| Cloudflare API tokens       | You                              | Your shell or an Alchemy profile         |

## 1. Access team settings

In Zero Trust → Settings → Authentication (or the Access organization settings), turn on
**strict service token authentication**. It is on and locked for organizations created after
2026-10-05, but must be turned on for older ones. Requests carrying a bad service token then
get 401/403 instead of a login redirect, and Allow policies and cookies can't satisfy a
service-token request.

## 2. Service token for Executor

Zero Trust → Access controls → Service credentials → **Create service token**:

- Name: `executor-simplefin-bridge`
- Duration: 1 year (Access alerts a week before expiry)

The client secret is shown once. Paste the client ID and secret straight into Executor's
connect form ([§ 5](#5-connect-executor)), or into your password manager if Executor isn't
ready yet. Never paste the secret into a chat, a file in this repository, or `.env`.

Note the token's **client ID** and its **token ID** (the UUID in the token's dashboard URL,
or `id` from `GET /accounts/{account}/access/service_tokens`). Neither is secret.

## 3. Configure the stack

Copy `.env.example` to `.env` (gitignored) and fill it in. Every value is non-secret:

| Variable                    | Example                                                                                                               |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `SIMPLEFIN_HOSTNAME`        | A subdomain of a zone you own. A non-descriptive label hides the bridge's purpose from certificate-transparency logs. |
| `SIMPLEFIN_ZONE`            | The zone, e.g. `example.com`                                                                                          |
| `ACCESS_TEAM_DOMAIN`        | `https://<team>.cloudflareaccess.com`                                                                                 |
| `EXECUTOR_SERVICE_TOKEN_ID` | Token UUID from § 2                                                                                                   |
| `EXECUTOR_CLIENT_ID`        | Client ID from § 2, ending in `.access`                                                                               |
| `TIME_ZONE`                 | IANA name; default `America/New_York`                                                                                 |
| `AUTO_SYNC_HOURS`           | Default `12`; `0` turns automatic sync off                                                                            |
| `INITIAL_SYNC_DAYS`         | History for the first sync; default `365` (nine requests)                                                             |

Deploy credentials come from an Alchemy profile (`pnpm exec alchemy profile`) or
`CLOUDFLARE_ACCOUNT_ID` plus `CLOUDFLARE_API_TOKEN` in your shell. The state store is the
shared `Cloudflare.state()`; bootstrap it once per account with
`pnpm exec alchemy cloudflare bootstrap` if no other project has.

## 4. Deploy

```sh
pnpm plan     # review: Access application, Secrets Store (adopted), Worker, custom domain
pnpm deploy   # refuses a dirty checkout, runs pnpm verify, then deploys
```

The deploy creates the Access application before the Worker, which reads its audience tag,
and attaches the custom domain last, so the hostname never serves traffic without Access.
Check the result:

```sh
curl -si https://<SIMPLEFIN_HOSTNAME>/mcp   # expect 401/403 from Access, never JSON
```

## 5. Connect Executor

`executor-app/` is an Executor app that mounts the bridge with `mcpRouter`. Copy
`executor-app/host.example.ts` to `executor-app/host.ts` (gitignored), set your hostname, and
run `pnpm executor:check`. Then create and deploy it with the Executor CLI from
`executor-app/` (see Executor's `app-authoring` → `deploy.md`):

```sh
executor apps create --name "SimpleFIN bridge" --files ./executor-app --host https://api.executor.sh
executor apps deploy --app <app-id> --commit <commit> --host https://api.executor.sh
```

Request a connection for the `bridge` requirement (`appAccounts.userConnect`) and open the link
it returns. Paste the client ID and secret into the form. The health check connects with the
token, then confirms the bridge refuses the same request without it.

Call `sync_status` through Executor. Expect `access_configured: false`.

## 6. Claim SimpleFIN

Do this only after § 5 works, because a setup token can be claimed once, by whoever gets to it
first.

1. At https://bridge.simplefin.org: subscribe, connect your institutions, and create a setup
   token for a new app named `simplefin-bridge`.
2. Straight away, in a terminal:

   ```sh
   export CLOUDFLARE_ACCOUNT_ID=<account id>
   pnpm claim      # prompts for a Secrets Store–only API token, then the setup token; both hidden
   ```

   The API token needs only _Account › Secrets Store › Edit_. Delete it afterwards if you like.
   To pipe the setup token from a password manager instead: `op read … | pnpm claim --stdin`.

3. Within the hour, the watchdog cron runs the first sync. To start it now, call `sync_now`
   through Executor and approve it. Check `sync_status` and `list_accounts`.

If the claim prints "rejected the setup token", someone else may have claimed it. Disable it at
the Bridge and create a new one.

## Operations

- **Rotate the service token:** create a new token, add its ID to the policy (`EXECUTOR_SERVICE_TOKEN_ID`) and its client ID to `EXECUTOR_CLIENT_ID`, deploy, reconnect the Executor account with the new values, then delete the old token.
- **Re-claim:** create a new setup token, then `pnpm claim --replace`. The bridge notices the new credential and clears any backoff.
- **Logs:** `pnpm exec alchemy logs` shows the Worker's structured events: refusal reasons, sync counts and error tags. It never shows data or credentials.
- **Revoke everything:** see [security.md](security.md#revoking-everything).

## CI

`.github/workflows/worker.yml` runs `pnpm verify` (including the workerd end-to-end tests) on
pull requests and pushes that touch `worker/`. CI never deploys; deployment needs your
Cloudflare credentials and happens from your machine.

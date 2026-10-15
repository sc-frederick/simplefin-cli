# SimpleFIN bridge (Cloudflare Worker)

Use pnpm and Vite+. Run `pnpm verify` before handing back changes; it includes the workerd
end-to-end tests. This package follows the project-kit web template's toolchain without its
SvelteKit app: use the installed coding-standards skill, Effect 4 and Effect SQL, and the
vendored anti-slop rules in tools/oxlint/anti-slop. Parse external input with Effect Schema and
keep known failures typed.

## Security rules

Read docs/security.md before changing authentication, logging, the SimpleFIN client, tools, or
alchemy.run.ts. In particular:

- Never ask anyone to paste a setup token, access URL, or Access service token secret into chat.
  The owner runs `pnpm claim` and pastes service-token values into Executor's own form.
- Never log or return request bodies, headers, financial data, tokens, or URLs. Log event names,
  error tags and counts.
- Keep authentication before routing in src/edge/handler.ts, and keep every tool except
  sync_now read-only.
- Don't deploy, claim, or change Access or Secrets Store without the owner's explicit approval.

## Layout

- src/edge: Access JWT verification and request filtering (runs in the Worker).
- src/mcp: stateless JSON-RPC MCP server and the tool registry.
- src/app, src/store, src/domain: sync policy, SQLite storage, pure rules ported from the CLI.
- src/simplefin: SimpleFIN credentials, client, and response parsing.
- executor-app: the Executor app that mounts the bridge; type-checked with `pnpm executor:check`.

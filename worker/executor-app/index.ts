import { accountRouter, defineApp, toolAnnotations, withApprovals } from "apps";
import { mcpRouter } from "apps/mcp";
import { always } from "apps/operations/approval";
import { provider, url } from "./provider.js";

/**
 * Read-only access to the owner's synced bank data. The account is a user requirement, so only
 * the member who linked the service token can call these tools; other members see none.
 */
export default defineApp(
  { user: { accounts: { bridge: provider.many() } } },
  async ({ user, cache, signal }) => ({
    tools: await accountRouter(
      user?.accounts.bridge ?? [],
      async (account) =>
        // Every tool the bridge does not mark read-only (sync_now spends Bridge quota) needs approval.
        withApprovals(
          await mcpRouter({ url, account, headers: account.headers(), cache, signal }),
          (tool) => (toolAnnotations(tool)?.readOnlyHint === true ? undefined : always()),
        ),
      { signal },
    ),
  }),
);

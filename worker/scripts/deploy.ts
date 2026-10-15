/**
 * Deploy the bridge from a clean, verified checkout. Only the owner runs this, with Cloudflare
 * credentials in the environment (CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN or an Alchemy
 * profile) and the non-secret settings described in .env.example.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function run(command: string, args: ReadonlyArray<string>): void {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  if (result.status !== 0) process.exit(result.status ?? 1);
}

const status = spawnSync("git", ["status", "--porcelain", "--", "."], { encoding: "utf8" });

if (status.status !== 0 || status.stdout.trim() !== "") {
  console.error("Deploy a clean, committed checkout of worker/.");
  process.exit(1);
}

// Format, lint, types, and every test, including the Access rejection tests against workerd.
run(pnpm, ["verify"]);

const alchemy = fileURLToPath(new URL("../node_modules/alchemy/bin/cli.js", import.meta.url).href);

run(process.execPath, [alchemy, "deploy", "--stage", "production"]);

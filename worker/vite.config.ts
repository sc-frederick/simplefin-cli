import { defineConfig } from "vite-plus";
import { formatIgnores, lintSettings } from "./tools/lint.ts";

export default defineConfig({
  lint: lintSettings(),
  fmt: { ignorePatterns: formatIgnores },
  test: { include: ["tests/**/*.test.ts"], testTimeout: 30_000 },
});

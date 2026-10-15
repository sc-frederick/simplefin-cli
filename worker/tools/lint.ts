import { resolve } from "node:path";

// Keep the registered rules explicit so application type checking never traverses
// the vendored plugin implementation. Review this list when its upstream pin moves.
const genericRules = [
  "no-array-filter-map",
  "no-reduce-accumulator-copy",
  "no-chained-type-assertions",
  "no-conditional-empty-object-spread",
  "no-known-value-widening",
  "no-module-mocking",
  "no-object-parameters",
  "no-reflect-apply",
  "no-reflect-get",
  "no-runtime-typeof",
  "no-unsafe-dictionary-type",
  "no-shape-in-symbol-names",
  "no-unknown-parameters",
  "no-unknown-returns",
  "no-unknown-type-aliases",
  "no-widen-then-assert",
  "require-readable-spacing",
  "require-safety-comment-for-type-assertion",
];

const effectRules = [
  "no-manual-effect-error-tag",
  "no-manual-tag-comparison",
  "no-manual-tagged-construction",
  "no-service-constructor-imports",
  "prefer-effect-match",
];

/** Enable the pinned generic and Effect rules from the vendored plugins. */
export function lintSettings(pluginDirectory = "tools/oxlint/anti-slop") {
  return {
    options: { typeAware: true, typeCheck: true },
    ignorePatterns: [
      "repos/**",
      "tools/oxlint/**",
      "node_modules/**",
      // Type-checked separately against its pinned `apps` framework (pnpm executor:check).
      "executor-app/**",
      ".svelte-kit/**",
      "build/**",
      "dist/**",
      "release/**",
      ".alchemy/**",
      ".wrangler/**",
      "test-results/**",
      ".project-kit/**",
      "design/reference/**",
      ".agents/**",
      ".codex/**",
      ".claude/**",
    ],
    jsPlugins: [
      { name: "anti-slop", specifier: resolve(pluginDirectory, "index.ts") },
      { name: "anti-slop-effect", specifier: resolve(pluginDirectory, "effect/index.ts") },
    ],
    rules: {
      "oxc/no-accumulating-spread": "error" as const,
      ...Object.fromEntries(genericRules.map((name) => [`anti-slop/${name}`, "error" as const])),
      ...Object.fromEntries(
        effectRules.map((name) => [`anti-slop-effect/${name}`, "error" as const]),
      ),
    },
  };
}

/** Keep vendored references and generated outputs outside formatting. */
export const formatIgnores = [
  "repos/**",
  "tools/oxlint/**",
  "node_modules/**",
  "executor-app/node_modules/**",
  ".svelte-kit/**",
  "build/**",
  "dist/**",
  "release/**",
  ".alchemy/**",
  ".wrangler/**",
  "test-results/**",
  "pnpm-lock.yaml",
  ".project-kit/**",
  "design/reference/**",
  ".agents/**",
  ".codex/**",
  ".claude/**",
];

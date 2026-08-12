import { createConfigForNuxt } from "@nuxt/eslint-config/flat";
import vitest from "eslint-plugin-vitest";

export default createConfigForNuxt()
  .append({
    ignores: [
      "dist",
      "node_modules",
      ".nuxt",
      ".output",
      "playground/.nuxt",
      "docs/.nuxt",
    ],
  })
  .append({
    rules: {
      "vue/multi-word-component-names": "off",
    },
  })
  .append({
    // Scoped to test files only so these rules can never fire on src/.
    files: ["test/**/*.ts"],
    plugins: { vitest },
    rules: {
      // Flags a test with no assertion at all — catches an empty test body.
      // `expectNonRetryable` (test/unit/envelope.test.ts) is a local helper
      // that itself makes an unconditional `expect(fn).toThrow(...)` call —
      // recognised here as an assertion function so tests that only call it
      // are not misflagged as assertion-free.
      "vitest/expect-expect": ["error", { assertFunctionNames: ["expect", "expectNonRetryable"] }],
      // Flags `expect` inside a conditional (e.g. `if (res) expect(...)`) or
      // inside a `catch` block with no unconditional assertion — both are
      // ways an assertion can silently never run.
      "vitest/no-conditional-expect": "error",
    },
  });

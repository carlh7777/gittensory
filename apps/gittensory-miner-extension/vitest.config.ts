import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Default to node (background.js / the pure state maps run there); the two DOM-page scripts opt into jsdom
    // per-file via a `// @vitest-environment jsdom` docblock (content.test.js / options.test.js).
    environment: "node",
    include: ["test/**/*.test.js"],
    setupFiles: ["test/setup.js"],
    coverage: {
      provider: "v8",
      // Every source script the app ships (#4865). These are classic (non-bundled) extension scripts, so the
      // suite imports them directly — with the source's own `globalThis.__GITTENSORY_MINER_EXTENSION_TEST__`
      // internals hook — so v8 attributes real coverage, which the repo's older node:vm harness could not do.
      include: ["background.js", "content.js", "opportunity-badge.js", "options.js", "toolbar-badge.js"],
      reporter: ["text", "lcov"],
      // Measured baseline: 100% statements/functions/lines and 97.89% branches. The only uncovered branches are
      // the four `if (globalThis.__GITTENSORY_MINER_EXTENSION_TEST__)` test-only export guards (one per script),
      // whose false arm can never run while this suite's setup file has the flag set. Branch floor sits just under
      // the measured value so a genuine regression fails CI without flaking on that irreducible remainder.
      thresholds: {
        statements: 100,
        branches: 97,
        functions: 100,
        lines: 100,
      },
    },
  },
});

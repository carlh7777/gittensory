import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.js"],
    setupFiles: ["test/setup.js"],
    coverage: {
      provider: "v8",
      // Only the source files this app-local suite actually imports (so v8 attributes real coverage). The two
      // DOM-page scripts — content.js (issue-page content script) and options.js (options-page form) — need a
      // jsdom mount harness and are deliberately left for a follow-up (#4865 stays open), mirroring how the
      // miner-ui half (#5613) shipped a baseline rather than everything at once.
      include: ["background.js", "opportunity-badge.js", "toolbar-badge.js"],
      reporter: ["text", "lcov"],
      // A real measured baseline (#4865: "establish a coverage baseline"), not an aspirational target — a floor
      // that catches a genuine regression (a big untested addition), with a couple points of buffer below the
      // measured value (100% statements/functions/lines, 96.63% branches the day this was wired) so routine
      // refactor churn doesn't false-fail. Raise it incrementally, per-PR, as the deferred DOM-page scripts and
      // background.js's remaining guard branches get covered.
      thresholds: {
        statements: 98,
        branches: 94,
        functions: 98,
        lines: 98,
      },
    },
  },
});

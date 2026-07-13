// These classic (non-bundled) extension scripts expose their internal, otherwise-unexported helpers on
// `globalThis` only when this flag is set — the same hook the repo's existing node:vm harness uses. Setting it
// before any test module is imported lets the app-local suite import the real source files directly (so v8 can
// attribute coverage to them, which a node:vm eval cannot) and reach those internals.
globalThis.__GITTENSORY_MINER_EXTENSION_TEST__ = true;

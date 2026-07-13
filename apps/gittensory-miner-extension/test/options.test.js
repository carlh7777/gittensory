// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const flush = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
};

// The subset of options.html the script queries. Kept in sync with options.html's ids/structure.
const FORM_MARKUP = `
  <form id="settings">
    <textarea id="watchedRepos"></textarea>
    <input id="minerUiUrl" type="url" />
    <textarea id="rankedCandidatesJson"></textarea>
    <button type="submit">Save</button>
    <button type="button" id="syncNow">Sync</button>
  </form>
  <p id="status" role="status"></p>
`;

// A stateful chrome mock: get merges defaults over the backing store, set mutates it, remove deletes a key.
function createChrome({ syncStore = {}, localStore = {}, sendMessage } = {}) {
  const sync = { ...syncStore };
  const local = { ...localStore };
  return {
    storage: {
      sync: {
        get: async (defaults) => ({ ...(defaults ?? {}), ...sync }),
        set: async (value) => Object.assign(sync, value),
        remove: async (key) => delete sync[key],
      },
      local: {
        get: async (defaults) => ({ ...(defaults ?? {}), ...local }),
        set: async (value) => Object.assign(local, value),
      },
    },
    runtime: { sendMessage: sendMessage ?? vi.fn() },
    _sync: sync,
    _local: local,
  };
}

async function importOptions() {
  vi.resetModules();
  await import("../options.js");
  await flush();
  return globalThis.__gittensoryMinerOptionsInternals;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("options.js pure helpers (imported without the options DOM mounted)", () => {
  let internals;
  beforeEach(async () => {
    document.body.innerHTML = ""; // no #settings form → the "not mounted" guard branch runs
    vi.stubGlobal("chrome", createChrome());
    internals = await importOptions();
  });

  it("exposes its internals and constants", () => {
    expect(internals.MAX_RANKED_CANDIDATES_JSON_BYTES).toBe(8 * 1024 * 1024);
    expect(internals.DEFAULT_MINER_UI_URL).toBe("http://localhost:5174");
    expect(internals.SYNC_RANKED_CANDIDATES_MESSAGE).toBe("gittensory-miner:sync-ranked-candidates");
  });

  it("parseWatchedRepos splits, trims, and drops blanks across newlines and commas", () => {
    expect(internals.parseWatchedRepos("a/b\n c/d , e/f \n\n")).toEqual(["a/b", "c/d", "e/f"]);
    expect(internals.parseWatchedRepos("")).toEqual([]);
    expect(internals.parseWatchedRepos(null)).toEqual([]);
  });

  it("parseRankedCandidatesJson returns [] for blank, parses an array, and rejects bad shapes", () => {
    expect(internals.parseRankedCandidatesJson("   ")).toEqual([]);
    expect(internals.parseRankedCandidatesJson(undefined)).toEqual([]);
    expect(internals.parseRankedCandidatesJson(null)).toEqual([]);
    expect(internals.parseRankedCandidatesJson('[{"issueNumber":1}]')).toEqual([{ issueNumber: 1 }]);
    expect(() => internals.parseRankedCandidatesJson('{"issueNumber":1}')).toThrow(/must be an array/);
    expect(() => internals.parseRankedCandidatesJson("{not json")).toThrow();
  });

  it("parseRankedCandidatesJson rejects a payload larger than the storage-quota limit", () => {
    const huge = JSON.stringify([{ blob: "x".repeat(internals.MAX_RANKED_CANDIDATES_JSON_BYTES) }]);
    expect(() => internals.parseRankedCandidatesJson(huge)).toThrow(/too large/);
  });

  it("normalizeMinerUiUrl trims and falls back to the default for empty/whitespace input", () => {
    expect(internals.normalizeMinerUiUrl("  http://localhost:9999  ")).toBe("http://localhost:9999");
    expect(internals.normalizeMinerUiUrl("   ")).toBe("http://localhost:5174");
    expect(internals.normalizeMinerUiUrl(null)).toBe("http://localhost:5174");
  });

  it("removeLegacyDiscoveryIndexUrl purges the stale synced key (#5343)", async () => {
    const chrome = createChrome({ syncStore: { discoveryIndexUrl: "http://stale" } });
    vi.stubGlobal("chrome", chrome);
    await internals.removeLegacyDiscoveryIndexUrl();
    expect("discoveryIndexUrl" in chrome._sync).toBe(false);
  });
});

describe("options.js options-page form wiring", () => {
  function mount(chrome) {
    document.body.innerHTML = FORM_MARKUP;
    vi.stubGlobal("chrome", chrome);
  }

  it("hydrates the form from stored settings on load", async () => {
    mount(
      createChrome({
        syncStore: { watchedRepos: ["JSONbored/gittensory", "owner/repo"], minerUiUrl: "http://localhost:9999" },
        localStore: { rankedCandidates: [{ issueNumber: 1 }] },
      }),
    );
    await importOptions();
    expect(document.querySelector("#watchedRepos").value).toBe("JSONbored/gittensory\nowner/repo");
    expect(document.querySelector("#minerUiUrl").value).toBe("http://localhost:9999");
    expect(document.querySelector("#rankedCandidatesJson").value).toContain('"issueNumber": 1');
  });

  it("hydrates empty defaults (non-array stored values degrade to empty)", async () => {
    mount(createChrome({ syncStore: { watchedRepos: "oops" }, localStore: { rankedCandidates: "oops" } }));
    await importOptions();
    expect(document.querySelector("#watchedRepos").value).toBe("");
    expect(document.querySelector("#rankedCandidatesJson").value).toBe("");
  });

  it("saves watched repos + ranked candidates on submit and reports the count", async () => {
    const chrome = createChrome();
    mount(chrome);
    await importOptions();
    document.querySelector("#watchedRepos").value = "a/b\nc/d";
    document.querySelector("#minerUiUrl").value = "http://localhost:7000";
    document.querySelector("#rankedCandidatesJson").value = '[{"issueNumber":1}]';
    document.querySelector("#settings").dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect(chrome._sync.watchedRepos).toEqual(["a/b", "c/d"]);
    expect(chrome._sync.minerUiUrl).toBe("http://localhost:7000");
    expect(chrome._local.rankedCandidates).toEqual([{ issueNumber: 1 }]);
    expect(document.querySelector("#status").textContent).toBe(
      "Saved 2 watched repo(s) and 1 ranked candidate(s).",
    );
  });

  it("reports the watching-only message when no ranked candidates are pasted", async () => {
    const chrome = createChrome();
    mount(chrome);
    await importOptions();
    document.querySelector("#watchedRepos").value = "a/b";
    document.querySelector("#settings").dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect(document.querySelector("#status").textContent).toBe("Watching 1 repository(ies).");
  });

  it("surfaces a parse error as status text instead of throwing", async () => {
    const chrome = createChrome();
    mount(chrome);
    await importOptions();
    document.querySelector("#rankedCandidatesJson").value = '{"issueNumber":1}';
    document.querySelector("#settings").dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect(document.querySelector("#status").textContent).toBe("Ranked candidates JSON must be an array.");
  });

  it("syncs ranked candidates from the miner UI on Sync-now (success path)", async () => {
    const sendMessage = vi
      .fn()
      .mockResolvedValue({ ok: true, payload: { ok: true, count: 3, minerUiUrl: "http://localhost:7000" } });
    const chrome = createChrome({ sendMessage });
    mount(chrome);
    await importOptions();
    document.querySelector("#minerUiUrl").value = "http://localhost:7000";
    document.querySelector("#syncNow").click();
    await flush();
    expect(chrome._sync.minerUiUrl).toBe("http://localhost:7000");
    expect(document.querySelector("#status").textContent).toBe(
      "Synced 3 ranked candidate(s) from http://localhost:7000.",
    );
  });

  it("reports a fallback message when the miner UI is unreachable on Sync-now", async () => {
    const sendMessage = vi
      .fn()
      .mockResolvedValue({ ok: true, payload: { ok: false, minerUiUrl: "http://localhost:7000", error: "boom" } });
    mount(createChrome({ sendMessage }));
    await importOptions();
    document.querySelector("#minerUiUrl").value = "http://localhost:7000";
    document.querySelector("#syncNow").click();
    await flush();
    expect(document.querySelector("#status").textContent).toContain(
      "Could not reach the miner UI at http://localhost:7000: boom",
    );
  });

  it("stringifies a non-Error thrown during save (String(error) branch)", async () => {
    const chrome = createChrome();
    chrome.storage.sync.set = async () => {
      throw "sync store offline"; // a raw string, not an Error instance
    };
    mount(chrome);
    await importOptions();
    document.querySelector("#watchedRepos").value = "a/b";
    document.querySelector("#settings").dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect(document.querySelector("#status").textContent).toBe("sync store offline");
  });

  it("falls back to the field URL and a generic error when the sync payload omits them", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ ok: true, payload: { ok: false } });
    mount(createChrome({ sendMessage }));
    await importOptions();
    document.querySelector("#minerUiUrl").value = "http://localhost:7000";
    document.querySelector("#syncNow").click();
    await flush();
    expect(document.querySelector("#status").textContent).toBe(
      "Could not reach the miner UI at http://localhost:7000: unknown error. Falling back to the pasted JSON below.",
    );
  });

  it("surfaces a thrown Sync-now error as status text", async () => {
    const sendMessage = vi.fn().mockRejectedValue(new Error("channel closed"));
    mount(createChrome({ sendMessage }));
    await importOptions();
    document.querySelector("#syncNow").click();
    await flush();
    expect(document.querySelector("#status").textContent).toBe("channel closed");
  });

  it("stringifies a non-Error thrown during Sync-now (String(error) branch)", async () => {
    const sendMessage = vi.fn().mockRejectedValue("port disconnected");
    mount(createChrome({ sendMessage }));
    await importOptions();
    document.querySelector("#syncNow").click();
    await flush();
    expect(document.querySelector("#status").textContent).toBe("port disconnected");
  });

  it("clears the status line after its timeout elapses", async () => {
    const chrome = createChrome();
    mount(chrome);
    await importOptions();
    document.querySelector("#watchedRepos").value = "a/b";
    document.querySelector("#settings").dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect(document.querySelector("#status").textContent).not.toBe("");
    await new Promise((resolve) => setTimeout(resolve, 2700));
    expect(document.querySelector("#status").textContent).toBe("");
  }, 8000);
});

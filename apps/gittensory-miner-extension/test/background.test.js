import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}

// A configurable chrome mock modelled on the shapes background.js's own guards expect. `minimal` omits every
// optional surface (alarms/action/onChanged/onStartup/onInstalled) so the "clean no-op in a bare environment"
// guard branches are exercised too.
function createChrome({
  syncStore = {},
  localStore = {},
  minimal = false,
  syncGetThrows = false,
  actionThrows = false,
} = {}) {
  const calls = {
    badgeText: [],
    badgeColor: [],
    localSet: [],
    warn: [],
    alarmCreate: null,
    fetched: [],
  };
  const listeners = {};

  const chrome = {
    runtime: {
      onMessage: { addListener: (fn) => (listeners.message = fn) },
    },
    storage: {
      sync: {
        get: async (defaults) => {
          if (syncGetThrows) throw new Error("sync get failed");
          return { ...(defaults ?? {}), ...syncStore };
        },
        set: async () => {},
        remove: async () => {},
      },
      local: {
        get: async (arg) => {
          if (typeof arg === "string") {
            return { [arg]: arg in localStore ? localStore[arg] : undefined };
          }
          return { ...(arg ?? {}), ...localStore };
        },
        set: async (value) => {
          calls.localSet.push(value);
          Object.assign(localStore, value);
        },
      },
    },
  };

  if (!minimal) {
    chrome.action = {
      setBadgeText: async (value) => {
        calls.badgeText.push(value);
        if (actionThrows) throw new Error("chrome.action unavailable");
      },
      setBadgeBackgroundColor: async (value) => {
        calls.badgeColor.push(value);
      },
    };
    chrome.storage.onChanged = { addListener: (fn) => (listeners.changed = fn) };
    chrome.alarms = {
      create: (name, options) => (calls.alarmCreate = { name, options }),
      onAlarm: { addListener: (fn) => (listeners.alarm = fn) },
    };
    chrome.runtime.onStartup = { addListener: (fn) => (listeners.startup = fn) };
    chrome.runtime.onInstalled = { addListener: (fn) => (listeners.installed = fn) };
  }

  return { chrome, calls, listeners };
}

async function loadBackground(options = {}) {
  const built = createChrome(options);
  const fetchImpl = vi.fn(async (url) => {
    built.calls.fetched.push(url);
    return options.fetchResponse ?? jsonResponse({ candidates: [{ repoFullName: "a/b", issueNumber: 1 }] });
  });
  if (options.fetchThrows) fetchImpl.mockImplementation(async () => {
    throw new Error("network down");
  });

  vi.resetModules();
  vi.stubGlobal("chrome", built.chrome);
  vi.stubGlobal("fetch", fetchImpl);

  await import("../background.js");
  await flush();

  return {
    ...built,
    fetchImpl,
    internals: globalThis.__gittensoryMinerBackgroundInternals,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("background.js message router (#4859)", () => {
  let sendResponse;
  beforeEach(() => {
    sendResponse = vi.fn();
  });

  it("ignores messages with no/invalid type and returns false (no async response)", async () => {
    const bg = await loadBackground();
    expect(bg.listeners.message(null, {}, sendResponse)).toBe(false);
    expect(bg.listeners.message({ type: 42 }, {}, sendResponse)).toBe(false);
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it("answers a ping synchronously", async () => {
    const bg = await loadBackground();
    const ret = bg.listeners.message({ type: "gittensory-miner:ping" }, {}, sendResponse);
    expect(ret).toBe(false);
    expect(sendResponse).toHaveBeenCalledWith({ ok: true, payload: { ready: true } });
  });

  it("resolves issue-context asynchronously and keeps the channel open", async () => {
    const bg = await loadBackground({
      syncStore: { watchedRepos: ["JSONbored/gittensory"] },
      localStore: {
        rankedCandidates: [{ repoFullName: "JSONbored/gittensory", issueNumber: 145, rankScore: 0.8, laneFit: 0.8 }],
        rankedCandidatesSavedAt: 111,
      },
    });
    const ret = bg.listeners.message(
      { type: "gittensory-miner:issue-context", owner: "JSONbored", repo: "gittensory", issueNumber: 145 },
      {},
      sendResponse,
    );
    expect(ret).toBe(true);
    await flush();
    expect(sendResponse).toHaveBeenCalledWith({
      ok: true,
      payload: expect.objectContaining({ status: "ready", savedAt: 111 }),
    });
  });

  it("reports an error payload when issue-context resolution throws", async () => {
    const bg = await loadBackground({ syncGetThrows: true });
    bg.listeners.message(
      { type: "gittensory-miner:issue-context", owner: "o", repo: "r", issueNumber: 1 },
      {},
      sendResponse,
    );
    await flush();
    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: "sync get failed" });
  });

  it("triggers a live sync and returns its result", async () => {
    const bg = await loadBackground();
    const ret = bg.listeners.message({ type: "gittensory-miner:sync-ranked-candidates" }, {}, sendResponse);
    expect(ret).toBe(true);
    await flush();
    expect(sendResponse).toHaveBeenCalledWith({ ok: true, payload: expect.objectContaining({ ok: true, count: 1 }) });
  });

  it("returns false for an unknown message type", async () => {
    const bg = await loadBackground();
    expect(bg.listeners.message({ type: "gittensory-miner:unknown" }, {}, sendResponse)).toBe(false);
  });
});

describe("background.js loadIssueOpportunityContext", () => {
  it("returns repo-not-watched when the repo is not in the watch list", async () => {
    const bg = await loadBackground({ syncStore: { watchedRepos: ["  ", "owner/other"] } });
    const payload = await bg.internals.loadIssueOpportunityContext({ owner: "o", repo: "r", issueNumber: 1 });
    expect(payload).toEqual({
      watched: false,
      issueNumber: 1,
      repoFullName: "o/r",
      badge: null,
      status: "repo-not-watched",
    });
  });

  it("returns no-signal when watched but no ranked candidate matches", async () => {
    const bg = await loadBackground({
      syncStore: { watchedRepos: ["JSONbored/gittensory"] },
      localStore: { rankedCandidates: [] },
    });
    const payload = await bg.internals.loadIssueOpportunityContext({
      owner: "JSONbored",
      repo: "gittensory",
      issueNumber: 145,
    });
    expect(payload.status).toBe("no-signal");
    expect(payload.badge).toBeNull();
  });

  it("returns a ready badge when a watched repo has a cached ranked candidate", async () => {
    const bg = await loadBackground({
      syncStore: { watchedRepos: ["JSONbored/gittensory"] },
      localStore: {
        rankedCandidates: [{ repoFullName: "JSONbored/gittensory", issueNumber: 145, rankScore: 0.9, potential: 0.8 }],
        rankedCandidatesSavedAt: 999,
      },
    });
    const payload = await bg.internals.loadIssueOpportunityContext({
      owner: "JSONbored",
      repo: "gittensory",
      issueNumber: 145,
    });
    expect(payload.status).toBe("ready");
    expect(payload.badge.tier).toBe("High");
    expect(payload.savedAt).toBe(999);
  });
});

describe("background.js storage readers", () => {
  it("loadMinerExtensionSettings trims/filters a watch list and defaults a non-array to empty", async () => {
    const withList = await loadBackground({ syncStore: { watchedRepos: ["  JSONbored/gittensory  ", ""] } });
    expect((await withList.internals.loadMinerExtensionSettings()).watchedRepos).toEqual(["JSONbored/gittensory"]);

    const nonArray = await loadBackground({ syncStore: { watchedRepos: "oops" } });
    expect((await nonArray.internals.loadMinerExtensionSettings()).watchedRepos).toEqual([]);
  });

  it("loadRankedCandidates degrades a non-array cache and a non-numeric savedAt safely", async () => {
    const good = await loadBackground({ localStore: { rankedCandidates: [1, 2], rankedCandidatesSavedAt: 7 } });
    expect(await good.internals.loadRankedCandidates()).toEqual({ rankedCandidates: [1, 2], savedAt: 7 });

    const bad = await loadBackground({ localStore: { rankedCandidates: "nope", rankedCandidatesSavedAt: "nope" } });
    expect(await bad.internals.loadRankedCandidates()).toEqual({ rankedCandidates: [], savedAt: null });
  });

  it("loadMinerUiUrl returns the stored URL, or the default for empty/whitespace/non-string values", async () => {
    const custom = await loadBackground({ syncStore: { minerUiUrl: "http://localhost:9999" } });
    expect(await custom.internals.loadMinerUiUrl()).toBe("http://localhost:9999");

    const blank = await loadBackground({ syncStore: { minerUiUrl: "   " } });
    expect(await blank.internals.loadMinerUiUrl()).toBe("http://localhost:5174");

    const nonString = await loadBackground({ syncStore: { minerUiUrl: 42 } });
    expect(await nonString.internals.loadMinerUiUrl()).toBe("http://localhost:5174");
  });
});

describe("background.js syncRankedCandidatesFromMinerUi (#4859)", () => {
  it("writes fetched candidates to local storage and reports the count", async () => {
    const bg = await loadBackground({
      fetchResponse: jsonResponse({ candidates: [{ issueNumber: 1 }, { issueNumber: 2 }] }),
    });
    const result = await bg.internals.syncRankedCandidatesFromMinerUi();
    expect(result).toMatchObject({ ok: true, count: 2, minerUiUrl: "http://localhost:5174" });
    expect(bg.calls.localSet.at(-1)).toMatchObject({ rankedCandidates: [{ issueNumber: 1 }, { issueNumber: 2 }] });
  });

  it("returns a typed failure (never throws) on a non-OK response", async () => {
    const bg = await loadBackground({ fetchResponse: jsonResponse({}, { ok: false, status: 503 }) });
    const result = await bg.internals.syncRankedCandidatesFromMinerUi();
    expect(result).toEqual({ ok: false, error: "miner UI responded 503", minerUiUrl: "http://localhost:5174" });
  });

  it("rejects an unexpected payload shape", async () => {
    const bg = await loadBackground({ fetchResponse: jsonResponse({ candidates: "not-an-array" }) });
    const result = await bg.internals.syncRankedCandidatesFromMinerUi();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/unexpected payload shape/);
  });

  it("swallows a thrown fetch into a typed failure result", async () => {
    const bg = await loadBackground({ fetchThrows: true });
    const result = await bg.internals.syncRankedCandidatesFromMinerUi();
    expect(result).toEqual({ ok: false, error: "network down", minerUiUrl: "http://localhost:5174" });
  });
});

describe("background.js toolbar-badge wiring (#5193)", () => {
  it("paints the badge on startup from the current cache", async () => {
    const bg = await loadBackground({ localStore: { rankedCandidates: [1, 2] } });
    expect(bg.calls.badgeText).toContainEqual({ text: "2" });
  });

  it("refreshToolbarBadge maps never-populated / empty / populated caches through chrome.action", async () => {
    const never = await loadBackground({});
    never.calls.badgeText.length = 0;
    await never.internals.refreshToolbarBadge();
    expect(never.calls.badgeText.at(-1)).toEqual({ text: "–" });

    const populated = await loadBackground({ localStore: { rankedCandidates: [{}, {}, {}, {}] } });
    populated.calls.badgeText.length = 0;
    await populated.internals.refreshToolbarBadge();
    expect(populated.calls.badgeText.at(-1)).toEqual({ text: "4" });
  });

  it("repaints on a local rankedCandidates change and ignores other keys/areas", async () => {
    const bg = await loadBackground({ localStore: { rankedCandidates: [9] } });
    bg.calls.badgeText.length = 0;

    bg.listeners.changed({ rankedCandidates: { newValue: [9] } }, "local");
    await flush();
    expect(bg.calls.badgeText).toHaveLength(1);

    bg.calls.badgeText.length = 0;
    bg.listeners.changed({ rankedCandidates: { newValue: [9] } }, "sync");
    bg.listeners.changed({ watchedRepos: { newValue: [] } }, "local");
    await flush();
    expect(bg.calls.badgeText).toHaveLength(0);
  });

  it("swallows a rejected chrome.action call so the void-called refresh never leaks a rejection", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bg = await loadBackground({ localStore: { rankedCandidates: [1] }, actionThrows: true });
    await expect(bg.internals.refreshToolbarBadge()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});

describe("background.js ambient refresh wiring", () => {
  it("registers a periodic alarm and syncs when it fires under the right name", async () => {
    const bg = await loadBackground();
    expect(bg.calls.alarmCreate?.options).toEqual({ periodInMinutes: 10 });

    bg.fetchImpl.mockClear();
    bg.listeners.alarm({ name: "some-other-alarm" });
    await flush();
    expect(bg.fetchImpl).not.toHaveBeenCalled();

    bg.listeners.alarm({ name: bg.calls.alarmCreate.name });
    await flush();
    expect(bg.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("syncs on service-worker startup and on install", async () => {
    const bg = await loadBackground();

    bg.fetchImpl.mockClear();
    bg.listeners.startup();
    await flush();
    expect(bg.fetchImpl).toHaveBeenCalledTimes(1);

    bg.fetchImpl.mockClear();
    bg.listeners.installed();
    await flush();
    expect(bg.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("is a clean no-op (no paint, no throw) when the optional chrome surfaces are absent", async () => {
    const bg = await loadBackground({ minimal: true, localStore: { rankedCandidates: [1, 2] } });
    expect(typeof bg.internals.refreshToolbarBadge).toBe("function");
    expect(bg.calls.badgeText).toHaveLength(0);
    expect(bg.listeners.changed).toBeUndefined();
    expect(bg.listeners.alarm).toBeUndefined();
  });
});

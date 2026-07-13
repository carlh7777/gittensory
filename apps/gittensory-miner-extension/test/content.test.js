// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// content.js reads `globalThis.__gittensoryMinerOpportunityBadge` (published by opportunity-badge.js, which the
// browser loads first) at import time, and its exposed internals reuse it — so import it for its side effect here.
import "../opportunity-badge.js";

const flush = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const BADGE_SELECTOR = "[data-gittensory-miner-opportunity-badge]";

function setPath(pathname) {
  window.history.pushState({}, "", pathname);
}

// content.js only touches chrome.runtime.sendMessage (from loadOpportunityBadge). Stub it per scenario.
function stubChrome(sendMessage) {
  vi.stubGlobal("chrome", { runtime: { sendMessage } });
}

// Re-run content.js's top level under the current URL + chrome stub, then drain the void-called async mount.
async function importContent() {
  vi.resetModules();
  await import("../content.js");
  await flush();
  return globalThis.__gittensoryMinerContentInternals;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  setPath("/");
});

describe("content.js matchGitHubIssueTarget", () => {
  let internals;
  beforeEach(async () => {
    setPath("/");
    stubChrome(vi.fn().mockResolvedValue({ ok: false }));
    internals = await importContent();
  });

  it("parses an owner/repo/issue path into a typed issue target", () => {
    expect(internals.matchGitHubIssueTarget("/JSONbored/gittensory/issues/145")).toEqual({
      kind: "issue",
      owner: "JSONbored",
      repo: "gittensory",
      issueNumber: 145,
    });
  });

  it("returns null for non-issue paths, an empty path, and a nullish path", () => {
    expect(internals.matchGitHubIssueTarget("/JSONbored/gittensory/pull/145")).toBeNull();
    expect(internals.matchGitHubIssueTarget("/JSONbored/gittensory/issues/")).toBeNull();
    expect(internals.matchGitHubIssueTarget("")).toBeNull();
    expect(internals.matchGitHubIssueTarget(null)).toBeNull();
  });
});

describe("content.js findIssueSidebar", () => {
  let internals;
  beforeEach(async () => {
    setPath("/");
    stubChrome(vi.fn().mockResolvedValue({ ok: false }));
    internals = await importContent();
  });

  it("returns null when no known sidebar container is present", () => {
    expect(internals.findIssueSidebar()).toBeNull();
  });

  it("resolves each known sidebar selector, in priority order", () => {
    for (const setup of [
      { id: "partial-discussion-sidebar" },
      { attr: ["data-testid", "issue-sidebar"] },
      { cls: "Layout-sidebar" },
      { cls: "discussion-sidebar" },
    ]) {
      document.body.innerHTML = "";
      const el = document.createElement("div");
      if (setup.id) el.id = setup.id;
      if (setup.attr) el.setAttribute(setup.attr[0], setup.attr[1]);
      if (setup.cls) el.className = setup.cls;
      document.body.appendChild(el);
      expect(internals.findIssueSidebar()).toBe(el);
    }
  });
});

describe("content.js renderOpportunityBadge", () => {
  let internals;
  beforeEach(async () => {
    setPath("/");
    stubChrome(vi.fn().mockResolvedValue({ ok: false }));
    internals = await importContent();
  });

  function freshContainer() {
    const container = document.createElement("aside");
    container.dataset.gittensoryMinerOpportunityBadge = "true";
    container.hidden = true;
    document.body.appendChild(container);
    return container;
  }

  it("removes the container when the payload is not watched", () => {
    const container = freshContainer();
    internals.renderOpportunityBadge(container, { watched: false });
    expect(container.isConnected).toBe(false);
  });

  it("removes the container when there is no badge", () => {
    const container = freshContainer();
    internals.renderOpportunityBadge(container, { watched: true, badge: null });
    expect(container.isConnected).toBe(false);
  });

  it("removes the container when the badge produces no markup", () => {
    const container = freshContainer();
    // A truthy-but-non-object badge passes the guard yet yields an empty markup string.
    internals.renderOpportunityBadge(container, { watched: true, badge: "not-an-object" });
    expect(container.isConnected).toBe(false);
  });

  it("renders escaped markup and reveals the container for a real badge (with a synced label)", () => {
    const container = freshContainer();
    const nowMs = Date.parse("2026-07-10T12:00:00.000Z");
    internals.renderOpportunityBadge(
      container,
      { watched: true, badge: { tier: "High", score: "0.81", why: "Strong lane fit" }, savedAt: nowMs - 3 * 60_000 },
      nowMs,
    );
    expect(container.isConnected).toBe(true);
    expect(container.hidden).toBe(false);
    expect(container.innerHTML).toContain("LoopOver opportunity");
    expect(container.innerHTML).toContain("last synced 3m ago");
  });
});

describe("content.js mount (top-level side effect)", () => {
  it("does nothing on a non-issue page (no badge, no message sent)", async () => {
    setPath("/JSONbored/gittensory/pulls");
    const sendMessage = vi.fn().mockResolvedValue({ ok: true });
    stubChrome(sendMessage);
    await importContent();
    expect(document.querySelector(BADGE_SELECTOR)).toBeNull();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("mounts a badge into the issue sidebar and renders the resolved payload", async () => {
    setPath("/JSONbored/gittensory/issues/145");
    const sidebar = document.createElement("div");
    sidebar.id = "partial-discussion-sidebar";
    document.body.appendChild(sidebar);
    stubChrome(
      vi.fn().mockResolvedValue({
        ok: true,
        payload: { watched: true, badge: { tier: "High", score: "0.9", why: "Strong lane fit" }, savedAt: null },
      }),
    );
    await importContent();
    const badge = sidebar.querySelector(BADGE_SELECTOR);
    expect(badge).not.toBeNull();
    expect(badge.hidden).toBe(false);
    expect(badge.innerHTML).toContain("LoopOver opportunity");
  });

  it("falls back to a floating badge when no sidebar exists", async () => {
    setPath("/JSONbored/gittensory/issues/1");
    stubChrome(
      vi.fn().mockResolvedValue({
        ok: true,
        payload: { watched: true, badge: { tier: "Low", score: "0.20", why: "Balanced opportunity signals" } },
      }),
    );
    await importContent();
    const badge = document.body.querySelector(BADGE_SELECTOR);
    expect(badge).not.toBeNull();
    expect(badge.className).toContain("gittensory-miner-opportunity-badge--floating");
  });

  it("removes the container when the background responds not-ok", async () => {
    setPath("/JSONbored/gittensory/issues/7");
    stubChrome(vi.fn().mockResolvedValue({ ok: false }));
    await importContent();
    expect(document.querySelector(BADGE_SELECTOR)).toBeNull();
  });

  it("does not mount a second badge when one already exists on the page", async () => {
    setPath("/JSONbored/gittensory/issues/9");
    const existing = document.createElement("aside");
    existing.dataset.gittensoryMinerOpportunityBadge = "true";
    document.body.appendChild(existing);
    const sendMessage = vi.fn().mockResolvedValue({ ok: true, payload: { watched: true, badge: {} } });
    stubChrome(sendMessage);
    await importContent();
    expect(document.querySelectorAll(BADGE_SELECTOR)).toHaveLength(1);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

import { describe, expect, it } from "vitest";

// opportunity-badge.js ships as a classic (non-ESM-exporting) content script: importing it for its side effect
// publishes the helper API on globalThis, exactly as the browser loads it ahead of content.js.
import "../opportunity-badge.js";

const api = globalThis.__gittensoryMinerOpportunityBadge;

describe("opportunity-badge.js API surface", () => {
  it("publishes the same object on both the runtime global and the test-exports hook", () => {
    expect(api).toBeTruthy();
    expect(globalThis.__gittensoryMinerOpportunityBadgeTestExports).toBe(api);
  });
});

describe("issueLookupKey", () => {
  it("builds a normalized repo#issue key, lower-cased and trimmed", () => {
    expect(api.issueLookupKey("  JSONbored/Gittensory  ", "145")).toBe("jsonbored/gittensory#145");
    expect(api.issueLookupKey("owner/repo", 7)).toBe("owner/repo#7");
  });

  it("returns null for missing repo, non-integer, or non-positive issue numbers", () => {
    expect(api.issueLookupKey("", 1)).toBeNull();
    expect(api.issueLookupKey(null, 1)).toBeNull();
    expect(api.issueLookupKey("owner/repo", "not-a-number")).toBeNull();
    expect(api.issueLookupKey("owner/repo", 1.5)).toBeNull();
    expect(api.issueLookupKey("owner/repo", 0)).toBeNull();
    expect(api.issueLookupKey("owner/repo", -3)).toBeNull();
  });
});

describe("lookupRankedOpportunity", () => {
  const ranked = [
    null,
    "not-an-object",
    { repoFullName: "other/repo", issueNumber: 1 },
    { repoFullName: "JSONbored/gittensory", issueNumber: 145, rankScore: 0.8 },
  ];

  it("finds the matching entry by repo#issue key, skipping malformed entries", () => {
    const match = api.lookupRankedOpportunity(ranked, "jsonbored/gittensory", 145);
    expect(match?.rankScore).toBe(0.8);
  });

  it("returns null when the target key is unresolvable", () => {
    expect(api.lookupRankedOpportunity(ranked, "", 145)).toBeNull();
  });

  it("returns null when the ranked list is not an array", () => {
    expect(api.lookupRankedOpportunity(undefined, "owner/repo", 1)).toBeNull();
  });

  it("returns null when no entry matches", () => {
    expect(api.lookupRankedOpportunity(ranked, "owner/repo", 999)).toBeNull();
  });
});

describe("scoreToTier", () => {
  it("maps finite scores into High/Medium/Low bands", () => {
    expect(api.scoreToTier(0.9)).toBe("High");
    expect(api.scoreToTier(0.75)).toBe("High");
    expect(api.scoreToTier(0.6)).toBe("Medium");
    expect(api.scoreToTier(0.5)).toBe("Medium");
    expect(api.scoreToTier(0.2)).toBe("Low");
  });

  it("returns Unknown for a non-finite score", () => {
    expect(api.scoreToTier("nope")).toBe("Unknown");
    expect(api.scoreToTier(Number.NaN)).toBe("Unknown");
  });
});

describe("buildOpportunityWhy", () => {
  it("surfaces the strongest signals, capped at two, joined with a semicolon", () => {
    const why = api.buildOpportunityWhy({ laneFit: 0.9, freshness: 0.9, potential: 0.9 });
    expect(why).toBe("Strong lane fit; Fresh issue");
  });

  it("recognizes each individual signal threshold", () => {
    expect(api.buildOpportunityWhy({ potential: 0.7 })).toBe("High reward potential");
    expect(api.buildOpportunityWhy({ feasibility: 0.7 })).toBe("Feasible scope");
    expect(api.buildOpportunityWhy({ dupRisk: 0.3 })).toBe("Low duplicate risk");
  });

  it("falls back to a balanced-signals message when nothing crosses a threshold", () => {
    expect(api.buildOpportunityWhy({ laneFit: 0.1, dupRisk: 0.9 })).toBe("Balanced opportunity signals");
  });
});

describe("formatOpportunityBadge", () => {
  it("formats tier, a two-decimal score, and passes through the numeric rankScore", () => {
    expect(api.formatOpportunityBadge({ rankScore: 0.812, laneFit: 0.8 })).toEqual({
      tier: "High",
      score: "0.81",
      why: "Strong lane fit",
      rankScore: 0.812,
    });
  });

  it("degrades a non-finite rankScore to an em-dash score and a null rankScore", () => {
    const badge = api.formatOpportunityBadge({ rankScore: "n/a" });
    expect(badge.tier).toBe("Unknown");
    expect(badge.score).toBe("—");
    expect(badge.rankScore).toBeNull();
  });
});

describe("formatLastSyncedLabel (#5192)", () => {
  const NOW = Date.parse("2026-07-10T12:00:00.000Z");

  it("buckets the delta the same way ORB's RefreshMeta does", () => {
    expect(api.formatLastSyncedLabel(NOW, NOW)).toBe("last synced just now");
    expect(api.formatLastSyncedLabel(NOW - 59_000, NOW)).toBe("last synced just now");
    expect(api.formatLastSyncedLabel(NOW - 60_000, NOW)).toBe("last synced 1m ago");
    expect(api.formatLastSyncedLabel(NOW - 59 * 60_000, NOW)).toBe("last synced 59m ago");
    expect(api.formatLastSyncedLabel(NOW - 60 * 60_000, NOW)).toBe("last synced 1h ago");
    expect(api.formatLastSyncedLabel(NOW - 23 * 60 * 60_000, NOW)).toBe("last synced 23h ago");
    expect(api.formatLastSyncedLabel(NOW - 24 * 60 * 60_000, NOW)).toBe("last synced 1d ago");
  });

  it("clamps a future timestamp to just now rather than a negative delta", () => {
    expect(api.formatLastSyncedLabel(NOW + 5_000, NOW)).toBe("last synced just now");
  });

  it("returns null for a missing or invalid timestamp (never the epoch)", () => {
    expect(api.formatLastSyncedLabel(null, NOW)).toBeNull();
    expect(api.formatLastSyncedLabel(undefined, NOW)).toBeNull();
    expect(api.formatLastSyncedLabel(Number.NaN, NOW)).toBeNull();
    expect(api.formatLastSyncedLabel("", NOW)).toBeNull();
    expect(api.formatLastSyncedLabel("not-a-timestamp", NOW)).toBeNull();
  });
});

describe("escapeOpportunityHtml", () => {
  it("escapes every HTML-significant character", () => {
    expect(api.escapeOpportunityHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });

  it("coerces non-strings and leaves safe text untouched", () => {
    expect(api.escapeOpportunityHtml(42)).toBe("42");
    expect(api.escapeOpportunityHtml("plain text")).toBe("plain text");
  });
});

describe("renderOpportunityBadgeMarkup", () => {
  const badge = { tier: "High", score: "0.81", why: "Strong lane fit" };

  it("renders the read-only badge markup with escaped, script-free content", () => {
    const markup = api.renderOpportunityBadgeMarkup(badge);
    expect(markup).toContain("LoopOver opportunity");
    expect(markup).toContain("Read-only");
    expect(markup).toContain("High");
    expect(markup).not.toContain("<script>");
  });

  it("includes the last-synced label only when one is present", () => {
    expect(api.renderOpportunityBadgeMarkup(badge, "last synced 3m ago")).toContain("last synced 3m ago");
    const without = api.renderOpportunityBadgeMarkup(badge, null);
    expect(without).not.toContain("last synced");
    expect(without).not.toContain("NaN");
  });

  it("returns an empty string for a missing or non-object badge", () => {
    expect(api.renderOpportunityBadgeMarkup(null)).toBe("");
    expect(api.renderOpportunityBadgeMarkup("not-an-object")).toBe("");
  });
});

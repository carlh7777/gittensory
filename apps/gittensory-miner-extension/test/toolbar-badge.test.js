import { describe, expect, it } from "vitest";

import {
  computeToolbarBadge,
  TOOLBAR_BADGE_EMPTY_COLOR,
  TOOLBAR_BADGE_HAS_DATA_COLOR,
  TOOLBAR_BADGE_NO_DATA_TEXT,
} from "../toolbar-badge.js";

describe("computeToolbarBadge (toolbar-badge.js, #5193)", () => {
  it("shows the count with the has-data color when candidates are populated", () => {
    expect(computeToolbarBadge([{}, {}, {}])).toEqual({
      text: "3",
      backgroundColor: TOOLBAR_BADGE_HAS_DATA_COLOR,
    });
    expect(computeToolbarBadge([{}])).toEqual({
      text: "1",
      backgroundColor: TOOLBAR_BADGE_HAS_DATA_COLOR,
    });
  });

  it("clears the text (populated-but-empty state) for an empty array", () => {
    expect(computeToolbarBadge([])).toEqual({
      text: "",
      backgroundColor: TOOLBAR_BADGE_EMPTY_COLOR,
    });
  });

  it("shows a dash for the never-populated cache (undefined key)", () => {
    expect(computeToolbarBadge(undefined)).toEqual({
      text: TOOLBAR_BADGE_NO_DATA_TEXT,
      backgroundColor: TOOLBAR_BADGE_EMPTY_COLOR,
    });
  });

  it("treats any malformed non-array value as no-data (dash), never a numeric count", () => {
    for (const malformed of [null, "12", 7, { length: 5 }, true]) {
      expect(computeToolbarBadge(malformed)).toEqual({
        text: TOOLBAR_BADGE_NO_DATA_TEXT,
        backgroundColor: TOOLBAR_BADGE_EMPTY_COLOR,
      });
    }
  });

  it("INVARIANT: no-data (never-written or malformed) never renders as a numeric count", () => {
    for (const noData of [undefined, null, 0, "", { foo: "bar" }]) {
      const { text } = computeToolbarBadge(noData);
      expect(text).not.toMatch(/[0-9]/);
      expect(text).toBe(TOOLBAR_BADGE_NO_DATA_TEXT);
    }
  });

  it("exposes stable named constants so source and tests can never drift", () => {
    expect(TOOLBAR_BADGE_HAS_DATA_COLOR).toBe("#16a34a");
    expect(TOOLBAR_BADGE_EMPTY_COLOR).toBe("#6b7280");
    expect(TOOLBAR_BADGE_NO_DATA_TEXT).toBe("–");
  });

  it("mirrors the pure map onto the global the background service worker reads", () => {
    const api = globalThis.__gittensoryMinerToolbarBadge;
    expect(api.computeToolbarBadge).toBe(computeToolbarBadge);
    expect(api.TOOLBAR_BADGE_HAS_DATA_COLOR).toBe(TOOLBAR_BADGE_HAS_DATA_COLOR);
    expect(api.TOOLBAR_BADGE_EMPTY_COLOR).toBe(TOOLBAR_BADGE_EMPTY_COLOR);
    expect(api.TOOLBAR_BADGE_NO_DATA_TEXT).toBe(TOOLBAR_BADGE_NO_DATA_TEXT);
  });
});

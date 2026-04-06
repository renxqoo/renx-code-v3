import { describe, expect, it } from "vitest";

import {
  memoryAgeDays,
  memoryAge,
  memoryFreshnessText,
  memoryFreshnessNote,
} from "../../src/memory/freshness";

const DAY_MS = 86_400_000;

describe("freshness", () => {
  describe("memoryAgeDays", () => {
    it("returns 0 for current timestamp", () => {
      expect(memoryAgeDays(Date.now())).toBe(0);
    });

    it("returns 0 for a timestamp 12 hours ago", () => {
      expect(memoryAgeDays(Date.now() - DAY_MS / 2)).toBe(0);
    });

    it("returns 1 for yesterday", () => {
      expect(memoryAgeDays(Date.now() - DAY_MS)).toBe(1);
    });

    it("returns 2 for two days ago", () => {
      expect(memoryAgeDays(Date.now() - 2 * DAY_MS)).toBe(2);
    });

    it("returns 47 for 47 days ago", () => {
      expect(memoryAgeDays(Date.now() - 47 * DAY_MS)).toBe(47);
    });

    it("clamps negative (future) timestamps to 0", () => {
      expect(memoryAgeDays(Date.now() + DAY_MS)).toBe(0);
    });
  });

  describe("memoryAge", () => {
    it('returns "today" for 0 days', () => {
      expect(memoryAge(Date.now())).toBe("today");
    });

    it('returns "yesterday" for 1 day', () => {
      expect(memoryAge(Date.now() - DAY_MS)).toBe("yesterday");
    });

    it('returns "N days ago" for N >= 2', () => {
      expect(memoryAge(Date.now() - 2 * DAY_MS)).toBe("2 days ago");
      expect(memoryAge(Date.now() - 47 * DAY_MS)).toBe("47 days ago");
    });
  });

  describe("memoryFreshnessText", () => {
    it("returns empty string for today", () => {
      expect(memoryFreshnessText(Date.now())).toBe("");
    });

    it("returns empty string for yesterday", () => {
      expect(memoryFreshnessText(Date.now() - DAY_MS)).toBe("");
    });

    it("returns staleness warning for 2 days old", () => {
      const text = memoryFreshnessText(Date.now() - 2 * DAY_MS);
      expect(text).toContain("2 days old");
      expect(text).toContain("point-in-time observations");
      expect(text).toContain("Verify against current code");
    });

    it("returns staleness warning for 47 days old", () => {
      const text = memoryFreshnessText(Date.now() - 47 * DAY_MS);
      expect(text).toContain("47 days old");
    });
  });

  describe("memoryFreshnessNote", () => {
    it("returns empty string for fresh memories (today)", () => {
      expect(memoryFreshnessNote(Date.now())).toBe("");
    });

    it("returns empty string for yesterday", () => {
      expect(memoryFreshnessNote(Date.now() - DAY_MS)).toBe("");
    });

    it("wraps staleness text in <system-reminder> tags", () => {
      const note = memoryFreshnessNote(Date.now() - 5 * DAY_MS);
      expect(note).toMatch(/^<system-reminder>/);
      expect(note).toMatch(/<\/system-reminder>\n$/);
      expect(note).toContain("5 days old");
    });
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { getDailyLogPath, appendToDailyLog, ensureLogDir } from "../../src/memory/kairos/log";

describe("Kairos daily log", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  function tmpDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "renx-kairos-"));
    tempDirs.push(dir);
    return dir;
  }

  describe("getDailyLogPath", () => {
    it("returns path under logs/YYYY/MM/YYYY-MM-DD.md", () => {
      const path = getDailyLogPath("/mem", new Date("2026-04-06"));
      expect(path).toBe(join("/mem", "logs", "2026", "04", "2026-04-06.md"));
    });
  });

  describe("ensureLogDir", () => {
    it("creates nested log directory", async () => {
      const dir = tmpDir();
      const logPath = getDailyLogPath(dir, new Date("2026-04-06"));

      await ensureLogDir(logPath);

      const { stat } = await import("node:fs/promises");
      const logDir = join(dir, "logs", "2026", "04");
      const s = await stat(logDir);
      expect(s.isDirectory()).toBe(true);
    });
  });

  describe("appendToDailyLog", () => {
    it("appends entry to daily log file", async () => {
      const dir = tmpDir();

      await appendToDailyLog(dir, new Date("2026-04-06"), "User prefers bun over npm");

      const { readFile } = await import("node:fs/promises");
      const logPath = getDailyLogPath(dir, new Date("2026-04-06"));
      const content = await readFile(logPath, "utf8");
      expect(content).toContain("User prefers bun over npm");
    });

    it("appends multiple entries in order", async () => {
      const dir = tmpDir();
      const date = new Date("2026-04-06");

      await appendToDailyLog(dir, date, "First entry");
      await appendToDailyLog(dir, date, "Second entry");

      const { readFile } = await import("node:fs/promises");
      const logPath = getDailyLogPath(dir, date);
      const content = await readFile(logPath, "utf8");
      expect(content).toContain("First entry");
      expect(content).toContain("Second entry");
    });
  });
});

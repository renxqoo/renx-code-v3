import { describe, expect, it } from "vitest";

import {
  checkSharedMemorySnapshotForSecrets,
  createMemorySnapshot,
  scanMemorySecrets,
} from "../../src/memory";

describe("memory secret guard", () => {
  it("detects high-confidence credential patterns", () => {
    const matches = scanMemorySecrets(
      "github_pat_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890abcd and ghp_1234567890abcdefghijklmnopqrstuvwxyzABCD",
    );

    expect(matches.map((match) => match.ruleId)).toContain("github-fine-grained-pat");
    expect(matches.map((match) => match.ruleId)).toContain("github-pat");
  });

  it("reports which shared memory entries are unsafe to sync", () => {
    const report = checkSharedMemorySnapshotForSecrets(
      createMemorySnapshot({
        semantic: {
          entries: [
            {
              id: "project:secret",
              type: "project",
              content: "Do not share this key: ghp_1234567890abcdefghijklmnopqrstuvwxyzABCD",
              updatedAt: "2026-04-05T00:00:00.000Z",
              scope: "project",
            },
          ],
        },
      }),
    );

    expect(report.hasSecrets).toBe(true);
    expect(report.issues[0]?.key).toBe("semantic/project:secret");
    expect(report.issues[0]?.matches[0]?.label).toContain("GitHub");
  });
});

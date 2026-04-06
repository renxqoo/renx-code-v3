import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import { tmpdir } from "node:os";

import { InMemorySandboxPlatform, LocalSandboxPlatform } from "@renx/agent-sandbox";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const normalizeForAssert = (value: string): string => normalize(value).replaceAll("\\", "/");

describe("sandbox platforms", () => {
  it("in-memory platform supports sessions, exec, filesystem access, and snapshot restore", async () => {
    const platform = new InMemorySandboxPlatform();
    const instance = await platform.create({
      leaseId: "lease_memory",
      platform: "memory",
      workspaceRoot: "/workspace",
    });

    await instance.writeFile("/workspace/src/app.ts", "export const value = 1;\n");

    const session = await instance.createSession({ cwd: "/workspace" });
    expect((await instance.exec({ command: "pwd", sessionId: session.id })).stdout.trim()).toBe(
      "/workspace",
    );

    await instance.exec({ command: "cd src", sessionId: session.id });

    expect((await instance.exec({ command: "pwd", sessionId: session.id })).stdout.trim()).toBe(
      "/workspace/src",
    );
    expect(
      (await instance.exec({ command: "cat app.ts", sessionId: session.id })).stdout,
    ).toContain("value = 1");

    const entries = await instance.listFiles("/workspace");
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "/workspace/src",
          isDirectory: true,
        }),
      ]),
    );

    const binary = await instance.readBinaryFile("/workspace/src/app.ts");
    expect(Buffer.from(binary).toString("utf8")).toContain("value = 1");

    const snapshot = await instance.captureSnapshot("snap_memory");
    await instance.writeFile("/workspace/src/app.ts", "export const value = 2;\n");
    await instance.restoreSnapshot(snapshot);

    expect(await instance.readFile("/workspace/src/app.ts")).toContain("value = 1");
    await instance.dispose();
  });

  it("local platform scopes access to the workspace and restores snapshots", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-sandbox-local-"));
    tempDirs.push(dir);

    const filePath = join(dir, "src", "feature.ts");
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(filePath, "export const version = 1;\n", "utf8");

    const platform = new LocalSandboxPlatform();
    const instance = await platform.create({
      leaseId: "lease_local",
      platform: "local",
      workspaceRoot: dir,
    });

    const session = await instance.createSession({ cwd: dir });
    expect(
      normalizeForAssert(
        (await instance.exec({ command: "pwd", sessionId: session.id })).stdout.trim(),
      ),
    ).toBe(normalizeForAssert(dir));

    await instance.exec({ command: "cd src", sessionId: session.id });
    expect(
      normalizeForAssert(
        (await instance.exec({ command: "pwd", sessionId: session.id })).stdout.trim(),
      ),
    ).toBe(normalizeForAssert(join(dir, "src")));

    const snapshot = await instance.captureSnapshot("snap_local");
    await instance.writeFile(filePath, "export const version = 2;\n");
    await instance.restoreSnapshot(snapshot);

    expect(await instance.readFile(filePath)).toContain("version = 1");
    await expect(instance.readFile(join(dir, "..", "outside.ts"))).rejects.toThrow(/outside/i);
    await instance.dispose();
  });
});

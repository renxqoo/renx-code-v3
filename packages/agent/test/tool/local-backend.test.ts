import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platform } from "node:process";

import { LocalBackend } from "../../src/tool/local-backend";

describe("LocalBackend", () => {
  const backend = new LocalBackend();

  describe("capabilities()", () => {
    it("returns correct structure", () => {
      const caps = backend.capabilities();
      expect(caps).toEqual({
        exec: true,
        filesystemRead: true,
        filesystemWrite: true,
        network: true,
        binaryRead: true,
        pathMetadata: true,
      });
    });
  });

  describe("exec()", () => {
    it("runs a command and returns output", async () => {
      const result = await backend.exec("echo hello_world");
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("hello_world");
    });

    it("returns non-zero exit code on failure", async () => {
      const result = await backend.exec("false");
      expect(result.exitCode).not.toBe(0);
    });
  });

  /** Mirrors CLI agents: same commands users ask the bash tool to run. */
  describe("exec() shell parity (platform)", () => {
    const backend = new LocalBackend();

    describe.skipIf(platform !== "win32")("Windows (PowerShell → cmd)", () => {
      it("Get-ChildItem exits 0 and prints listing", async () => {
        const r = await backend.exec("Get-ChildItem");
        expect(r.exitCode, `stderr=${r.stderr}`).toBe(0);
        expect(r.stdout.length).toBeGreaterThan(0);
      });

      it("dir exits 0 and prints listing", async () => {
        const r = await backend.exec("dir");
        expect(r.exitCode, `stderr=${r.stderr}`).toBe(0);
        expect(r.stdout.length).toBeGreaterThan(0);
      });
    });

    describe.skipIf(platform === "win32")("Unix (sh -lc)", () => {
      it("ls exits 0", async () => {
        const r = await backend.exec("ls");
        expect(r.exitCode, `stderr=${r.stderr}`).toBe(0);
      });

      it("pwd exits 0 with absolute path", async () => {
        const r = await backend.exec("pwd");
        expect(r.exitCode, `stderr=${r.stderr}`).toBe(0);
        expect(r.stdout.trim()).toMatch(/^\//);
      });

      it("Get-ChildItem is not a POSIX command (expect non-zero)", async () => {
        const r = await backend.exec("Get-ChildItem");
        expect(r.exitCode).not.toBe(0);
      });
    });
  });

  describe("readFile()", () => {
    it("reads a file", async () => {
      const dir = await mkdtemp(join(tmpdir(), "local-backend-read-"));
      try {
        const filePath = join(dir, "test.txt");
        await writeFile(filePath, "hello from file", "utf-8");
        const content = await backend.readFile(filePath);
        expect(content).toBe("hello from file");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe("readBinaryFile()", () => {
    it("reads binary file content", async () => {
      const dir = await mkdtemp(join(tmpdir(), "local-backend-binary-"));
      try {
        const filePath = join(dir, "image.bin");
        await writeFile(filePath, Buffer.from([0x00, 0x01, 0x02, 0x03]));
        const content = await backend.readBinaryFile(filePath);
        expect([...content]).toEqual([0, 1, 2, 3]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe("writeFile()", () => {
    it("writes a file", async () => {
      const dir = await mkdtemp(join(tmpdir(), "local-backend-write-"));
      try {
        const filePath = join(dir, "output.txt");
        await backend.writeFile(filePath, "written content");
        const content = await backend.readFile(filePath);
        expect(content).toBe("written content");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe("listFiles()", () => {
    it("lists directory entries", async () => {
      const dir = await mkdtemp(join(tmpdir(), "local-backend-list-"));
      try {
        await writeFile(join(dir, "a.txt"), "a", "utf-8");
        await writeFile(join(dir, "b.txt"), "b", "utf-8");

        const entries = await backend.listFiles(dir);
        expect(entries).toHaveLength(2);

        const names = entries.map((e) => e.path.split("/").pop());
        expect(names).toContain("a.txt");
        expect(names).toContain("b.txt");

        for (const entry of entries) {
          expect(entry.isDirectory).toBe(false);
          expect(typeof entry.size).toBe("number");
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe("statPath()", () => {
    it("returns file metadata when the path exists", async () => {
      const dir = await mkdtemp(join(tmpdir(), "local-backend-stat-"));
      try {
        const filePath = join(dir, "meta.txt");
        await writeFile(filePath, "content", "utf-8");
        const info = await backend.statPath(filePath);
        expect(info).toMatchObject({
          path: filePath,
          isDirectory: false,
          size: 7,
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});

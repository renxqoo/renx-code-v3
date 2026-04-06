import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { AgentRunContext, ToolContext } from "@renx/agent";
import { LocalBackend } from "@renx/agent";
import type { ToolCall } from "@renx/model";

import {
  assessBashCommand,
  createBashTool,
  evaluateCompoundCommandPolicies,
  mergeBashSecurityConfig,
  splitShellSegments,
} from "../src/index";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { platform } from "node:process";

function minimalCtx(backend: ToolContext["backend"]): ToolContext {
  const runContext: AgentRunContext = {
    input: { messages: [] },
    identity: { userId: "u", tenantId: "t", roles: [] },
    state: {
      runId: "r",
      messages: [],
      scratchpad: {},
      memory: {},
      stepCount: 0,
      status: "running",
    },
    services: {},
    metadata: {},
  };
  const toolCall: ToolCall = {
    id: "c1",
    name: "bash",
    input: {},
  };
  return { runContext, toolCall, backend };
}

const getSchemaKeys = (schema: unknown): string[] => {
  expect(schema).toBeInstanceOf(z.ZodObject);
  return Object.keys((schema as z.ZodObject<any>).shape);
};

describe("splitShellSegments", () => {
  it("splits on && and respects single quotes", () => {
    expect(splitShellSegments(`echo 'a && b' && echo ok`)).toEqual([`echo 'a && b'`, `echo ok`]);
  });

  it("returns null when quotes are unbalanced", () => {
    expect(splitShellSegments(`echo 'no close`)).toBeNull();
  });
});

describe("assessBashCommand", () => {
  it("allows simple read-only style commands", () => {
    expect(assessBashCommand("ls -la")).toEqual({ ok: true });
  });

  it("blocks eval", () => {
    const v = assessBashCommand("eval rm -rf /");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("BLOCKED_COMMAND");
  });

  it("blocks command substitution", () => {
    const v = assessBashCommand("echo $(whoami)");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("SUBSHELL");
  });

  it("blocks inline shell -c", () => {
    const v = assessBashCommand(`bash -c 'echo hi'`);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("SHELL_INLINE");
  });

  it("allows /proc/*/environ when enterprise deep checks are off (default)", () => {
    expect(assessBashCommand("cat /proc/self/environ").ok).toBe(true);
  });

  it("blocks /proc/*/environ with enterpriseDeepSecurity", () => {
    const cfg = mergeBashSecurityConfig({ enterpriseDeepSecurity: true });
    const v = assessBashCommand("cat /proc/self/environ", cfg);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("PROC_ENVIRON");
  });

  it("blocks when prefix allowlist mismatches", () => {
    const cfg = mergeBashSecurityConfig({
      allowedCommandPrefixes: ["ls ", "cat "],
    });
    expect(assessBashCommand("rm -f x", cfg).ok).toBe(false);
    expect(assessBashCommand("ls -la", cfg).ok).toBe(true);
  });
});

describe("createBashTool isReadOnly hint", () => {
  it("does not split on && inside single quotes", () => {
    const tool = createBashTool();
    expect(tool.isReadOnly?.({ command: "echo 'a && b'" })).toBe(true);
  });

  it("detects write after real && chain", () => {
    const tool = createBashTool();
    expect(tool.isReadOnly?.({ command: "echo 'x' && rm -f y" })).toBe(false);
  });

  it("returns false when quotes are unbalanced", () => {
    const tool = createBashTool();
    expect(tool.isReadOnly?.({ command: "echo 'oops" })).toBe(false);
  });
});

describe("createBashTool", () => {
  it("exposes Claude-style schema fields", () => {
    const tool = createBashTool();
    expect(getSchemaKeys(tool.schema)).toEqual([
      "command",
      "timeout",
      "description",
      "run_in_background",
      "dangerouslyDisableSandbox",
    ]);
  });

  it("returns structured exec result and forwards timeout with internal cwd resolution", async () => {
    const root = mkdtempSync(join(tmpdir(), "renx-bash-exec-"));
    const calls: Array<{ command: string; opts?: { cwd?: string; timeoutMs?: number } }> = [];
    const tool = createBashTool({
      defaultTimeoutMs: 5_000,
      maxTimeoutMs: 10_000,
      resolveCwd: () => root,
    });
    const backend = {
      kind: "test",
      capabilities: () => ({
        exec: true,
        filesystemRead: false,
        filesystemWrite: false,
      }),
      exec: async (command: string, opts?: { cwd?: string; timeoutMs?: number }) => {
        calls.push({
          command,
          ...(opts ? { opts } : {}),
        });
        return {
          stdout: `ran:${command}`,
          stderr: "",
          exitCode: 0,
        };
      },
    };
    try {
      const out = await tool.invoke({ command: "echo hello", timeout: 4_000 }, minimalCtx(backend));
      expect(calls).toEqual([{ command: "echo hello", opts: { cwd: root, timeoutMs: 4_000 } }]);
      expect(out.structured).toMatchObject({ exitCode: 0, stdout: "ran:echo hello" });
      expect(out.content).toContain("ran:echo hello");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("explains missing backend instead of throwing", async () => {
    const tool = createBashTool();
    const out = await tool.invoke({ command: "echo hi" }, minimalCtx(undefined));
    expect(out.content).toMatch(/no execution backend/i);
    expect(out.metadata).toMatchObject({ error: "no_exec_backend" });
  });

  it("blocks before exec when security rejects", async () => {
    const tool = createBashTool();
    const backend = {
      kind: "test",
      capabilities: () => ({
        exec: true,
        filesystemRead: false,
        filesystemWrite: false,
      }),
      exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    };
    const out = await tool.invoke({ command: "eval 1" }, minimalCtx(backend));
    expect(out.metadata).toMatchObject({ blocked: true });
    expect(out.content).toMatch(/BLOCKED_COMMAND/);
  });

  it("blocks redirect outside workspace when pathPolicy set", async () => {
    const root = mkdtempSync(join(tmpdir(), "renx-bash-"));
    try {
      const inner = join(root, "inner");
      mkdirSync(inner);
      const tool = createBashTool({
        pathPolicy: { workspaceRoot: inner, allowRedirectOutsideWorkspace: false },
        resolveCwd: () => inner,
      });
      const backend = {
        kind: "test",
        capabilities: () => ({
          exec: true,
          filesystemRead: false,
          filesystemWrite: false,
        }),
        exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      };
      const out = await tool.invoke(
        { command: `echo hi > "${join(root, "escape.txt")}"` },
        minimalCtx(backend),
      );
      expect(out.metadata).toMatchObject({ blocked: true, code: "REDIRECT_OUTSIDE_WORKSPACE" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * Real subprocess path on Windows (same stack as demo-streaming: LocalBackend → PowerShell/cmd).
 * PowerShell-only commands use treeSitter: false — bash tree-sitter would treat unknown syntax as parse errors.
 */
describe.skipIf(platform !== "win32")("createBashTool Windows integration (LocalBackend)", () => {
  const backend = new LocalBackend();
  const winPsTool = () =>
    createBashTool({
      defaultTimeoutMs: 30_000,
      maxTimeoutMs: 60_000,
      treeSitter: { enabled: false },
    });

  it("Get-ChildItem exits 0 with stdout", async () => {
    const out = await winPsTool().invoke({ command: "Get-ChildItem" }, minimalCtx(backend));
    const st = out.structured as { exitCode?: number; stdout?: string } | undefined;
    expect(out.metadata?.blocked).toBeUndefined();
    expect(st?.exitCode).toBe(0);
    expect(String(st?.stdout ?? "").length).toBeGreaterThan(0);
  }, 60_000);

  it("dir exits 0 with stdout", async () => {
    const out = await winPsTool().invoke({ command: "dir" }, minimalCtx(backend));
    const st = out.structured as { exitCode?: number; stdout?: string } | undefined;
    expect(st?.exitCode).toBe(0);
    expect(String(st?.stdout ?? "").length).toBeGreaterThan(0);
  }, 60_000);

  it("Get-Location prints path", async () => {
    const out = await winPsTool().invoke({ command: "Get-Location" }, minimalCtx(backend));
    const st = out.structured as { exitCode?: number; stdout?: string } | undefined;
    expect(st?.exitCode).toBe(0);
    expect(String(st?.stdout ?? "").length).toBeGreaterThan(3);
  }, 60_000);

  it("Write-Output returns text", async () => {
    const out = await winPsTool().invoke(
      { command: "Write-Output renx-win-bash-test" },
      minimalCtx(backend),
    );
    const st = out.structured as { exitCode?: number; stdout?: string } | undefined;
    expect(st?.exitCode).toBe(0);
    expect(String(st?.stdout ?? "")).toContain("renx-win-bash-test");
  }, 60_000);

  it("internally resolved cwd lists only temp folder contents", async () => {
    const root = mkdtempSync(join(tmpdir(), "renx-bash-win-"));
    try {
      writeFileSync(join(root, "marker.txt"), "x", "utf-8");
      const tool = createBashTool({
        defaultTimeoutMs: 30_000,
        maxTimeoutMs: 60_000,
        treeSitter: { enabled: false },
        resolveCwd: () => root,
      });
      const out = await tool.invoke({ command: "Get-ChildItem -Name" }, minimalCtx(backend));
      const st = out.structured as { exitCode?: number; stdout?: string } | undefined;
      expect(st?.exitCode).toBe(0);
      expect(String(st?.stdout ?? "")).toContain("marker.txt");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("echo hello with default tree-sitter (valid bash) still runs under PowerShell", async () => {
    const tool = createBashTool({
      defaultTimeoutMs: 30_000,
      maxTimeoutMs: 60_000,
    });
    const out = await tool.invoke({ command: "echo hello" }, minimalCtx(backend));
    const st = out.structured as { exitCode?: number; stdout?: string } | undefined;
    expect(out.metadata?.blocked).toBeUndefined();
    expect(st?.exitCode).toBe(0);
    expect(String(st?.stdout ?? "").toLowerCase()).toContain("hello");
  }, 90_000);
});

describe("compound policies", () => {
  it("blocks cd combined with git", () => {
    const v = evaluateCompoundCommandPolicies("cd sub && git status");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("CD_WITH_GIT");
  });

  it("allows plain git", () => {
    expect(evaluateCompoundCommandPolicies("git status").ok).toBe(true);
  });
});

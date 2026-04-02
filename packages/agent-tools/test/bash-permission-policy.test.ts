import { describe, expect, it } from "vitest";

import {
  BashPermissionPolicy,
  bashVerdictToPolicySignals,
} from "../src/bash/bash-permission-policy";
import type { BashPermissionVerdict } from "../src/bash/permissions";
import type { AgentRunContext, AgentTool } from "@renx/agent";
import { z } from "zod";

const bashTool: AgentTool = {
  name: "bash",
  description: "x",
  schema: z.object({ command: z.string() }),
  invoke: async () => ({ content: "" }),
};

const otherTool: AgentTool = {
  name: "read_file",
  description: "x",
  schema: z.object({ path: z.string() }),
  invoke: async () => ({ content: "" }),
};

const ctx = {} as AgentRunContext;

describe("bashVerdictToPolicySignals", () => {
  it("ok → allow invoke, no approval", () => {
    const v: BashPermissionVerdict = { ok: true };
    expect(bashVerdictToPolicySignals(v)).toEqual({
      canUseTool: true,
      needApproval: false,
    });
  });

  it("deny → block invoke", () => {
    const v: BashPermissionVerdict = {
      ok: false,
      effect: "deny",
      code: "RULE_DENY",
      message: "m",
    };
    expect(bashVerdictToPolicySignals(v)).toEqual({
      canUseTool: false,
      needApproval: false,
    });
  });

  it("ask → allow invoke but require approval first", () => {
    const v: BashPermissionVerdict = {
      ok: false,
      effect: "ask",
      code: "RULE_ASK",
      message: "m",
    };
    expect(bashVerdictToPolicySignals(v)).toEqual({
      canUseTool: true,
      needApproval: true,
    });
  });
});

describe("BashPermissionPolicy", () => {
  it("passes through non-bash tools", () => {
    const policy = new BashPermissionPolicy({
      rules: {
        rules: [{ effect: "deny", mode: "prefix", value: "curl " }],
      },
    });
    expect(policy.canUseTool(ctx, otherTool, { path: "/x" })).toBe(true);
    expect(policy.needApproval?.(ctx, otherTool, { path: "/x" })).toBe(false);
  });

  it("needApproval true when rule is ask and command matches", () => {
    const policy = new BashPermissionPolicy({
      rules: {
        rules: [{ effect: "ask", mode: "prefix", value: "curl " }],
      },
    });
    expect(policy.canUseTool(ctx, bashTool, { command: "curl https://x" })).toBe(true);
    expect(policy.needApproval?.(ctx, bashTool, { command: "curl https://x" })).toBe(true);
  });

  it("canUseTool false when rule is deny", () => {
    const policy = new BashPermissionPolicy({
      rules: {
        rules: [{ effect: "deny", mode: "prefix", value: "rm " }],
      },
    });
    expect(policy.canUseTool(ctx, bashTool, { command: "rm -rf /" })).toBe(false);
  });

  it("allows ls when only curl is denied", () => {
    const policy = new BashPermissionPolicy({
      rules: {
        rules: [{ effect: "deny", mode: "prefix", value: "curl " }],
      },
    });
    expect(policy.canUseTool(ctx, bashTool, { command: "ls -la" })).toBe(true);
    expect(policy.needApproval?.(ctx, bashTool, { command: "ls -la" })).toBe(false);
  });

  it("respects custom bash tool names", () => {
    const policy = new BashPermissionPolicy({
      bashToolNames: ["shell", "bash"],
      rules: {
        rules: [{ effect: "ask", mode: "prefix", value: "scp " }],
      },
    });
    const shellTool: AgentTool = { ...bashTool, name: "shell" };
    expect(policy.needApproval?.(ctx, shellTool, { command: "scp a b" })).toBe(true);
    expect(policy.needApproval?.(ctx, bashTool, { command: "scp a b" })).toBe(true);
  });

  it("filterTools returns tools unchanged", () => {
    const policy = new BashPermissionPolicy({
      rules: { rules: [{ effect: "deny", mode: "prefix", value: "x" }] },
    });
    const tools = [bashTool, otherTool];
    expect(policy.filterTools(ctx, tools)).toEqual(tools);
  });
});

describe("BashPermissionPolicy edge cases", () => {
  it("denies bash when input has no usable command string", () => {
    const policy = new BashPermissionPolicy({
      rules: {
        rules: [{ effect: "ask", mode: "prefix", value: "curl " }],
      },
    });
    expect(policy.canUseTool(ctx, bashTool, {})).toBe(false);
    expect(policy.canUseTool(ctx, bashTool, { command: "" })).toBe(false);
    expect(policy.canUseTool(ctx, bashTool, { command: "   " })).toBe(false);
  });

  it("lockdown deny maps to canUseTool false", () => {
    const policy = new BashPermissionPolicy({
      rules: {
        rules: [{ effect: "allow", mode: "prefix", value: "ls " }],
        requireAllowMatchWhenPresent: true,
      },
    });
    expect(policy.canUseTool(ctx, bashTool, { command: "whoami" })).toBe(false);
    expect(policy.needApproval?.(ctx, bashTool, { command: "whoami" })).toBe(false);
  });

  it("empty rules list allows any bash command", () => {
    const policy = new BashPermissionPolicy({ rules: { rules: [] } });
    expect(policy.canUseTool(ctx, bashTool, { command: "anything" })).toBe(true);
    expect(policy.needApproval?.(ctx, bashTool, { command: "anything" })).toBe(false);
  });

  it("deny beats ask when both could match", () => {
    const policy = new BashPermissionPolicy({
      rules: {
        rules: [
          { effect: "deny", mode: "prefix", value: "curl " },
          { effect: "ask", mode: "prefix", value: "curl " },
        ],
      },
    });
    expect(policy.canUseTool(ctx, bashTool, { command: "curl https://evil" })).toBe(false);
    expect(policy.needApproval?.(ctx, bashTool, { command: "curl https://evil" })).toBe(false);
  });

  it("rejects non-object input for bash tool", () => {
    const policy = new BashPermissionPolicy({
      rules: {
        rules: [{ effect: "allow", mode: "prefix", value: "ls " }],
        requireAllowMatchWhenPresent: true,
      },
    });
    expect(policy.canUseTool(ctx, bashTool, null)).toBe(false);
    expect(policy.canUseTool(ctx, bashTool, "string")).toBe(false);
  });
});

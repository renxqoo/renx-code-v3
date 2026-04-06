import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { AgentRunContext } from "../../src";
import {
  createFileSkillRegistry,
  createSkillsSubsystem,
  DefaultSkillsService,
  getSkillsRuntimeState,
} from "../../src";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const createRunContext = (): AgentRunContext => ({
  input: { messages: [] },
  identity: { userId: "u1", tenantId: "t1", roles: [] },
  state: {
    runId: "run_1",
    messages: [],
    scratchpad: {},
    memory: {},
    stepCount: 0,
    status: "running",
  },
  services: {},
  metadata: {},
});

describe("skills subsystem", () => {
  it("loads nested SKILL.md files with frontmatter and resolves aliases deterministically", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-skills-registry-"));
    tempDirs.push(root);
    await mkdir(join(root, "commit"), { recursive: true });
    await mkdir(join(root, "docs", "review"), { recursive: true });

    await writeFile(
      join(root, "commit", "SKILL.md"),
      `---
description: Create a clean git commit
aliases:
  - git-commit
tags: [git, review]
user-invocable: true
context: inline
allowed-tools: [Read, Edit, Bash]
---
Inspect the diff, write a minimal commit message, and commit the staged changes.
Arguments: $ARGUMENTS
`,
      "utf8",
    );
    await writeFile(
      join(root, "docs", "review", "SKILL.md"),
      `---
description: Review documentation changes
aliases: docs-review
context: fork
model: gpt-5.4-mini
---
Review the documentation updates carefully.
`,
      "utf8",
    );

    const registry = createFileSkillRegistry({
      sources: [root],
    });

    expect(registry.list().map((skill) => skill.name)).toEqual(["commit", "docs:review"]);
    expect(registry.resolve("/commit")).toMatchObject({
      name: "commit",
      description: "Create a clean git commit",
      aliases: ["git-commit"],
      userInvocable: true,
      executionMode: "inline",
      tools: ["Read", "Edit", "Bash"],
    });
    expect(registry.resolve("docs-review")).toMatchObject({
      name: "docs:review",
      executionMode: "fork",
      model: "gpt-5.4-mini",
    });
  });

  it("discovers relevant skills, injects skill reminders, and preserves invoked skill state", () => {
    const subsystem = createSkillsSubsystem({
      skills: [
        {
          name: "commit",
          description: "Create a clean git commit from current changes",
          prompt: "Commit the current work. Args: $ARGUMENTS",
          path: ".skills/commit/SKILL.md",
          source: "project",
          tags: ["git"],
          aliases: ["git-commit"],
          keywords: ["commit", "git", "staged"],
          userInvocable: true,
          executionMode: "inline",
        },
        {
          name: "review-pr",
          description: "Review the current pull request",
          prompt: "Review the PR end to end.",
          path: ".skills/review-pr/SKILL.md",
          source: "project",
          tags: ["review"],
          aliases: [],
          keywords: ["review", "pull request", "pr"],
          userInvocable: true,
          executionMode: "fork",
        },
      ],
    });
    const service = new DefaultSkillsService(subsystem);
    const ctx = createRunContext();
    ctx.state.messages.push({
      id: "msg_user_1",
      messageId: "msg_user_1",
      role: "user",
      content: "Please commit the staged changes with a clean message.",
      createdAt: new Date().toISOString(),
      source: "input",
    });

    const reminders = service.buildPromptMessages(ctx, ctx.state.messages);
    expect(reminders).toHaveLength(1);
    expect(reminders[0]?.content).toContain("Relevant skills");
    expect(reminders[0]?.content).toContain("commit");
    expect(reminders[0]?.content).toContain("Available skills");

    const invokedPatch = service.createInvocationStatePatch(ctx, {
      skillName: "commit",
      skillPath: ".skills/commit/SKILL.md",
      executionMode: "inline",
      invokedAt: "2026-04-06T00:00:00.000Z",
      args: "feat: skills runtime",
    });
    expect(invokedPatch.setScratchpad).toBeDefined();
    ctx.state.scratchpad = {
      ...ctx.state.scratchpad,
      ...(invokedPatch.setScratchpad ?? {}),
    };

    const runtimeState = getSkillsRuntimeState(ctx.state.scratchpad);
    expect(runtimeState.invoked).toHaveLength(1);
    expect(runtimeState.invoked[0]).toMatchObject({
      skillName: "commit",
      args: "feat: skills runtime",
    });

    const remindersAfterInvoke = service.buildPromptMessages(ctx, ctx.state.messages);
    expect(remindersAfterInvoke[0]?.content).toContain("Previously invoked skills");
    expect(remindersAfterInvoke[0]?.content).toContain("feat: skills runtime");
  });

  it("expands inline skills into appended framework messages with argument substitution", async () => {
    const subsystem = createSkillsSubsystem({
      skills: [
        {
          name: "commit",
          description: "Commit changes cleanly",
          prompt: "Inspect the diff and commit it.\nArguments: $ARGUMENTS\nFallback: {{args}}",
          path: ".skills/commit/SKILL.md",
          source: "project",
          tags: [],
          aliases: [],
          keywords: ["commit"],
          userInvocable: true,
          executionMode: "inline",
        },
      ],
    });
    const service = new DefaultSkillsService(subsystem);
    const ctx = createRunContext();

    const result = await service.invoke(
      {
        skill: "commit",
        args: "feat: complete skill runtime",
      },
      {
        runContext: ctx,
      },
    );

    expect(result.statePatch?.appendMessages).toHaveLength(1);
    expect(result.statePatch?.appendMessages?.[0]?.content).toContain(
      "feat: complete skill runtime",
    );
    expect(result.statePatch?.appendMessages?.[0]?.content).toContain("[Skill: commit]");
    expect(result.structured).toMatchObject({
      skillName: "commit",
      executionMode: "inline",
    });
  });
});

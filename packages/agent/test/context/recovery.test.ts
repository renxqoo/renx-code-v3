import { describe, expect, it } from "vitest";

import { recoverFromContextError } from "../../src/context/recovery";
import { initialContextRuntimeState } from "../../src/context";
import type { RunMessage } from "../../src/message/types";

const makeMessage = (idx: number, roundIndex: number): RunMessage => ({
  id: `m_${idx}`,
  messageId: `msg_${idx}`,
  role: idx % 2 === 0 ? "user" : "assistant",
  content: `${"x".repeat(180)}-${idx}`,
  createdAt: new Date(1_700_000_000_000 + idx).toISOString(),
  source: "input",
  roundIndex,
});

describe("recoverFromContextError", () => {
  it("applies round-group fallback trimming when auto-compact cannot run", () => {
    const canonical = Array.from({ length: 5 }, (_, idx) => makeMessage(idx, idx));
    const recovered = recoverFromContextError({
      canonicalMessages: canonical,
      state: initialContextRuntimeState(),
      reason: "prompt_too_long",
    });

    expect(recovered.recovered).toBe(true);
    expect(recovered.canonicalMessages.length).toBeLessThan(canonical.length);
  });
});

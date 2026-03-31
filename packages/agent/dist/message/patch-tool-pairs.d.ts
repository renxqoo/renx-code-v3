import type { AgentMessage } from "@renx/model";
import type { PatchToolPairsResult } from "./types";
/**
 * Patches assistant tool-call / tool-result pair gaps.
 *
 * Scans for assistant messages with `toolCalls` and checks whether each
 * `ToolCall.id` has a corresponding `tool`-role message with matching
 * `toolCallId`.  For any missing pair, inserts a synthetic tool result
 * message with `metadata: { synthetic: true, patchReason: "missing_tool_result" }`.
 */
export declare const patchToolPairs: (messages: AgentMessage[]) => PatchToolPairsResult;
//# sourceMappingURL=patch-tool-pairs.d.ts.map
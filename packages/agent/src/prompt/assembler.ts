export type PromptLayerPhase =
  | "persona"
  | "instructions"
  | "rules"
  | "memory"
  | "context"
  | "post_compact";

export interface PromptLayer {
  id: string;
  phase: PromptLayerPhase;
  priority: number;
  content: string;
}

export interface PromptAssemblyResult {
  systemPrompt: string;
  selectedLayerIds: string[];
  droppedLayerIds: string[];
  contract: {
    postCompact?: {
      summary: string;
      preservedRequirements: string[];
    };
  };
}

const estimateTokens = (value: string): number => Math.max(1, Math.ceil(value.length / 4));

export class PromptAssembler {
  assemble(input: {
    baseSystemPrompt: string;
    budgetTokens: number;
    layers: PromptLayer[];
    postCompact?: {
      summary: string;
      preservedRequirements: string[];
    };
  }): PromptAssemblyResult {
    const sorted = [...input.layers].sort((left, right) => {
      if (right.priority !== left.priority) return right.priority - left.priority;
      return left.id.localeCompare(right.id);
    });
    const selected: PromptLayer[] = [];
    const dropped: string[] = [];
    let usedTokens = estimateTokens(input.baseSystemPrompt);

    for (const layer of sorted) {
      const tokens = estimateTokens(layer.content);
      if (usedTokens + tokens > input.budgetTokens) {
        dropped.push(layer.id);
        continue;
      }
      selected.push(layer);
      usedTokens += tokens;
    }

    return {
      systemPrompt: [input.baseSystemPrompt, ...selected.map((layer) => layer.content)].join(
        "\n\n",
      ),
      selectedLayerIds: selected.map((layer) => layer.id),
      droppedLayerIds: dropped,
      contract: input.postCompact ? { postCompact: input.postCompact } : {},
    };
  }
}

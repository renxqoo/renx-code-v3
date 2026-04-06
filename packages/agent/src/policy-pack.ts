import type { MemoryPolicy } from "./memory";

export interface PolicyPack {
  name: string;
  memory?: Partial<MemoryPolicy>;
  prompt?: {
    reservedTokens?: number;
  };
  approval?: Record<string, unknown>;
}

export class PolicyPackRegistry {
  private readonly packs = new Map<string, PolicyPack>();

  register(pack: PolicyPack): void {
    this.packs.set(pack.name, pack);
  }

  resolve(names: string[]): PolicyPack {
    return names.reduce<PolicyPack>(
      (acc, name) => {
        const pack = this.packs.get(name);
        if (!pack) return acc;
        return {
          name: acc.name ? `${acc.name}+${pack.name}` : pack.name,
          memory: {
            ...(acc.memory ?? {}),
            ...(pack.memory ?? {}),
          },
          prompt: {
            ...(acc.prompt ?? {}),
            ...(pack.prompt ?? {}),
          },
          approval: {
            ...(acc.approval ?? {}),
            ...(pack.approval ?? {}),
          },
        };
      },
      { name: "" },
    );
  }
}

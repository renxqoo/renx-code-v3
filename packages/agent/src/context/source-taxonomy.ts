export interface ContextSourceDescriptor {
  id: string;
  kind: "memory" | "tool" | "user" | "failure" | "plan" | "artifact";
  source: string;
}

export interface ClassifiedContextSource extends ContextSourceDescriptor {
  priority: number;
  retentionClass: "ephemeral" | "compact_safe" | "durable";
}

export class ContextSourceTaxonomy {
  classify(descriptor: ContextSourceDescriptor): ClassifiedContextSource {
    if (descriptor.kind === "memory" || descriptor.source === "rehydration") {
      return {
        ...descriptor,
        priority: 90,
        retentionClass: "compact_safe",
      };
    }
    if (descriptor.kind === "failure") {
      return {
        ...descriptor,
        priority: 95,
        retentionClass: "durable",
      };
    }
    return {
      ...descriptor,
      priority: 50,
      retentionClass: "ephemeral",
    };
  }
}

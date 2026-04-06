import type { SandboxPlatform, SandboxPlatformRegistry } from "../types";

export class StaticSandboxPlatformRegistry implements SandboxPlatformRegistry {
  private readonly platforms = new Map<string, SandboxPlatform>();

  register(platform: SandboxPlatform): void {
    this.platforms.set(platform.kind, platform);
  }

  get(kind: string): SandboxPlatform | undefined {
    return this.platforms.get(kind);
  }

  list(): SandboxPlatform[] {
    return [...this.platforms.values()];
  }
}

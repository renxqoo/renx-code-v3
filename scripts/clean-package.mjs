import { rmSync } from "node:fs";

const targets = ["dist", "tsconfig.tsbuildinfo"];

for (const target of targets) {
  rmSync(target, { recursive: true, force: true });
}

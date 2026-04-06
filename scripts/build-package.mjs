import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const cwd = process.cwd();
const extraArgs = process.argv.slice(2);
const srcDir = path.join(cwd, "src");
const entries = [];

const rootEntry = path.join(srcDir, "index.ts");
if (existsSync(rootEntry)) {
  entries.push("src/index.ts");
}

if (existsSync(srcDir)) {
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const nestedIndex = path.join(srcDir, entry.name, "index.ts");
    if (existsSync(nestedIndex)) {
      entries.push(`src/${entry.name}/index.ts`);
    }
  }
}

if (entries.length === 0) {
  console.error(`No build entry found in ${cwd}`);
  process.exit(1);
}

const result = spawnSync(
  "pnpm",
  [
    "exec",
    "tsup",
    ...entries,
    "--format",
    "esm",
    "--sourcemap",
    "--clean",
    "--out-dir",
    "dist",
    ...extraArgs,
  ],
  {
    stdio: "inherit",
  },
);

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

rmSync(path.join(cwd, "tsconfig.tsbuildinfo"), { force: true });

const dtsResult = spawnSync(
  "pnpm",
  ["exec", "tsc", "-p", "tsconfig.json", "--emitDeclarationOnly"],
  {
    stdio: "inherit",
  },
);

if (dtsResult.status !== 0) {
  process.exit(dtsResult.status ?? 1);
}

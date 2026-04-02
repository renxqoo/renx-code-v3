/**
 * Tree-sitter bash parse for security classification (parseForSecurityFromAst analogue).
 * Requires: web-tree-sitter npm package + grammars/tree-sitter-bash.wasm (pnpm run prebuild:wasm).
 */
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { Node as TsNode } from "web-tree-sitter";

export type ParseForSecurityResult =
  | { kind: "parse-unavailable"; reason: string }
  | { kind: "too-complex"; reason: string }
  | { kind: "simple"; commands: Array<{ text: string }> };

export interface TreeSitterBashPaths {
  /** Absolute path to tree-sitter-bash.wasm */
  bashWasmPath: string;
}

const DISALLOWED_TYPES = new Set([
  "command_substitution",
  "process_substitution",
  "heredoc_redirect",
  "for_statement",
  "while_statement",
  "if_statement",
  "case_statement",
  "c_style_for_statement",
  "function_definition",
  "compound_statement",
]);

function packageRootFromModuleUrl(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const leaf = basename(here);
  if (leaf === "bash") {
    return resolve(here, "..", "..");
  }
  if (leaf === "dist") {
    return resolve(here, "..");
  }
  return resolve(here, "..");
}

function defaultBashWasmPath(): string {
  try {
    const require = createRequire(import.meta.url);
    const entry = require.resolve("tree-sitter-bash");
    return join(dirname(entry), "..", "..", "tree-sitter-bash.wasm");
  } catch {
    return join(packageRootFromModuleUrl(), "grammars", "tree-sitter-bash.wasm");
  }
}

function defaultCoreWasmPath(): string {
  const require = createRequire(import.meta.url);
  const entry = require.resolve("web-tree-sitter");
  return join(dirname(entry), "web-tree-sitter.wasm");
}

function findDisallowedType(node: TsNode): string | null {
  if (DISALLOWED_TYPES.has(node.type)) {
    return node.type;
  }
  for (const c of node.namedChildren) {
    const t = findDisallowedType(c);
    if (t) {
      return t;
    }
  }
  return null;
}

function collectCommandTexts(node: TsNode): string[] {
  const out: string[] = [];
  const walk = (n: TsNode) => {
    if (n.type === "command") {
      out.push(n.text);
    }
    for (const c of n.namedChildren) {
      walk(c);
    }
  };
  walk(node);
  return out;
}

let parserSingleton: Promise<import("web-tree-sitter").Parser | null> | null = null;

async function loadParser(bashWasmPath: string): Promise<import("web-tree-sitter").Parser | null> {
  try {
    const { Parser, Language } = await import("web-tree-sitter");
    const { readFile } = await import("node:fs/promises");
    const coreWasm = pathToFileURL(defaultCoreWasmPath()).href;
    await Parser.init({
      locateFile: (scriptName: string) => {
        if (scriptName.endsWith(".wasm")) {
          return coreWasm;
        }
        return scriptName;
      },
    });
    const wasmBin = await readFile(bashWasmPath);
    const lang = await Language.load(wasmBin);
    const parser = new Parser();
    parser.setLanguage(lang);
    return parser;
  } catch (e) {
    if (process.env.RENX_DEBUG_TREE_SITTER === "1") {
      console.error("[agent-tools] Tree-sitter init failed:", e);
    }
    return null;
  }
}

/**
 * @param command - bash snippet
 * @param paths - optional wasm path (defaults to package grammars/)
 */
export async function parseForSecurityFromAst(
  command: string,
  paths?: Partial<TreeSitterBashPaths>,
): Promise<ParseForSecurityResult> {
  const bashWasmPath = paths?.bashWasmPath ?? defaultBashWasmPath();
  parserSingleton ??= loadParser(bashWasmPath);
  const parser = await parserSingleton;
  if (!parser) {
    return {
      kind: "parse-unavailable",
      reason:
        "Tree-sitter unavailable (install web-tree-sitter, run prebuild:wasm, check grammars/).",
    };
  }

  let tree: import("web-tree-sitter").Tree | null;
  try {
    tree = parser.parse(command);
  } catch {
    return { kind: "parse-unavailable", reason: "parser.parse threw" };
  }

  if (!tree) {
    return { kind: "parse-unavailable", reason: "parser.parse returned null" };
  }

  const root = tree.rootNode;
  if (root.hasError) {
    tree.delete();
    return { kind: "too-complex", reason: "Parse tree contains errors (fail-closed)." };
  }

  const bad = findDisallowedType(root);
  if (bad) {
    tree.delete();
    return { kind: "too-complex", reason: `Construct not allowed for auto-exec: ${bad}` };
  }

  const texts = collectCommandTexts(root);
  tree.delete();
  return { kind: "simple", commands: texts.map((text) => ({ text })) };
}

/** Resolve default wasm path (for tooling / tests). */
export function resolveDefaultBashWasmPath(): string {
  return defaultBashWasmPath();
}

/** Reset cached parser (tests). */
export function resetParserForTests(): void {
  parserSingleton = null;
}

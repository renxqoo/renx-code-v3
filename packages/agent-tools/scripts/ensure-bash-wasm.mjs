/**
 * Ensures tree-sitter-bash.wasm exists for WASM parsing (offline builds can commit the file).
 */
import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { get } from "node:https";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const target = join(root, "grammars", "tree-sitter-bash.wasm");
const URL = "https://unpkg.com/tree-sitter-bash@0.25.1/tree-sitter-bash.wasm";

function download(url, dest) {
  return new Promise((resolve, reject) => {
    get(url, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        const loc = res.headers.location;
        if (!loc) {
          reject(new Error("Redirect without location"));
          return;
        }
        download(loc, dest).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`GET ${url} → ${res.statusCode}`));
        return;
      }
      const out = createWriteStream(dest);
      res.pipe(out);
      out.on("finish", resolve);
      out.on("error", reject);
    }).on("error", reject);
  });
}

if (!existsSync(target)) {
  mkdirSync(dirname(target), { recursive: true });
  console.warn(`[agent-tools] fetching tree-sitter-bash.wasm → ${target}`);
  await download(URL, target);
}

import type { FileInfo } from "@renx/agent";

import { SandboxPlatformError } from "../../errors";
import type {
  SandboxFileDownloadResult,
  SandboxFileUploadResult,
  SandboxRuntimeConnection,
  SandboxRuntimeExecuteRequest,
  SandboxRuntimeExecuteResult,
} from "../../types";
import type { BinaryCommandResult } from "./process-runner";
import { decodeBinaryCommandBytes } from "./process-runner";

const FILE_UPLOAD_SCRIPT = `
const fs = require('node:fs');
const path = require('node:path');
const target = process.argv[1];
const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.concat(chunks));
  } catch (error) {
    console.error(error && error.code ? error.code : (error instanceof Error ? error.message : String(error)));
    process.exit(1);
  }
});
process.stdin.resume();
`.trim();

const FILE_DOWNLOAD_SCRIPT = `
const fs = require('node:fs');
const target = process.argv[1];
try {
  const info = fs.statSync(target);
  if (info.isDirectory()) {
    console.error('is_directory');
    process.exit(21);
  }
  process.stdout.write(fs.readFileSync(target));
} catch (error) {
  if (error && error.code === 'ENOENT') {
    console.error('file_not_found');
    process.exit(20);
  }
  if (error && (error.code === 'EACCES' || error.code === 'EPERM')) {
    console.error('permission_denied');
    process.exit(22);
  }
  console.error(error && error.code ? error.code : (error instanceof Error ? error.message : String(error)));
  process.exit(1);
}
`.trim();

const LIST_SCRIPT = `
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const emit = (fullPath, info) => {
  if (info.isDirectory()) {
    console.log(JSON.stringify({
      path: fullPath,
      isDirectory: true,
      modifiedAt: new Date(info.mtimeMs).toISOString(),
    }));
    return;
  }
  const content = fs.readFileSync(fullPath);
  console.log(JSON.stringify({
    path: fullPath,
    isDirectory: false,
    size: info.size,
    modifiedAt: new Date(info.mtimeMs).toISOString(),
    sha256: crypto.createHash('sha256').update(content).digest('hex'),
  }));
};
try {
  const info = fs.statSync(process.argv[1]);
  if (!info.isDirectory()) {
    emit(process.argv[1], info);
  } else {
    for (const entry of fs.readdirSync(process.argv[1], { withFileTypes: true })) {
      const fullPath = path.resolve(process.argv[1], entry.name);
      emit(fullPath, fs.statSync(fullPath));
    }
  }
} catch (error) {
  if (error && error.code === 'ENOENT') {
    process.exit(0);
  }
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
`.trim();

const STAT_SCRIPT = `
const fs = require('node:fs');
const crypto = require('node:crypto');
try {
  const info = fs.statSync(process.argv[1]);
  if (info.isDirectory()) {
    console.log(JSON.stringify({
      path: process.argv[1],
      isDirectory: true,
      modifiedAt: new Date(info.mtimeMs).toISOString(),
    }));
  } else {
    const content = fs.readFileSync(process.argv[1]);
    console.log(JSON.stringify({
      path: process.argv[1],
      isDirectory: false,
      size: info.size,
      modifiedAt: new Date(info.mtimeMs).toISOString(),
      sha256: crypto.createHash('sha256').update(content).digest('hex'),
    }));
  }
} catch (error) {
  if (error && error.code === 'ENOENT') {
    process.exit(0);
  }
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
`.trim();

const DELETE_PATHS_SCRIPT = `
const fs = require('node:fs');
for (const target of JSON.parse(process.argv[1])) {
  try {
    fs.rmSync(target, { force: true, recursive: true });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
`.trim();

export interface NodeRuntimeConnectionOptions {
  id: string;
  execute(request: SandboxRuntimeExecuteRequest): Promise<SandboxRuntimeExecuteResult>;
  runNode(request: {
    script: string;
    args?: string[];
    stdin?: Uint8Array;
    timeoutMs?: number;
  }): Promise<BinaryCommandResult>;
  decode?(value: Uint8Array): string;
}

const parseJsonLines = (output: string): FileInfo[] =>
  output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as FileInfo);

const toFileDownloadError = (
  result: BinaryCommandResult,
  decode: (value: Uint8Array) => string,
): string => {
  switch (result.exitCode) {
    case 20:
      return "file_not_found";
    case 21:
      return "is_directory";
    case 22:
      return "permission_denied";
    default:
      return decode(result.stderr).trim() || "invalid_path";
  }
};

export const createNodeRuntimeConnection = (
  options: NodeRuntimeConnectionOptions,
): SandboxRuntimeConnection => {
  const decode = options.decode ?? decodeBinaryCommandBytes;

  const runNodeJson = async (script: string, args: string[]): Promise<FileInfo[]> => {
    const result = await options.runNode({ script, args });
    if (result.exitCode !== 0) {
      throw new SandboxPlatformError(
        decode(result.stderr).trim() || "Sandbox node runtime command failed",
      );
    }
    return parseJsonLines(decode(result.stdout));
  };

  return {
    id: options.id,
    execute: async (request) => await options.execute(request),
    uploadFiles: async (files): Promise<SandboxFileUploadResult[]> =>
      await Promise.all(
        files.map(async (file): Promise<SandboxFileUploadResult> => {
          const result = await options.runNode({
            script: FILE_UPLOAD_SCRIPT,
            args: [file.path],
            stdin: file.content,
          });
          return result.exitCode === 0
            ? { path: file.path }
            : {
                path: file.path,
                error: decode(result.stderr).trim() || "invalid_path",
              };
        }),
      ),
    downloadFiles: async (paths): Promise<SandboxFileDownloadResult[]> =>
      await Promise.all(
        paths.map(async (path): Promise<SandboxFileDownloadResult> => {
          const result = await options.runNode({
            script: FILE_DOWNLOAD_SCRIPT,
            args: [path],
          });
          return result.exitCode === 0
            ? {
                path,
                content: result.stdout,
              }
            : {
                path,
                error: toFileDownloadError(result, decode),
              };
        }),
      ),
    listFiles: async (path) => await runNodeJson(LIST_SCRIPT, [path]),
    statPath: async (path) => {
      const entries = await runNodeJson(STAT_SCRIPT, [path]);
      return entries[0];
    },
    deletePaths: async (paths) => {
      if (paths.length === 0) {
        return;
      }
      const result = await options.runNode({
        script: DELETE_PATHS_SCRIPT,
        args: [JSON.stringify(paths)],
      });
      if (result.exitCode !== 0) {
        throw new SandboxPlatformError(
          decode(result.stderr).trim() || "Failed to delete sandbox paths",
        );
      }
    },
    dispose: async () => {},
  };
};

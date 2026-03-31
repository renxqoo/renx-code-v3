import type { BackendCapabilities, ExecOptions, ExecResult, ExecutionBackend, FileInfo } from "./types";
/**
 * Local execution backend — runs commands and accesses filesystem
 * directly on the host machine.
 */
export declare class LocalBackend implements ExecutionBackend {
    readonly kind = "local";
    capabilities(): BackendCapabilities;
    exec(command: string, opts?: ExecOptions): Promise<ExecResult>;
    readFile(path: string): Promise<string>;
    writeFile(path: string, content: string): Promise<void>;
    listFiles(path: string): Promise<FileInfo[]>;
}
//# sourceMappingURL=local-backend.d.ts.map
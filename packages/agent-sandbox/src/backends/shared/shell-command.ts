import { createSandboxId } from "../../path-utils";

export interface PosixShellContext {
  cwd?: string;
  env?: Record<string, string>;
}

export interface PosixShellInvocationOptions extends PosixShellContext {
  stdin?: string;
  shell?: string;
  createMarker?: () => string;
}

export const quoteForPosixShell = (value: string): string => `'${value.replace(/'/g, `'\"'\"'`)}'`;

const buildPosixShellPrefixes = (request: PosixShellContext): string[] => [
  ...(request.cwd ? [`cd ${quoteForPosixShell(request.cwd)}`] : []),
  ...Object.entries(request.env ?? {}).map(
    ([key, value]) => `export ${key}=${quoteForPosixShell(value)}`,
  ),
];

export const buildPosixShellCommand = (
  command: string,
  request: PosixShellContext = {},
): string => {
  const prefixes = buildPosixShellPrefixes(request);
  return prefixes.length === 0 ? command : `${prefixes.join(" && ")} && ${command}`;
};

export const buildPosixShellInvocation = (
  command: string,
  request: PosixShellInvocationOptions = {},
): string => {
  const scriptLines = buildPosixShellPrefixes(request);

  if (request.stdin !== undefined) {
    const marker =
      request.createMarker?.() ??
      `__RENX_STDIN_${createSandboxId("shell").replace(/[^A-Za-z0-9_]/g, "_")}__`;
    scriptLines.push(`cat <<'${marker}' | (${command})`);
    scriptLines.push(request.stdin);
    scriptLines.push(marker);
  } else {
    scriptLines.push(command);
  }

  return `${request.shell ?? "sh"} -lc ${quoteForPosixShell(scriptLines.join("\n"))}`;
};

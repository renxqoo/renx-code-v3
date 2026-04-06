const WINDOWS_DRIVE_PREFIX = /^[A-Za-z]:\//;

const trimTrailingSlash = (value: string): string => {
  if (value === "/") return value;
  if (WINDOWS_DRIVE_PREFIX.test(value) && value.length === 3) {
    return value;
  }
  return value.endsWith("/") ? value.slice(0, -1) : value;
};

export const normalizeComparablePath = (value: string): string => {
  const normalized = value.replaceAll("\\", "/").replace(/\/+/g, "/");
  if (WINDOWS_DRIVE_PREFIX.test(normalized)) {
    const drive = normalized.slice(0, 2).toLowerCase();
    return `${drive}${trimTrailingSlash(normalized.slice(2))}`;
  }
  return trimTrailingSlash(normalized);
};

export const isAbsoluteComparablePath = (value: string): boolean => {
  const normalized = value.replaceAll("\\", "/");
  return normalized.startsWith("/") || WINDOWS_DRIVE_PREFIX.test(normalized);
};

export const joinComparablePath = (base: string, next: string): string => {
  if (isAbsoluteComparablePath(next)) {
    return normalizeComparablePath(next);
  }
  return normalizeComparablePath(`${normalizeComparablePath(base)}/${next}`);
};

export const parentComparablePath = (value: string): string => {
  const normalized = normalizeComparablePath(value);
  if (normalized === "/") return normalized;
  if (WINDOWS_DRIVE_PREFIX.test(normalized) && normalized.length === 3) {
    return normalized;
  }
  const parts = normalized.split("/");
  parts.pop();
  if (parts.length === 1 && parts[0]?.endsWith(":")) {
    return `${parts[0]}/`;
  }
  return parts.length === 0 ? "/" : parts.join("/");
};

export const isPathWithin = (root: string, target: string): boolean => {
  const normalizedRoot = normalizeComparablePath(root);
  const normalizedTarget = normalizeComparablePath(target);
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}/`);
};

export const stripWrappingQuotes = (value: string): string => {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value;
};

export const createSandboxId = (prefix: string): string =>
  `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

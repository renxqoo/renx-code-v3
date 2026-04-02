/** Detect image magic at start of stdout (binary-safe via Latin-1 roundtrip). */

export type DetectedImage = { mime: string; ext: string; byteLength: number };

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const GIF = [0x47, 0x49, 0x46, 0x38];
const JPEG = [0xff, 0xd8, 0xff];

function matchPrefix(buf: Uint8Array, prefix: number[]): boolean {
  if (buf.length < prefix.length) {
    return false;
  }
  for (let i = 0; i < prefix.length; i++) {
    if (buf[i] !== prefix[i]) {
      return false;
    }
  }
  return true;
}

function isWebp(buf: Uint8Array): boolean {
  if (buf.length < 12) {
    return false;
  }
  if (buf[0] !== 0x52 || buf[1] !== 0x49 || buf[2] !== 0x46 || buf[3] !== 0x46) {
    return false;
  }
  return buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50;
}

/**
 * Inspect leading bytes for a raster image. `stdout` from exec is treated as Latin-1 bytes.
 */
export function detectImageFromStdout(stdout: string): DetectedImage | null {
  const buf = Buffer.from(stdout, "latin1");
  if (buf.length < 8) {
    return null;
  }
  if (matchPrefix(buf, PNG)) {
    return { mime: "image/png", ext: "png", byteLength: buf.length };
  }
  if (matchPrefix(buf, GIF)) {
    return { mime: "image/gif", ext: "gif", byteLength: buf.length };
  }
  if (matchPrefix(buf, JPEG)) {
    return { mime: "image/jpeg", ext: "jpg", byteLength: buf.length };
  }
  if (isWebp(buf)) {
    return { mime: "image/webp", ext: "webp", byteLength: buf.length };
  }
  return null;
}

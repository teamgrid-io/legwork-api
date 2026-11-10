import { createHash } from "node:crypto";
import { HttpError } from "../../lib/errors.js";

const MAX_SIZE_BYTES = 5 * 1024 * 1024;

const JPEG_SIGNATURE = [0xff, 0xd8, 0xff] as const;
const PNG_SIGNATURE = [
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
] as const;
const PDF_SIGNATURE = [0x25, 0x50, 0x44, 0x46] as const;

function startsWith(buffer: Buffer, signature: readonly number[]): boolean {
  if (buffer.length < signature.length) {
    return false;
  }

  return signature.every((byte, index) => buffer[index] === byte);
}

function detectMimeType(buffer: Buffer): string | null {
  if (startsWith(buffer, JPEG_SIGNATURE)) {
    return "image/jpeg";
  }

  if (startsWith(buffer, PNG_SIGNATURE)) {
    return "image/png";
  }

  if (startsWith(buffer, PDF_SIGNATURE)) {
    return "application/pdf";
  }

  return null;
}

export function checkFile(
  buffer: Buffer,
  declaredMime: string,
  size: number,
): { mimeType: string; sha256: string } {
  if (size <= 0 || size > MAX_SIZE_BYTES) {
    throw new HttpError(400, "Invalid file size");
  }

  const mimeType = detectMimeType(buffer);

  if (!mimeType || mimeType !== declaredMime) {
    throw new HttpError(400, "File type not allowed");
  }

  const sha256 = createHash("sha256").update(buffer).digest("hex");

  return { mimeType, sha256 };
}

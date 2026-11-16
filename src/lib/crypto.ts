import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { config } from "../config.js";

const VERSION_PREFIX = "v1:";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

export function encryptField(plain: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(
    "aes-256-gcm",
    config.fieldEncryptionKey,
    iv,
  );

  const ciphertext = Buffer.concat([
    cipher.update(plain, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  const payload = Buffer.concat([iv, authTag, ciphertext]);

  return `${VERSION_PREFIX}${payload.toString("base64")}`;
}

export function decryptField(stored: string): string {
  if (!stored.startsWith(VERSION_PREFIX)) {
    throw new Error("Unsupported encrypted field format");
  }

  const payload = Buffer.from(stored.slice(VERSION_PREFIX.length), "base64");

  if (payload.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error("Encrypted field is too short");
  }

  const iv = payload.subarray(0, IV_LENGTH);
  const authTag = payload.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = payload.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(
    "aes-256-gcm",
    config.fieldEncryptionKey,
    iv,
  );
  decipher.setAuthTag(authTag);

  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
}

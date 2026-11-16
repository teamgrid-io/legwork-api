import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../../config.js";

const TOKEN_CONTEXT = "applicant:";

export function accessToken(applicantId: string): string {
  return createHmac("sha256", config.fieldEncryptionKey)
    .update(`${TOKEN_CONTEXT}${applicantId}`)
    .digest("base64url");
}

export function verifyAccessToken(
  applicantId: string,
  token: string,
): boolean {
  const expected = Buffer.from(accessToken(applicantId), "utf8");
  const provided = Buffer.from(token, "utf8");

  if (expected.length !== provided.length) {
    return false;
  }

  return timingSafeEqual(expected, provided);
}

export function issueTestToken(applicantId: string): string {
  return accessToken(applicantId);
}

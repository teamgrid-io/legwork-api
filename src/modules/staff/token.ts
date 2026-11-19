import { SignJWT, jwtVerify } from "jose";
import { staffConfig } from "./config.js";

const ALGORITHM = "HS256";
const ISSUER = "legwork-api";
const AUDIENCE = "legwork-staff";
const TOKEN_TTL_SECONDS = 8 * 60 * 60;

// A token is verified with exactly one algorithm, so an attacker cannot swap the
// header to "none" or to an asymmetric algorithm.
const VERIFY_ALGORITHMS = [ALGORITHM];

function signingKey(): Uint8Array {
  return new TextEncoder().encode(staffConfig.jwtSecret);
}

/**
 * Sign a staff token. Claims: sub (staff id), iat, exp (8 hours), iss, aud.
 * The role is deliberately not in the token: it is read from the database on
 * every request, so a role change or deactivation takes effect immediately.
 */
export async function signStaffToken(staffId: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: ALGORITHM })
    .setSubject(staffId)
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime(`${TOKEN_TTL_SECONDS}s`)
    .sign(signingKey());
}

/**
 * Verify a staff token and return its subject id. Throws for a bad signature,
 * an expired token, or the wrong issuer/audience.
 */
export async function verifyStaffToken(token: string): Promise<string> {
  const { payload } = await jwtVerify(token, signingKey(), {
    algorithms: VERIFY_ALGORITHMS,
    issuer: ISSUER,
    audience: AUDIENCE,
  });

  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    throw new Error("Staff token has no subject");
  }

  return payload.sub;
}

export { TOKEN_TTL_SECONDS };

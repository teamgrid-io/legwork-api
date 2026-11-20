import { SignJWT, jwtVerify } from "jose";
import { config } from "../../config.js";

const ALGORITHM = "HS256";
const ISSUER = "legwork-api";
const AUDIENCE = "legwork-customer";
const TOKEN_TTL_SECONDS = 12 * 60 * 60;

// Pinned on verify: an attacker cannot swap the header to "none" or to an
// asymmetric algorithm. The audience also keeps staff tokens out.
const VERIFY_ALGORITHMS = [ALGORITHM];

function signingKey(): Uint8Array {
  return new TextEncoder().encode(config.customerJwtSecret);
}

/**
 * Sign a customer token. Claims: sub (customer id), iat, exp (12 hours), iss,
 * aud. No role or activation claim lives in the token; the row is read on every
 * request, so deactivation takes effect immediately.
 */
export async function signCustomerToken(customerId: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: ALGORITHM })
    .setSubject(customerId)
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime(`${TOKEN_TTL_SECONDS}s`)
    .sign(signingKey());
}

/**
 * Verify a customer token and return its subject id. Throws for a bad
 * signature, an expired token, or the wrong issuer/audience.
 */
export async function verifyCustomerToken(token: string): Promise<string> {
  const { payload } = await jwtVerify(token, signingKey(), {
    algorithms: VERIFY_ALGORITHMS,
    issuer: ISSUER,
    audience: AUDIENCE,
  });

  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    throw new Error("Customer token has no subject");
  }

  return payload.sub;
}

export { TOKEN_TTL_SECONDS as CUSTOMER_TOKEN_TTL_SECONDS };

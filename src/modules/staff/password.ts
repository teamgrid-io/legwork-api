import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";

// scrypt parameters. N = 2^14 keeps a single hash around 16 MB of memory and a
// few tens of milliseconds, which is the usual floor for interactive logins.
const PARAM_N = 16384;
const PARAM_R = 8;
const PARAM_P = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
const MAX_MEMORY = 64 * 1024 * 1024;

const PREFIX = "scrypt";

interface ParsedHash {
  readonly n: number;
  readonly r: number;
  readonly p: number;
  readonly salt: Buffer;
  readonly hash: Buffer;
}

function derive(
  plain: string,
  salt: Buffer,
  keyLength: number,
  n: number,
  r: number,
  p: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(
      plain,
      salt,
      keyLength,
      { N: n, r, p, maxmem: MAX_MEMORY },
      (error, derivedKey) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(derivedKey);
      },
    );
  });
}

function isPowerOfTwo(value: number): boolean {
  return value > 1 && (value & (value - 1)) === 0;
}

function parseStored(stored: string): ParsedHash | null {
  const parts = stored.split("$");

  if (parts.length !== 6) {
    return null;
  }

  const [prefix, rawN, rawR, rawP, rawSalt, rawHash] = parts;

  if (prefix !== PREFIX || !rawN || !rawR || !rawP || !rawSalt || !rawHash) {
    return null;
  }

  const n = Number(rawN);
  const r = Number(rawR);
  const p = Number(rawP);

  // Bounds checked so a tampered hash cannot turn a login into a CPU or memory
  // denial of service.
  if (!Number.isInteger(n) || !isPowerOfTwo(n) || n > 1_048_576) {
    return null;
  }

  if (!Number.isInteger(r) || r < 1 || r > 32) {
    return null;
  }

  if (!Number.isInteger(p) || p < 1 || p > 16) {
    return null;
  }

  let salt: Buffer;
  let hash: Buffer;

  try {
    salt = Buffer.from(rawSalt, "base64url");
    hash = Buffer.from(rawHash, "base64url");
  } catch {
    return null;
  }

  if (salt.length < 8 || salt.length > 64) {
    return null;
  }

  if (hash.length < 16 || hash.length > 128) {
    return null;
  }

  return { n, r, p, salt, hash };
}

/**
 * Hash a plaintext password as `scrypt$N$r$p$salt$hash`, with the salt and hash
 * encoded as base64url.
 */
export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const hash = await derive(plain, salt, KEY_LENGTH, PARAM_N, PARAM_R, PARAM_P);

  return [
    PREFIX,
    PARAM_N,
    PARAM_R,
    PARAM_P,
    salt.toString("base64url"),
    hash.toString("base64url"),
  ].join("$");
}

/**
 * Constant-time verification against a stored hash. Malformed input returns
 * `false` rather than throwing, so a corrupted row reads as a wrong password.
 */
export async function verifyPassword(
  plain: string,
  stored: string,
): Promise<boolean> {
  const parsed = parseStored(stored);

  if (!parsed) {
    return false;
  }

  const derived = await derive(
    plain,
    parsed.salt,
    parsed.hash.length,
    parsed.n,
    parsed.r,
    parsed.p,
  );

  if (derived.length !== parsed.hash.length) {
    return false;
  }

  return timingSafeEqual(derived, parsed.hash);
}

const DUMMY_SALT = Buffer.alloc(SALT_LENGTH, 0);

/**
 * Same work as a real verification, discarded. Run for unknown or inactive
 * accounts so response timing does not reveal whether the email exists.
 */
export async function dummyVerify(plain: string): Promise<void> {
  await derive(plain, DUMMY_SALT, KEY_LENGTH, PARAM_N, PARAM_R, PARAM_P);
}

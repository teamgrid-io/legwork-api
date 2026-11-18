import { config as loadEnv } from "dotenv";

// Loaded here as well as in src/config.ts: this module may be imported by the
// seed script or by tests without the app's config module being evaluated
// first. `override: false` keeps a real environment value authoritative.
loadEnv({ quiet: true, override: false });

const MIN_SECRET_LENGTH = 32;

function loadJwtSecret(): string {
  const secret = process.env.JWT_SECRET;

  if (!secret || secret.trim().length < MIN_SECRET_LENGTH) {
    // Names the variable, never the value.
    console.error(
      `Invalid environment configuration: JWT_SECRET must be at least ${MIN_SECRET_LENGTH} characters`,
    );
    process.exit(1);
  }

  return secret;
}

export interface StaffConfig {
  readonly jwtSecret: string;
}

/**
 * Staff-module configuration. Evaluated at import time, so a missing or short
 * JWT_SECRET stops the process during startup, before any route is mounted.
 */
export const staffConfig: StaffConfig = Object.freeze({
  jwtSecret: loadJwtSecret(),
});

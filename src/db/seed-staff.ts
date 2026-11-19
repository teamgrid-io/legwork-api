/**
 * Seed the first staff account.
 *
 *   npm run db:seed:staff
 *   npm run db:seed:staff -- --update-password
 *
 * Reads ADMIN_EMAIL, ADMIN_PASSWORD (min 12 characters) and optional ADMIN_NAME
 * (default "Admin"). Prints the email plus created / unchanged / updated, never
 * a password or a URL.
 *
 * The environment and database-name guards run before any src module is
 * imported, so a misconfigured target cannot even open a connection.
 */

const MIN_PASSWORD_LENGTH = 12;
const DEFAULT_NAME = "Admin";

function refuse(reason: string): never {
  console.error(`Refusing to seed staff: ${reason}`);
  process.exit(1);
}

function parseDatabaseName(raw: string | undefined): string {
  if (!raw) {
    refuse("DATABASE_URL is not set");
  }

  let parsed: URL;

  try {
    parsed = new URL(raw);
  } catch {
    refuse("DATABASE_URL is not a valid URL");
  }

  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    refuse("DATABASE_URL must use the postgres or postgresql scheme");
  }

  return decodeURIComponent(parsed.pathname.replace(/^\//, ""));
}

const databaseName = parseDatabaseName(process.env.DATABASE_URL);

// Production is called "legwork". Seeding there needs an explicit opt-in.
if (
  databaseName === "legwork" &&
  process.env.ALLOW_SEED_ON_LEGWORK !== "true"
) {
  refuse("refusing to seed the legwork database without ALLOW_SEED_ON_LEGWORK=true");
}

const adminEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase();
const adminPassword = process.env.ADMIN_PASSWORD;
const adminName = process.env.ADMIN_NAME?.trim() || DEFAULT_NAME;

if (!adminEmail) {
  refuse("ADMIN_EMAIL is not set");
}

if (!adminPassword || adminPassword.length < MIN_PASSWORD_LENGTH) {
  refuse(`ADMIN_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters`);
}

const updatePasswordOnly = process.argv.includes("--update-password");

const { hashPassword } = await import("../modules/staff/password.js");
const { db } = await import("./index.js");
const { pool } = await import("./pool.js");
const { staffUsers } = await import("./schema.js");
const { eq } = await import("drizzle-orm");

const passwordHash = await hashPassword(adminPassword);

try {
  if (updatePasswordOnly) {
    // Password only: role, name, and active status are never touched here.
    const updated = await db
      .update(staffUsers)
      .set({ passwordHash })
      .where(eq(staffUsers.email, adminEmail))
      .returning({ id: staffUsers.id });

    if (updated.length === 0) {
      refuse(`${adminEmail} was not found; run the seed without --update-password first`);
    }

    console.log(`${adminEmail}: updated`);
  } else {
    const inserted = await db
      .insert(staffUsers)
      .values({
        email: adminEmail,
        name: adminName,
        passwordHash,
        role: "admin",
      })
      .onConflictDoNothing({ target: staffUsers.email })
      .returning({ id: staffUsers.id });

    console.log(`${adminEmail}: ${inserted.length > 0 ? "created" : "unchanged"}`);
  }
} finally {
  await pool.end();
}

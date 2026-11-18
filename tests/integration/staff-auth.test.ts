import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { test } from "node:test";
import { eq, like } from "drizzle-orm";
import express from "express";
import { db } from "../../src/db/index.js";
import { staffUsers } from "../../src/db/schema.js";
import { errorHandler } from "../../src/middleware/errorHandler.js";

// The staff config validates JWT_SECRET at import time and exits the process if
// it is missing or short. Force a test value here, before any staff module is
// imported, so the suite can never sign with a real key.
process.env.JWT_SECRET = "test-jwt-secret-with-at-least-32-chars";

const { hashPassword, verifyPassword } = await import(
  "../../src/modules/staff/password.js"
);
const { staffRouter } = await import("../../src/modules/staff/routes.js");
const { requireRole, requireStaff } = await import(
  "../../src/modules/staff/middleware.js"
);
const { signStaffToken, verifyStaffToken } = await import(
  "../../src/modules/staff/token.js"
);

const EMAIL_PREFIX = "test-staff-";
const PASSWORD = "correct-horse-battery";

type Role = "admin" | "agent";

function newEmail(): string {
  return `${EMAIL_PREFIX}${randomUUID().replace(/-/g, "").slice(0, 12)}@example.test`;
}

async function createStaff(input: {
  email?: string;
  password?: string;
  role?: Role;
  active?: boolean;
}): Promise<{ id: string; email: string }> {
  const email = input.email ?? newEmail();
  const passwordHash = await hashPassword(input.password ?? PASSWORD);

  const [row] = await db
    .insert(staffUsers)
    .values({
      email,
      name: "Test Staff",
      passwordHash,
      role: input.role ?? "admin",
      active: input.active ?? true,
    })
    .returning({ id: staffUsers.id, email: staffUsers.email });

  if (!row) {
    throw new Error("Could not insert the staff fixture");
  }

  return row;
}

async function cleanStaff(): Promise<void> {
  await db.delete(staffUsers).where(like(staffUsers.email, `${EMAIL_PREFIX}%`));
}

const app = express();

app.use(express.json());
app.use("/api/staff", staffRouter);

// Test-only routes: app.ts is never loaded by the test runner (it pulls in the
// Redis-backed queue module), and role gates are exercised here.
app.get("/test/me", requireStaff, (_req, res) => {
  res.json({ staff: res.locals.staff });
});

app.get("/test/admin-only", requireStaff, requireRole("admin"), (_req, res) => {
  res.json({ ok: true });
});

app.use(errorHandler);

let server: Server | null = null;
let baseUrl = "";

{
  const started = app.listen(0, "127.0.0.1");

  await new Promise<void>((resolve, reject) => {
    started.once("listening", () => resolve());
    started.once("error", reject);
  });

  const address = started.address();

  if (address === null || typeof address === "string") {
    throw new Error("Staff auth test server did not bind a port");
  }

  server = started;
  baseUrl = `http://127.0.0.1:${address.port}`;
}

await cleanStaff();

async function login(
  email: string,
  password: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}/api/staff/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });

  const text = await response.text();

  return {
    status: response.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
}

async function loginToken(email: string, password = PASSWORD): Promise<string> {
  const result = await login(email, password);

  assert.equal(result.status, 200);

  const token = result.body.token;

  assert.equal(typeof token, "string");

  return token as string;
}

async function get(
  path: string,
  token?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

  const text = await response.text();

  return {
    status: response.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
}

const tests: Array<Promise<void>> = [
  test("correct password returns a token whose subject is the staff id", async () => {
    const staff = await createStaff({ role: "admin" });
    const result = await login(staff.email, PASSWORD);

    assert.equal(result.status, 200);

    const token = result.body.token;

    assert.equal(typeof token, "string");
    assert.equal((token as string).split(".").length, 3);
    assert.equal(await verifyStaffToken(token as string), staff.id);

    // Claims: 8-hour lifetime, fixed issuer and audience, no role.
    const payloadPart = (token as string).split(".")[1] ?? "";
    const payload = JSON.parse(
      Buffer.from(payloadPart, "base64url").toString("utf8"),
    ) as Record<string, unknown>;

    assert.equal(payload.sub, staff.id);
    assert.equal(payload.iss, "legwork-api");
    assert.equal(payload.aud, "legwork-staff");
    assert.equal(Number(payload.exp) - Number(payload.iat), 8 * 60 * 60);
    assert.equal("role" in payload, false);
  }),

  test("wrong password returns 401 Invalid credentials", async () => {
    const staff = await createStaff({ role: "agent" });
    const result = await login(staff.email, "definitely-not-the-password");

    assert.equal(result.status, 401);
    assert.equal(result.body.error, "Invalid credentials");
    assert.equal("token" in result.body, false);
  }),

  test("unknown email returns the same 401 body as a wrong password", async () => {
    const staff = await createStaff({ role: "agent" });
    const known = await login(staff.email, "definitely-not-the-password");
    const unknown = await login(newEmail(), "definitely-not-the-password");

    assert.equal(unknown.status, 401);
    assert.deepEqual(unknown.body, known.body);
  }),

  test("inactive account returns 401 Invalid credentials", async () => {
    const staff = await createStaff({ role: "admin", active: false });
    const result = await login(staff.email, PASSWORD);

    assert.equal(result.status, 401);
    assert.equal(result.body.error, "Invalid credentials");
  }),

  test("expired token returns 401", async () => {
    const staff = await createStaff({ role: "admin" });
    const { SignJWT } = await import("jose");
    const nowSeconds = Math.floor(Date.now() / 1000);

    const expired = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(staff.id)
      .setIssuedAt(nowSeconds - 7200)
      .setIssuer("legwork-api")
      .setAudience("legwork-staff")
      .setExpirationTime(nowSeconds - 3600)
      .sign(new TextEncoder().encode(process.env.JWT_SECRET));

    const result = await get("/test/me", expired);

    assert.equal(result.status, 401);
  }),

  test("tampered token returns 401", async () => {
    const staff = await createStaff({ role: "admin" });
    const token = await loginToken(staff.email);
    const tampered = `${token.slice(0, -2)}${
      token.endsWith("aa") ? "bb" : "aa"
    }`;

    const result = await get("/test/me", tampered);

    assert.equal(result.status, 401);
  }),

  test("token for a deleted staff row returns 401", async () => {
    const staff = await createStaff({ role: "admin" });
    const token = await loginToken(staff.email);

    const before = await get("/test/me", token);
    assert.equal(before.status, 200);

    await db.delete(staffUsers).where(eq(staffUsers.id, staff.id));

    const after = await get("/test/me", token);
    assert.equal(after.status, 401);
  }),

  test("agent is rejected with 403 on an admin-only route", async () => {
    const agent = await createStaff({ role: "agent" });
    const token = await loginToken(agent.email);

    const own = await get("/test/me", token);
    assert.equal(own.status, 200);
    assert.deepEqual((own.body.staff as { role: string }).role, "agent");

    const denied = await get("/test/admin-only", token);
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error, "Forbidden");
  }),

  test("malformed login body returns 400 from the validation handler", async () => {
    const response = await fetch(`${baseUrl}/api/staff/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "not-an-email", password: "" }),
    });

    assert.equal(response.status, 400);
  }),

  test("password helpers round-trip and reject a wrong secret", async () => {
    const stored = await hashPassword(PASSWORD);

    assert.match(stored, /^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
    assert.equal(await verifyPassword(PASSWORD, stored), true);
    assert.equal(await verifyPassword("wrong", stored), false);
    assert.equal(await verifyPassword(PASSWORD, "not-a-hash"), false);
  }),

  test("staff tokens round-trip and reject a missing token", async () => {
    const staff = await createStaff({ role: "agent" });
    const token = await signStaffToken(staff.id);

    assert.equal(await verifyStaffToken(token), staff.id);
    assert.equal((await get("/test/me")).status, 401);
  }),
];

export const suiteTests: Array<Promise<void>> = [
  ...tests,
  // Runs after every test above has settled: drop the fixtures, then close the
  // port this suite opened. Self-contained because the shared test server in
  // helpers/server.ts only mounts the webhooks router.
  Promise.allSettled(tests).then(async () => {
    await cleanStaff();

    const current = server;

    if (!current) {
      return;
    }

    server = null;
    current.closeAllConnections();

    await new Promise<void>((resolve, reject) => {
      current.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }),
];

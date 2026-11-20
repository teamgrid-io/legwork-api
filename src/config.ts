import { config as loadEnv } from "dotenv";
import { z } from "zod";

// Load .env, but never overwrite variables that are already set in the
// environment. `override: false` is explicit so a DOTENV_CONFIG_OVERRIDE
// value cannot change this behaviour.
loadEnv({ quiet: true, override: false });

const envSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"], {
        error: "must be one of development, test, production",
      })
      .default("development"),
    PORT: z.coerce
      .number({ error: "must be a number" })
      .int("must be an integer")
      .min(1, "must be between 1 and 65535")
      .max(65535, "must be between 1 and 65535")
      .default(4000),
    DATABASE_URL: z.string({ error: "is required" }).min(1, "is required"),
    WEB_URL: z
      .string({ error: "is required" })
      .min(1, "is required")
      .pipe(z.url("must be a valid URL")),
    PAYMENT_PROVIDER: z.enum(["stripe", "dummy"], {
      error: "must be 'stripe' or 'dummy'",
    }),
    STRIPE_SECRET_KEY: z.string().min(1, "must not be empty").optional(),
    STRIPE_WEBHOOK_SECRET: z.string().min(1, "must not be empty").optional(),
    FIELD_ENCRYPTION_KEY: z
      .string({ error: "is required" })
      .regex(/^[0-9a-f]{64}$/i, "must be a 64-character hex string"),
    UPLOAD_DIR: z
      .string()
      .min(1, "must not be empty")
      .default("./private-uploads"),
    REDIS_URL: z.string().min(1, "must not be empty").optional(),
    ADMIN_PASSWORD: z
      .string({ error: "is required" })
      .min(8, "must be at least 8 characters"),
    // Customer auth. Validated like JWT_SECRET in modules/staff/config.ts, and
    // kept separate so a customer token can never be accepted as a staff token.
    CUSTOMER_JWT_SECRET: z
      .string({ error: "is required" })
      .min(32, "must be at least 32 characters"),
    // Optional in .env. Absent or blank is removed by withoutEmptyValues(),
    // so .default(300) applies. Non-numeric input fails .int().
    PAYMENT_REVIEW_GRACE_SECONDS: z.coerce
      .number({ error: "must be a number" })
      .int("must be an integer")
      .min(0, "must be between 0 and 3600")
      .max(3600, "must be between 0 and 3600")
      .default(300),
  })
  .superRefine((env, ctx) => {
    if (env.PAYMENT_PROVIDER === "stripe" && !env.STRIPE_SECRET_KEY) {
      ctx.addIssue({
        code: "custom",
        path: ["STRIPE_SECRET_KEY"],
        message: "is required when PAYMENT_PROVIDER is 'stripe'",
      });
    }

    if (env.PAYMENT_PROVIDER === "stripe" && !env.STRIPE_WEBHOOK_SECRET) {
      ctx.addIssue({
        code: "custom",
        path: ["STRIPE_WEBHOOK_SECRET"],
        message: "is required when PAYMENT_PROVIDER is 'stripe'",
      });
    }

    if (env.PAYMENT_PROVIDER === "dummy" && env.NODE_ENV === "production") {
      ctx.addIssue({
        code: "custom",
        path: ["PAYMENT_PROVIDER"],
        message: "cannot be 'dummy' when NODE_ENV is 'production'",
      });
    }

    if (env.NODE_ENV === "production" && !env.REDIS_URL) {
      ctx.addIssue({
        code: "custom",
        path: ["REDIS_URL"],
        message: "is required when NODE_ENV is 'production'",
      });
    }

    // Same key for both token audiences would let a customer token verify as a
    // staff token (or the reverse) if the audience check were ever dropped.
    const staffSecret = process.env.JWT_SECRET?.trim();

    if (staffSecret && env.CUSTOMER_JWT_SECRET.trim() === staffSecret) {
      ctx.addIssue({
        code: "custom",
        path: ["CUSTOMER_JWT_SECRET"],
        message: "must differ from JWT_SECRET",
      });
    }
  });

export interface AppConfig {
  readonly nodeEnv: "development" | "test" | "production";
  readonly isProduction: boolean;
  readonly port: number;
  readonly databaseUrl: string;
  readonly webUrl: string;
  readonly paymentProvider: "stripe" | "dummy";
  readonly stripeSecretKey: string | undefined;
  readonly stripeWebhookSecret: string | undefined;
  readonly fieldEncryptionKey: Buffer;
  readonly uploadDir: string;
  readonly redisUrl: string;
  readonly adminPassword: string;
  readonly customerJwtSecret: string;
  readonly paymentReviewGraceSeconds: number;
}

export type EnvValidationResult =
  | { readonly ok: true; readonly config: AppConfig }
  | { readonly ok: false; readonly variable: string; readonly message: string };

/**
 * Treat empty and whitespace-only values as if the variable was not set.
 * This makes ADMIN_PASSWORD="" (and PORT=" ", etc.) fail validation instead
 * of slipping past `.min(1)` / `.min(8)` checks.
 */
function withoutEmptyValues(source: NodeJS.ProcessEnv): Record<string, string> {
  const values: Record<string, string> = {};

  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string" && value.trim() !== "") {
      values[key] = value;
    }
  }

  return values;
}

export function validateEnv(source: NodeJS.ProcessEnv = process.env): EnvValidationResult {
  const parsed = envSchema.safeParse(withoutEmptyValues(source));

  if (!parsed.success) {
    const issue = parsed.error.issues[0];

    return {
      ok: false,
      variable: issue?.path.join(".") || "environment",
      message: issue?.message ?? "is invalid",
    };
  }

  const env = parsed.data;

  return {
    ok: true,
    config: Object.freeze({
      nodeEnv: env.NODE_ENV,
      isProduction: env.NODE_ENV === "production",
      port: env.PORT,
      databaseUrl: env.DATABASE_URL,
      webUrl: env.WEB_URL,
      paymentProvider: env.PAYMENT_PROVIDER,
      stripeSecretKey: env.STRIPE_SECRET_KEY,
      stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET,
      fieldEncryptionKey: Buffer.from(env.FIELD_ENCRYPTION_KEY, "hex"),
      uploadDir: env.UPLOAD_DIR,
      redisUrl: env.REDIS_URL ?? "redis://localhost:6379",
      adminPassword: env.ADMIN_PASSWORD,
      customerJwtSecret: env.CUSTOMER_JWT_SECRET,
      paymentReviewGraceSeconds: env.PAYMENT_REVIEW_GRACE_SECONDS,
    }),
  };
}

const result = validateEnv();

if (!result.ok) {
  // One clear message, naming the variable. Values (secrets) are never printed.
  console.error(`Invalid environment configuration: ${result.variable} ${result.message}`);
  process.exit(1);
}

export const config: AppConfig = result.config;

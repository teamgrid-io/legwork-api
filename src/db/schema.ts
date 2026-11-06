import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  char,
  check,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const countries = pgTable("countries", {
  id: uuid("id").primaryKey().defaultRandom(),
  iso2: char("iso2", { length: 2 }).notNull().unique(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
});

export const routeType = pgEnum("route_type", ["complete", "guided"]);

export const visaProducts = pgTable(
  "visa_products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    destinationCountryId: uuid("destination_country_id")
      .notNull()
      .references(() => countries.id),
    route: routeType("route").notNull().default("complete"),
    name: text("name").notNull(),
    stayDays: integer("stay_days"),
    processingDaysMin: integer("processing_days_min").notNull(),
    processingDaysMax: integer("processing_days_max").notNull(),
    passportValidityMonths: integer("passport_validity_months"),
    requiredDocuments: jsonb("required_documents").notNull().default([]),
    governmentFeeCents: integer("government_fee_cents").notNull(),
    legworkFeeCents: integer("legwork_fee_cents").notNull(),
    currency: char("currency", { length: 3 }).notNull().default("USD"),
    active: boolean("active").notNull().default(true),
  },
  (table) => [
    uniqueIndex("visa_products_country_route_uq").on(
      table.destinationCountryId,
      table.route,
    ),
    check(
      "visa_products_processing_days_check",
      sql`${table.processingDaysMin} <= ${table.processingDaysMax}`,
    ),
    check(
      "visa_products_government_fee_cents_check",
      sql`${table.governmentFeeCents} >= 0`,
    ),
    check(
      "visa_products_legwork_fee_cents_check",
      sql`${table.legworkFeeCents} >= 0`,
    ),
  ],
);

export const requestStatus = pgEnum("request_status", [
  "requested",
  "confirmed",
  "paid",
  "documents_in",
  "in_review",
  "filed",
  "guide_sent",
  "delivered",
  "closed",
]);

export const requestSideState = pgEnum("request_side_state", [
  "needs_info",
  "not_eligible",
  "refused",
  "payment_due",
  "cancelled",
  "abandoned",
]);

export const paymentStatus = pgEnum("payment_status", ["unpaid", "paid"]);

export const paymentProvider = pgEnum("payment_provider", ["stripe", "dummy"]);

export const requests = pgTable(
  "requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reference: text("reference").notNull().unique(),
    statusTokenHash: char("status_token_hash", { length: 64 }).unique(),
    visaProductId: uuid("visa_product_id")
      .notNull()
      .references(() => visaProducts.id),
    destinationCountryId: uuid("destination_country_id")
      .notNull()
      .references(() => countries.id),
    passportCountryId: uuid("passport_country_id")
      .notNull()
      .references(() => countries.id),
    governmentFeeCents: integer("government_fee_cents").notNull(),
    legworkFeeCents: integer("legwork_fee_cents").notNull(),
    currency: char("currency", { length: 3 }).notNull().default("USD"),
    amountCents: integer("amount_cents").notNull(),
    status: requestStatus("status").notNull().default("requested"),
    sideState: requestSideState("side_state"),
    estimatedReadyDate: date("estimated_ready_date"),
    paymentStatus: paymentStatus("payment_status").notNull().default("unpaid"),
    paymentProvider: paymentProvider("payment_provider"),
    stripeCheckoutSessionId: text("stripe_checkout_session_id").unique(),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    travelDate: date("travel_date").notNull(),
    contactEmail: text("contact_email").notNull(),
    contactPhone: text("contact_phone"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("requests_status_travel_idx").on(table.status, table.travelDate),
    index("requests_payment_created_idx").on(table.paymentStatus, table.createdAt),
    index("requests_email_idx").on(table.contactEmail),
    check("requests_amount_cents_check", sql`${table.amountCents} > 0`),
    check(
      "requests_government_fee_cents_check",
      sql`${table.governmentFeeCents} >= 0`,
    ),
    check(
      "requests_legwork_fee_cents_check",
      sql`${table.legworkFeeCents} >= 0`,
    ),
  ],
);

const bytea = customType<{ data: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const applicants = pgTable(
  "applicants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => requests.id, { onDelete: "cascade" }),
    fullName: text("full_name").notNull(),
    dateOfBirth: date("date_of_birth"),
    nationalityCountryId: uuid("nationality_country_id").references(
      () => countries.id,
    ),
    passportNumberEnc: bytea("passport_number_enc"),
    passportExpiry: date("passport_expiry"),
    sortOrder: integer("sort_order").notNull().default(1),
  },
  (table) => [
    index("applicants_request_idx").on(table.requestId),
    check("applicants_sort_order_check", sql`${table.sortOrder} >= 1`),
  ],
);

export const staffRole = pgEnum("staff_role", ["editor", "specialist", "admin"]);

export const staffUsers = pgTable("staff_users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  role: staffRole("role").notNull(),
  active: boolean("active").notNull().default(true),
});

export const visaRequirement = pgEnum("visa_requirement", [
  "visa_free",
  "visa_required",
]);

export const visaRules = pgTable(
  "visa_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    destinationCountryId: uuid("destination_country_id")
      .notNull()
      .references(() => countries.id),
    passportCountryId: uuid("passport_country_id")
      .notNull()
      .references(() => countries.id),
    requirement: visaRequirement("requirement").notNull(),
    notes: text("notes"),
  },
  (table) => [
    uniqueIndex("visa_rules_pair_uq").on(
      table.destinationCountryId,
      table.passportCountryId,
    ),
  ],
);

export const feeVersions = pgTable(
  "fee_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    visaProductId: uuid("visa_product_id")
      .notNull()
      .references(() => visaProducts.id),
    governmentFeeCents: integer("government_fee_cents").notNull(),
    legworkFeeCents: integer("legwork_fee_cents").notNull(),
    currency: char("currency", { length: 3 }).notNull().default("USD"),
    effectiveFrom: date("effective_from").notNull(),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("fee_versions_product_date_uq").on(
      table.visaProductId,
      table.effectiveFrom,
    ),
    check(
      "fee_versions_government_fee_cents_check",
      sql`${table.governmentFeeCents} >= 0`,
    ),
    check(
      "fee_versions_legwork_fee_cents_check",
      sql`${table.legworkFeeCents} >= 0`,
    ),
  ],
);

export const documentStatus = pgEnum("document_status", [
  "uploaded",
  "accepted",
  "needs_fix",
  "rejected",
]);

export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => requests.id, { onDelete: "cascade" }),
    applicantId: uuid("applicant_id").references(() => applicants.id, {
      onDelete: "cascade",
    }),
    kind: text("kind").notNull(),
    storageKey: text("storage_key").notNull().unique(),
    sha256: char("sha256", { length: 64 }).notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    status: documentStatus("status").notNull().default("uploaded"),
    reviewedBy: uuid("reviewed_by").references(() => staffUsers.id),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull().defaultNow(),
    deleteAfter: timestamp("delete_after", { withTimezone: true }),
  },
  (table) => [
    index("documents_request_idx").on(table.requestId),
    check(
      "documents_size_bytes_check",
      sql`${table.sizeBytes} > 0 AND ${table.sizeBytes} <= 5242880`,
    ),
  ],
);

export const actorType = pgEnum("actor_type", [
  "traveller",
  "specialist",
  "system",
  "stripe",
]);

export const requestEvents = pgTable(
  "request_events",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => requests.id, { onDelete: "cascade" }),
    fromStatus: requestStatus("from_status"),
    toStatus: requestStatus("to_status").notNull(),
    actorType: actorType("actor_type").notNull(),
    actorId: uuid("actor_id"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("request_events_request_time_idx").on(table.requestId, table.createdAt),
  ],
);

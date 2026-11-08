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

const bytea = customType<{ data: Buffer }>({
  dataType() {
    return "bytea";
  },
});

// Lists already modeled as enums in the code today.
export const visaRequirement = pgEnum("visa_requirement", [
  "visa_free",
  "visa_required",
]);

export const documentStatus = pgEnum("document_status", [
  "uploaded",
  "accepted",
  "needs_fix",
  "rejected",
]);

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

export const countries = pgTable("countries", {
  id: uuid("id").primaryKey().defaultRandom(),
  iso2: char("iso2", { length: 2 }).notNull().unique(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
});

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

export const visaProducts = pgTable(
  "visa_products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    destinationCountryId: uuid("destination_country_id")
      .notNull()
      .references(() => countries.id),
    name: text("name").notNull(),
    visaType: text("visa_type").notNull(),
    stayDays: integer("stay_days"),
    processingDaysMin: integer("processing_days_min").notNull(),
    processingDaysMax: integer("processing_days_max").notNull(),
    governmentFeeCents: integer("government_fee_cents").notNull(),
    legworkFeeCents: integer("legwork_fee_cents").notNull(),
    currency: char("currency", { length: 3 }).notNull().default("USD"),
    requiredDocuments: jsonb("required_documents").notNull().default([]),
    currentFormVersion: integer("current_form_version")
      .notNull()
      .default(1),
    active: boolean("active").notNull().default(true),
  },
  (table) => [
    check(
      "visa_products_visa_type_check",
      sql`${table.visaType} in ('single_entry', 'multiple_entry')`,
    ),
    check(
      "visa_products_processing_days_check",
      sql`${table.processingDaysMax} >= ${table.processingDaysMin}`,
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

export const formFields = pgTable(
  "form_fields",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    visaProductId: uuid("visa_product_id")
      .notNull()
      .references(() => visaProducts.id),
    formVersion: integer("form_version").notNull(),
    step: text("step").notNull(),
    groupKey: text("group_key").notNull(),
    fieldKey: text("field_key").notNull(),
    label: text("label").notNull(),
    fieldType: text("field_type").notNull(),
    required: boolean("required").notNull().default(false),
    options: jsonb("options").notNull().default([]),
    sortOrder: integer("sort_order").notNull().default(0),
    visibleIf: jsonb("visible_if"),
  },
  (table) => [
    uniqueIndex("form_fields_version_key_uq").on(
      table.visaProductId,
      table.formVersion,
      table.fieldKey,
    ),
    index("form_fields_order_idx").on(
      table.visaProductId,
      table.formVersion,
      table.step,
      table.sortOrder,
    ),
    check(
      "form_fields_step_check",
      sql`${table.step} in ('basic', 'full')`,
    ),
    check(
      "form_fields_group_key_check",
      sql`${table.groupKey} in ('account', 'personal', 'contact', 'passport', 'spouse', 'travel', 'declaration')`,
    ),
    check(
      "form_fields_field_type_check",
      sql`${table.fieldType} in ('text', 'email', 'phone', 'date', 'select', 'radio', 'checkbox', 'country')`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Checkout, customers, orders
// ---------------------------------------------------------------------------

export const pendingCheckouts = pgTable(
  "pending_checkouts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reference: text("reference").notNull().unique(),
    visaProductId: uuid("visa_product_id")
      .notNull()
      .references(() => visaProducts.id),
    passportCountryId: uuid("passport_country_id")
      .notNull()
      .references(() => countries.id),
    originCountryId: uuid("origin_country_id").references(() => countries.id),
    travelDate: date("travel_date").notNull(),
    travellerCount: integer("traveller_count").notNull(),
    travellers: jsonb("travellers").notNull(),
    contactEmail: text("contact_email").notNull(),
    contactPhone: text("contact_phone"),
    formVersion: integer("form_version").notNull(),
    governmentFeeCents: integer("government_fee_cents").notNull(),
    legworkFeeCents: integer("legwork_fee_cents").notNull(),
    amountCents: integer("amount_cents").notNull(),
    currency: char("currency", { length: 3 }).notNull().default("USD"),
    status: text("status").notNull().default("open"),
    stripeSessionId: text("stripe_session_id").unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("pending_checkouts_status_idx").on(
      table.status,
      table.expiresAt,
    ),
    check(
      "pending_checkouts_traveller_count_check",
      sql`${table.travellerCount} between 1 and 2`,
    ),
    check(
      "pending_checkouts_government_fee_cents_check",
      sql`${table.governmentFeeCents} >= 0`,
    ),
    check(
      "pending_checkouts_legwork_fee_cents_check",
      sql`${table.legworkFeeCents} >= 0`,
    ),
    check(
      "pending_checkouts_amount_cents_check",
      sql`${table.amountCents} > 0`,
    ),
    check(
      "pending_checkouts_status_check",
      sql`${table.status} in ('open', 'paid', 'expired')`,
    ),
  ],
);

export const customers = pgTable("customers", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  phone: text("phone"),
  passwordHash: text("password_hash"),
  activationTokenHash: char("activation_token_hash", { length: 64 }).unique(),
  activationExpiresAt: timestamp("activation_expires_at", {
    withTimezone: true,
  }),
  activatedAt: timestamp("activated_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const orders = pgTable(
  "orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderNumber: text("order_number").notNull().unique(),
    pendingCheckoutId: uuid("pending_checkout_id")
      .notNull()
      .unique()
      .references(() => pendingCheckouts.id),
    customerId: uuid("customer_id").references(() => customers.id),
    visaProductId: uuid("visa_product_id")
      .notNull()
      .references(() => visaProducts.id),
    passportCountryId: uuid("passport_country_id")
      .notNull()
      .references(() => countries.id),
    originCountryId: uuid("origin_country_id").references(() => countries.id),
    travelDate: date("travel_date").notNull(),
    travellerCount: integer("traveller_count").notNull(),
    contactEmail: text("contact_email").notNull(),
    contactPhone: text("contact_phone"),
    formVersion: integer("form_version").notNull(),
    amountCents: integer("amount_cents").notNull(),
    currency: char("currency", { length: 3 }).notNull().default("USD"),
    status: text("status").notNull().default("paid"),
    paidAt: timestamp("paid_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("orders_status_travel_idx").on(table.status, table.travelDate),
    index("orders_email_idx").on(table.contactEmail),
    check(
      "orders_traveller_count_check",
      sql`${table.travellerCount} between 1 and 2`,
    ),
    check("orders_amount_cents_check", sql`${table.amountCents} > 0`),
    check(
      "orders_status_check",
      sql`${table.status} in ('paid', 'in_review', 'needs_info', 'ready_to_submit', 'submitted', 'completed', 'cancelled')`,
    ),
  ],
);

export const orderItems = pgTable(
  "order_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    itemType: text("item_type").notNull(),
    description: text("description").notNull(),
    quantity: integer("quantity").notNull().default(1),
    unitAmountCents: integer("unit_amount_cents").notNull(),
    totalAmountCents: integer("total_amount_cents").notNull(),
    currency: char("currency", { length: 3 }).notNull().default("USD"),
  },
  (table) => [
    check(
      "order_items_item_type_check",
      sql`${table.itemType} in ('government_fee', 'service_fee', 'tax', 'adjustment')`,
    ),
    check("order_items_quantity_check", sql`${table.quantity} >= 1`),
    check(
      "order_items_unit_amount_cents_check",
      sql`${table.unitAmountCents} >= 0`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Applicants and documents
// ---------------------------------------------------------------------------

export const applicants = pgTable(
  "applicants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    sortOrder: integer("sort_order").notNull().default(1),
    firstName: text("first_name").notNull(),
    surname: text("surname").notNull(),
    answers: jsonb("answers").notNull().default({}),
    status: text("status").notNull().default("incomplete"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("applicants_order_sort_uq").on(
      table.orderId,
      table.sortOrder,
    ),
    check("applicants_sort_order_check", sql`${table.sortOrder} >= 1`),
    check(
      "applicants_status_check",
      sql`${table.status} in ('incomplete', 'documents_pending', 'complete', 'under_review', 'approved', 'rejected')`,
    ),
  ],
);

export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    applicantId: uuid("applicant_id")
      .notNull()
      .references(() => applicants.id, { onDelete: "cascade" }),
    documentType: text("document_type").notNull(),
    storageKey: text("storage_key").notNull().unique(),
    sha256: char("sha256", { length: 64 }).notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    status: documentStatus("status").notNull().default("uploaded"),
    reviewedBy: uuid("reviewed_by").references(() => staffUsers.id),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("documents_applicant_idx").on(table.applicantId),
    check(
      "documents_document_type_check",
      sql`${table.documentType} in ('applicant_photo', 'passport_scan', 'return_ticket')`,
    ),
    check(
      "documents_mime_type_check",
      sql`${table.mimeType} in ('image/jpeg', 'image/png', 'application/pdf')`,
    ),
    check(
      "documents_size_bytes_check",
      sql`${table.sizeBytes} > 0 AND ${table.sizeBytes} <= 5242880`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Events, audit trail, staff
// ---------------------------------------------------------------------------

export const orderEvents = pgTable(
  "order_events",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    fromStatus: text("from_status"),
    toStatus: text("to_status").notNull(),
    actorType: text("actor_type").notNull(),
    actorId: uuid("actor_id"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("order_events_order_time_idx").on(
      table.orderId,
      table.createdAt,
    ),
    check(
      "order_events_from_status_check",
      sql`${table.fromStatus} is null or ${table.fromStatus} in ('paid', 'in_review', 'needs_info', 'ready_to_submit', 'submitted', 'completed', 'cancelled')`,
    ),
    check(
      "order_events_to_status_check",
      sql`${table.toStatus} in ('paid', 'in_review', 'needs_info', 'ready_to_submit', 'submitted', 'completed', 'cancelled')`,
    ),
    check(
      "order_events_actor_type_check",
      sql`${table.actorType} in ('customer', 'staff', 'system', 'stripe')`,
    ),
  ],
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    actorType: text("actor_type").notNull(),
    actorId: uuid("actor_id"),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id"),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("audit_logs_entity_idx").on(
      table.entityType,
      table.entityId,
      table.createdAt,
    ),
    check(
      "audit_logs_actor_type_check",
      sql`${table.actorType} in ('customer', 'staff', 'system', 'stripe')`,
    ),
  ],
);

export const staffUsers = pgTable(
  "staff_users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull().unique(),
    name: text("name").notNull(),
    passwordHash: text("password_hash").notNull(),
    role: text("role").notNull(),
    active: boolean("active").notNull().default(true),
    mfaEnabled: boolean("mfa_enabled").notNull().default(false),
    mfaSecretEnc: bytea("mfa_secret_enc"),
  },
  (table) => [
    check(
      "staff_users_role_check",
      sql`${table.role} in ('admin', 'agent')`,
    ),
  ],
);

CREATE TYPE "public"."visa_requirement" AS ENUM('visa_free', 'visa_required');--> statement-breakpoint
CREATE TABLE "applicants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"sort_order" integer DEFAULT 1 NOT NULL,
	"first_name" text NOT NULL,
	"surname" text NOT NULL,
	"answers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'incomplete' NOT NULL,
	"submitted_at" timestamp with time zone,
	CONSTRAINT "applicants_sort_order_check" CHECK ("applicants"."sort_order" >= 1),
	CONSTRAINT "applicants_status_check" CHECK ("applicants"."status" in ('incomplete', 'documents_pending', 'complete', 'under_review', 'approved', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_logs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"actor_type" text NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_logs_actor_type_check" CHECK ("audit_logs"."actor_type" in ('customer', 'staff', 'system', 'stripe'))
);
--> statement-breakpoint
CREATE TABLE "countries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"iso2" char(2) NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	CONSTRAINT "countries_iso2_unique" UNIQUE("iso2"),
	CONSTRAINT "countries_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"phone" text,
	"password_hash" text,
	"activation_token_hash" char(64),
	"activation_expires_at" timestamp with time zone,
	"activated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customers_email_unique" UNIQUE("email"),
	CONSTRAINT "customers_activation_token_hash_unique" UNIQUE("activation_token_hash")
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"applicant_id" uuid NOT NULL,
	"document_type" text NOT NULL,
	"storage_key" text NOT NULL,
	"sha256" char(64) NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"status" text DEFAULT 'uploaded' NOT NULL,
	"rejection_reason" text,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_storage_key_unique" UNIQUE("storage_key"),
	CONSTRAINT "documents_status_check" CHECK ("documents"."status" in ('uploaded', 'pending_scan', 'verified', 'rejected')),
	CONSTRAINT "documents_document_type_check" CHECK ("documents"."document_type" in ('applicant_photo', 'passport_scan', 'return_ticket')),
	CONSTRAINT "documents_mime_type_check" CHECK ("documents"."mime_type" in ('image/jpeg', 'image/png', 'application/pdf')),
	CONSTRAINT "documents_size_bytes_check" CHECK ("documents"."size_bytes" > 0 AND "documents"."size_bytes" <= 5242880)
);
--> statement-breakpoint
CREATE TABLE "form_fields" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"visa_product_id" uuid NOT NULL,
	"form_version" integer NOT NULL,
	"step" text NOT NULL,
	"group_key" text NOT NULL,
	"field_key" text NOT NULL,
	"label" text NOT NULL,
	"field_type" text NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"visible_if" jsonb,
	CONSTRAINT "form_fields_step_check" CHECK ("form_fields"."step" in ('basic', 'full')),
	CONSTRAINT "form_fields_group_key_check" CHECK ("form_fields"."group_key" in ('account', 'personal', 'contact', 'passport', 'spouse', 'travel', 'declaration')),
	CONSTRAINT "form_fields_field_type_check" CHECK ("form_fields"."field_type" in ('text', 'email', 'phone', 'date', 'select', 'radio', 'checkbox', 'country'))
);
--> statement-breakpoint
CREATE TABLE "order_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "order_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"order_id" uuid NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_events_from_status_check" CHECK ("order_events"."from_status" is null or "order_events"."from_status" in ('paid', 'in_review', 'needs_info', 'ready_to_submit', 'submitted', 'completed', 'cancelled')),
	CONSTRAINT "order_events_to_status_check" CHECK ("order_events"."to_status" in ('paid', 'in_review', 'needs_info', 'ready_to_submit', 'submitted', 'completed', 'cancelled')),
	CONSTRAINT "order_events_actor_type_check" CHECK ("order_events"."actor_type" in ('customer', 'staff', 'system', 'stripe'))
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"item_type" text NOT NULL,
	"description" text NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"unit_amount_cents" integer NOT NULL,
	"total_amount_cents" integer NOT NULL,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	CONSTRAINT "order_items_item_type_check" CHECK ("order_items"."item_type" in ('government_fee', 'service_fee', 'tax', 'adjustment')),
	CONSTRAINT "order_items_quantity_check" CHECK ("order_items"."quantity" >= 1),
	CONSTRAINT "order_items_unit_amount_cents_check" CHECK ("order_items"."unit_amount_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_number" text NOT NULL,
	"pending_checkout_id" uuid NOT NULL,
	"customer_id" uuid,
	"visa_product_id" uuid NOT NULL,
	"passport_country_id" uuid NOT NULL,
	"origin_country_id" uuid,
	"travel_date" date NOT NULL,
	"traveller_count" integer NOT NULL,
	"contact_email" text NOT NULL,
	"contact_phone" text,
	"form_version" integer NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"status" text DEFAULT 'paid' NOT NULL,
	"paid_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_order_number_unique" UNIQUE("order_number"),
	CONSTRAINT "orders_pending_checkout_id_unique" UNIQUE("pending_checkout_id"),
	CONSTRAINT "orders_traveller_count_check" CHECK ("orders"."traveller_count" between 1 and 2),
	CONSTRAINT "orders_amount_cents_check" CHECK ("orders"."amount_cents" > 0),
	CONSTRAINT "orders_status_check" CHECK ("orders"."status" in ('paid', 'in_review', 'needs_info', 'ready_to_submit', 'submitted', 'completed', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "pending_checkouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference" text NOT NULL,
	"visa_product_id" uuid NOT NULL,
	"passport_country_id" uuid NOT NULL,
	"origin_country_id" uuid,
	"travel_date" date NOT NULL,
	"traveller_count" integer NOT NULL,
	"travellers" jsonb NOT NULL,
	"contact_email" text NOT NULL,
	"contact_phone" text,
	"form_version" integer NOT NULL,
	"government_fee_cents" integer NOT NULL,
	"legwork_fee_cents" integer NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"stripe_session_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pending_checkouts_reference_unique" UNIQUE("reference"),
	CONSTRAINT "pending_checkouts_stripe_session_id_unique" UNIQUE("stripe_session_id"),
	CONSTRAINT "pending_checkouts_traveller_count_check" CHECK ("pending_checkouts"."traveller_count" between 1 and 2),
	CONSTRAINT "pending_checkouts_government_fee_cents_check" CHECK ("pending_checkouts"."government_fee_cents" >= 0),
	CONSTRAINT "pending_checkouts_legwork_fee_cents_check" CHECK ("pending_checkouts"."legwork_fee_cents" >= 0),
	CONSTRAINT "pending_checkouts_amount_cents_check" CHECK ("pending_checkouts"."amount_cents" > 0),
	CONSTRAINT "pending_checkouts_status_check" CHECK ("pending_checkouts"."status" in ('open', 'paid', 'expired'))
);
--> statement-breakpoint
CREATE TABLE "staff_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"mfa_enabled" boolean DEFAULT false NOT NULL,
	"mfa_secret_enc" "bytea",
	CONSTRAINT "staff_users_email_unique" UNIQUE("email"),
	CONSTRAINT "staff_users_role_check" CHECK ("staff_users"."role" in ('admin', 'agent'))
);
--> statement-breakpoint
CREATE TABLE "visa_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"destination_country_id" uuid NOT NULL,
	"name" text NOT NULL,
	"visa_type" text NOT NULL,
	"stay_days" integer,
	"processing_days_min" integer NOT NULL,
	"processing_days_max" integer NOT NULL,
	"government_fee_cents" integer NOT NULL,
	"legwork_fee_cents" integer NOT NULL,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"required_documents" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"current_form_version" integer DEFAULT 1 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "visa_products_visa_type_check" CHECK ("visa_products"."visa_type" in ('single_entry', 'multiple_entry')),
	CONSTRAINT "visa_products_processing_days_check" CHECK ("visa_products"."processing_days_max" >= "visa_products"."processing_days_min"),
	CONSTRAINT "visa_products_government_fee_cents_check" CHECK ("visa_products"."government_fee_cents" >= 0),
	CONSTRAINT "visa_products_legwork_fee_cents_check" CHECK ("visa_products"."legwork_fee_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "visa_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"destination_country_id" uuid NOT NULL,
	"passport_country_id" uuid NOT NULL,
	"requirement" "visa_requirement" NOT NULL,
	"notes" text
);
--> statement-breakpoint
ALTER TABLE "applicants" ADD CONSTRAINT "applicants_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_applicant_id_applicants_id_fk" FOREIGN KEY ("applicant_id") REFERENCES "public"."applicants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_reviewed_by_staff_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_fields" ADD CONSTRAINT "form_fields_visa_product_id_visa_products_id_fk" FOREIGN KEY ("visa_product_id") REFERENCES "public"."visa_products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_pending_checkout_id_pending_checkouts_id_fk" FOREIGN KEY ("pending_checkout_id") REFERENCES "public"."pending_checkouts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_visa_product_id_visa_products_id_fk" FOREIGN KEY ("visa_product_id") REFERENCES "public"."visa_products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_passport_country_id_countries_id_fk" FOREIGN KEY ("passport_country_id") REFERENCES "public"."countries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_origin_country_id_countries_id_fk" FOREIGN KEY ("origin_country_id") REFERENCES "public"."countries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_checkouts" ADD CONSTRAINT "pending_checkouts_visa_product_id_visa_products_id_fk" FOREIGN KEY ("visa_product_id") REFERENCES "public"."visa_products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_checkouts" ADD CONSTRAINT "pending_checkouts_passport_country_id_countries_id_fk" FOREIGN KEY ("passport_country_id") REFERENCES "public"."countries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_checkouts" ADD CONSTRAINT "pending_checkouts_origin_country_id_countries_id_fk" FOREIGN KEY ("origin_country_id") REFERENCES "public"."countries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visa_products" ADD CONSTRAINT "visa_products_destination_country_id_countries_id_fk" FOREIGN KEY ("destination_country_id") REFERENCES "public"."countries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visa_rules" ADD CONSTRAINT "visa_rules_destination_country_id_countries_id_fk" FOREIGN KEY ("destination_country_id") REFERENCES "public"."countries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visa_rules" ADD CONSTRAINT "visa_rules_passport_country_id_countries_id_fk" FOREIGN KEY ("passport_country_id") REFERENCES "public"."countries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "applicants_order_sort_uq" ON "applicants" USING btree ("order_id","sort_order");--> statement-breakpoint
CREATE INDEX "audit_logs_entity_idx" ON "audit_logs" USING btree ("entity_type","entity_id","created_at");--> statement-breakpoint
CREATE INDEX "documents_applicant_idx" ON "documents" USING btree ("applicant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "form_fields_version_key_uq" ON "form_fields" USING btree ("visa_product_id","form_version","field_key");--> statement-breakpoint
CREATE INDEX "form_fields_order_idx" ON "form_fields" USING btree ("visa_product_id","form_version","step","sort_order");--> statement-breakpoint
CREATE INDEX "order_events_order_time_idx" ON "order_events" USING btree ("order_id","created_at");--> statement-breakpoint
CREATE INDEX "orders_status_travel_idx" ON "orders" USING btree ("status","travel_date");--> statement-breakpoint
CREATE INDEX "orders_email_idx" ON "orders" USING btree ("contact_email");--> statement-breakpoint
CREATE INDEX "pending_checkouts_status_idx" ON "pending_checkouts" USING btree ("status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "visa_rules_pair_uq" ON "visa_rules" USING btree ("destination_country_id","passport_country_id");
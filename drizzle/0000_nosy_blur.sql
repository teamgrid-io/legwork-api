CREATE TYPE "public"."actor_type" AS ENUM('traveller', 'specialist', 'system', 'stripe');--> statement-breakpoint
CREATE TYPE "public"."document_status" AS ENUM('uploaded', 'accepted', 'needs_fix', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."payment_provider" AS ENUM('stripe', 'dummy');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('unpaid', 'paid');--> statement-breakpoint
CREATE TYPE "public"."request_side_state" AS ENUM('needs_info', 'not_eligible', 'refused', 'payment_due', 'cancelled', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."request_status" AS ENUM('requested', 'confirmed', 'paid', 'documents_in', 'in_review', 'filed', 'guide_sent', 'delivered', 'closed');--> statement-breakpoint
CREATE TYPE "public"."route_type" AS ENUM('complete', 'guided');--> statement-breakpoint
CREATE TYPE "public"."staff_role" AS ENUM('editor', 'specialist', 'admin');--> statement-breakpoint
CREATE TYPE "public"."visa_requirement" AS ENUM('visa_free', 'visa_required');--> statement-breakpoint
CREATE TABLE "applicants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"full_name" text NOT NULL,
	"date_of_birth" date,
	"nationality_country_id" uuid,
	"passport_number_enc" "bytea",
	"passport_expiry" date,
	"sort_order" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "applicants_sort_order_check" CHECK ("applicants"."sort_order" >= 1)
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
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"applicant_id" uuid,
	"kind" text NOT NULL,
	"storage_key" text NOT NULL,
	"sha256" char(64) NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"status" "document_status" DEFAULT 'uploaded' NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delete_after" timestamp with time zone,
	CONSTRAINT "documents_storage_key_unique" UNIQUE("storage_key"),
	CONSTRAINT "documents_size_bytes_check" CHECK ("documents"."size_bytes" > 0 AND "documents"."size_bytes" <= 5242880)
);
--> statement-breakpoint
CREATE TABLE "fee_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"visa_product_id" uuid NOT NULL,
	"government_fee_cents" integer NOT NULL,
	"legwork_fee_cents" integer NOT NULL,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"effective_from" date NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fee_versions_government_fee_cents_check" CHECK ("fee_versions"."government_fee_cents" >= 0),
	CONSTRAINT "fee_versions_legwork_fee_cents_check" CHECK ("fee_versions"."legwork_fee_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "request_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "request_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"request_id" uuid NOT NULL,
	"from_status" "request_status",
	"to_status" "request_status" NOT NULL,
	"actor_type" "actor_type" NOT NULL,
	"actor_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference" text NOT NULL,
	"status_token_hash" char(64),
	"visa_product_id" uuid NOT NULL,
	"destination_country_id" uuid NOT NULL,
	"passport_country_id" uuid NOT NULL,
	"government_fee_cents" integer NOT NULL,
	"legwork_fee_cents" integer NOT NULL,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"amount_cents" integer NOT NULL,
	"status" "request_status" DEFAULT 'requested' NOT NULL,
	"side_state" "request_side_state",
	"estimated_ready_date" date,
	"payment_status" "payment_status" DEFAULT 'unpaid' NOT NULL,
	"payment_provider" "payment_provider",
	"stripe_checkout_session_id" text,
	"paid_at" timestamp with time zone,
	"travel_date" date NOT NULL,
	"contact_email" text NOT NULL,
	"contact_phone" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "requests_reference_unique" UNIQUE("reference"),
	CONSTRAINT "requests_status_token_hash_unique" UNIQUE("status_token_hash"),
	CONSTRAINT "requests_stripe_checkout_session_id_unique" UNIQUE("stripe_checkout_session_id"),
	CONSTRAINT "requests_amount_cents_check" CHECK ("requests"."amount_cents" > 0),
	CONSTRAINT "requests_government_fee_cents_check" CHECK ("requests"."government_fee_cents" >= 0),
	CONSTRAINT "requests_legwork_fee_cents_check" CHECK ("requests"."legwork_fee_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "staff_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" "staff_role" NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "staff_users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "visa_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"destination_country_id" uuid NOT NULL,
	"route" "route_type" DEFAULT 'complete' NOT NULL,
	"name" text NOT NULL,
	"stay_days" integer,
	"processing_days_min" integer NOT NULL,
	"processing_days_max" integer NOT NULL,
	"passport_validity_months" integer,
	"required_documents" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"government_fee_cents" integer NOT NULL,
	"legwork_fee_cents" integer NOT NULL,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "visa_products_processing_days_check" CHECK ("visa_products"."processing_days_min" <= "visa_products"."processing_days_max"),
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
ALTER TABLE "applicants" ADD CONSTRAINT "applicants_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applicants" ADD CONSTRAINT "applicants_nationality_country_id_countries_id_fk" FOREIGN KEY ("nationality_country_id") REFERENCES "public"."countries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_applicant_id_applicants_id_fk" FOREIGN KEY ("applicant_id") REFERENCES "public"."applicants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_reviewed_by_staff_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_versions" ADD CONSTRAINT "fee_versions_visa_product_id_visa_products_id_fk" FOREIGN KEY ("visa_product_id") REFERENCES "public"."visa_products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_events" ADD CONSTRAINT "request_events_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_visa_product_id_visa_products_id_fk" FOREIGN KEY ("visa_product_id") REFERENCES "public"."visa_products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_destination_country_id_countries_id_fk" FOREIGN KEY ("destination_country_id") REFERENCES "public"."countries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_passport_country_id_countries_id_fk" FOREIGN KEY ("passport_country_id") REFERENCES "public"."countries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visa_products" ADD CONSTRAINT "visa_products_destination_country_id_countries_id_fk" FOREIGN KEY ("destination_country_id") REFERENCES "public"."countries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visa_rules" ADD CONSTRAINT "visa_rules_destination_country_id_countries_id_fk" FOREIGN KEY ("destination_country_id") REFERENCES "public"."countries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visa_rules" ADD CONSTRAINT "visa_rules_passport_country_id_countries_id_fk" FOREIGN KEY ("passport_country_id") REFERENCES "public"."countries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "applicants_request_idx" ON "applicants" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "documents_request_idx" ON "documents" USING btree ("request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fee_versions_product_date_uq" ON "fee_versions" USING btree ("visa_product_id","effective_from");--> statement-breakpoint
CREATE INDEX "request_events_request_time_idx" ON "request_events" USING btree ("request_id","created_at");--> statement-breakpoint
CREATE INDEX "requests_status_travel_idx" ON "requests" USING btree ("status","travel_date");--> statement-breakpoint
CREATE INDEX "requests_payment_created_idx" ON "requests" USING btree ("payment_status","created_at");--> statement-breakpoint
CREATE INDEX "requests_email_idx" ON "requests" USING btree ("contact_email");--> statement-breakpoint
CREATE UNIQUE INDEX "visa_products_country_route_uq" ON "visa_products" USING btree ("destination_country_id","route");--> statement-breakpoint
CREATE UNIQUE INDEX "visa_rules_pair_uq" ON "visa_rules" USING btree ("destination_country_id","passport_country_id");
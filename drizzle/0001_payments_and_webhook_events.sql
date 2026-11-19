CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pending_checkout_id" uuid NOT NULL,
	"stripe_session_id" text NOT NULL,
	"payment_intent_id" text,
	"amount_cents" integer NOT NULL,
	"currency" char(3) NOT NULL,
	"payment_method_type" text NOT NULL,
	"status" text NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"approval_idempotency_key" text,
	"paid_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_amount_cents_check" CHECK ("payments"."amount_cents" > 0),
	CONSTRAINT "payments_currency_check" CHECK ("payments"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "payments_payment_method_type_check" CHECK ("payments"."payment_method_type" = 'card'),
	CONSTRAINT "payments_status_check" CHECK ("payments"."status" IN ('succeeded', 'review_required', 'order_created')),
	CONSTRAINT "payments_approval_check" CHECK ("payments"."approved_by" IS NULL OR "payments"."status" = 'order_created'),
	CONSTRAINT "payments_approval_fields_check" CHECK (("payments"."approved_by" IS NULL) = ("payments"."approved_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "stripe_webhook_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"status" text NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "stripe_webhook_events_status_check" CHECK ("stripe_webhook_events"."status" IN ('processing', 'processed', 'failed')),
	CONSTRAINT "stripe_webhook_events_attempt_count_check" CHECK ("stripe_webhook_events"."attempt_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_pending_checkout_id_pending_checkouts_id_fk" FOREIGN KEY ("pending_checkout_id") REFERENCES "public"."pending_checkouts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_approved_by_staff_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payments_stripe_session_id_uq" ON "payments" USING btree ("stripe_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_payment_intent_id_uq" ON "payments" USING btree ("payment_intent_id") WHERE "payments"."payment_intent_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "payments_approval_idempotency_key_uq" ON "payments" USING btree ("approval_idempotency_key") WHERE "payments"."approval_idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "payments_status_idx" ON "payments" USING btree ("status");--> statement-breakpoint
CREATE INDEX "payments_pending_checkout_idx" ON "payments" USING btree ("pending_checkout_id");--> statement-breakpoint
CREATE INDEX "stripe_webhook_events_status_received_idx" ON "stripe_webhook_events" USING btree ("status","received_at");
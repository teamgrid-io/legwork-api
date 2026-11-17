# Late payment review — MVP spec

Status: approved for implementation on `feature/late-payment-review` (off `development` at `6bc21d7`).
Scope: keep late Stripe money visible, let an admin approve it once, dedupe webhook events. No UI, no refunds.

Schema reference: `docs/database-pilot.dbml` (`payments`, `stripe_webhook_events`).
Money is integer cents everywhere. Card data, secrets, and raw Stripe payloads are never logged.

## 1. Staff access

### 1.1 Login

| Item | Value |
| --- | --- |
| Method / path | `POST /api/staff/login` |
| Body | `{ "email": string, "password": string }` |
| Success | `200 { token, expiresAt, staff: { id, email, name, role } }` |
| Unknown email, wrong password, or `active = false` | `401` with the same message (`Invalid credentials`) — no account enumeration |
| Malformed body | `400` (`validation_error`, existing Zod handler) |

Password verification: Node `scrypt` with a per-password random salt, stored as `scrypt$N$r$p$salt$hash`
(base64url salt and hash), matching the `staff_users.password_hash` note. Comparison is
`timingSafeEqual`. A missing account still runs a dummy verification so response time does not
reveal whether the email exists.

`ADMIN_PASSWORD` already exists in `.env` and was flagged for rotation; rotate it before the first
real seed run.

### 1.2 Token

- Library: `jose`, algorithm `HS256`, secret from `JWT_SECRET` (required, minimum 32 characters, never logged).
- Claims: `sub` = staff id, `iat`, `exp`, `iss` = `legwork-api`, `aud` = `legwork-staff`.
- Expiry: 8 hours.
- **No role in the token.** The role is read from `staff_users` on every request, so a demotion or
  deactivation takes effect on the next request.
- `exp` is enforced by `jwtVerify`; the algorithm list is pinned, so `alg: none` and algorithm
  confusion are rejected.

### 1.3 Middleware

- `requireStaff`: requires `Authorization: Bearer <token>`, verifies the JWT, loads the
  `staff_users` row by `sub`, rejects with `401` when the token is missing/invalid/expired or the row
  is missing or inactive, then attaches `{ id, role }` to the request.
- `requireRole(...roles)`: `401` when no staff is attached, `403` for a role outside the list.
- Approve uses `requireStaff` + `requireRole("admin")`. List uses `requireStaff` +
  `requireRole("admin", "agent")`.
- Roles remain `admin` and `agent`; the `staff_users` role CHECK is not modified.
- Mounted at `/api`, **after** `express.json()`. The Stripe webhook stays mounted before
  `express.json()` so it keeps receiving the raw `Buffer` for signature verification.

### 1.4 Admin seed

| Item | Value |
| --- | --- |
| File | `src/db/seed-staff.ts` |
| Script | `npm run db:seed:staff` |
| Inputs | `ADMIN_EMAIL` (required), `ADMIN_PASSWORD` (required, minimum 12 characters), `ADMIN_NAME` (optional, default `Admin`) |
| Behaviour | `INSERT ... ON CONFLICT (email) DO NOTHING` — a second run is a no-op |
| Rotation | `--update-password` rewrites `password_hash` only; it does not change `role` or `active` (promoting an agent is a separate action) |
| Guard | Refuses to run when `DATABASE_URL` is missing, or when the database name is `legwork` and `ALLOW_SEED_ON_LEGWORK` is not `true` |
| Output | One line with the email and `created`/`unchanged`; never the password or hash |

Seed guard rule: the script always refuses to run against `legwork` unless
`ALLOW_SEED_ON_LEGWORK=true`. That override is never set in normal development or test runs; it exists
only for a deliberate, supervised production seed.

`ADMIN_EMAIL` must be added to `.env`; `ADMIN_PASSWORD` is already present.

## 2. Payment states

`payments.status` is exactly one of `succeeded`, `review_required`, `order_created`. There are no
refund columns and no `refund_pending`/`refunded` statuses.

| Transition | From → to | When | Guard | `pending_checkouts.status` |
| --- | --- | --- | --- | --- |
| T0 | (none) → `succeeded` | A paid Stripe event is handled | `INSERT ... ON CONFLICT (stripe_session_id) DO NOTHING` | unchanged |
| T1 | `succeeded` → `order_created` | Payment arrived before the deadline and amount/currency match the checkout snapshot | `UPDATE ... WHERE id = $1 AND status = 'succeeded'` | set to `paid`, from `open` or `expired` |
| T2 | `succeeded` → `review_required` | Payment arrived at or after the deadline, or amount/currency mismatch | `UPDATE ... WHERE id = $1 AND status = 'succeeded'` | unchanged |
| T3 | `review_required` → `order_created` | Admin approval | `UPDATE ... WHERE id = $1 AND status = 'review_required'` | unchanged; stays `expired` |

Deadline:

```
within_deadline  <=>  now() < pending_checkouts.expires_at + PAYMENT_REVIEW_GRACE_SECONDS
```

- `PAYMENT_REVIEW_GRACE_SECONDS` defaults to `300`, integer, bounded `0..3600` in `config.ts`.
- Boundary is strict: exactly `expires_at + grace` is late.
- Checked against the checkout row's `expires_at`, which is aligned with Stripe's returned
  `session.expires_at` when the session is created or reused.
- Sessions are requested with `expires_at = now + 31 minutes`, and the stored deadline is overwritten
  with Stripe's returned value. This **deliberately** widens the local payment window from the current
  30 minutes to about 31 minutes, so the app deadline and Stripe's session expiry agree.

Outcome reason codes: `late_payment`, `amount_mismatch`, `currency_mismatch`. Every applicable code is
recorded, so `audit_logs.metadata.reason` is a JSON array of codes (for example
`["late_payment", "amount_mismatch"]`), never free text.

Rules:

1. Payment within the deadline → order (`order_created`).
2. Late payment → `review_required`, no order, no refund, no refund workflow.
3. Only an authenticated `admin` may approve; agents and customers get `403`.
4. Approval creates the order exactly once.
5. Late money is never lost: the payment row is written before any deadline decision.
6. A successful within-grace payment (T1) sets `pending_checkouts.status = 'paid'` whether the
   checkout is `open` or `expired`. A staff-approved late payment (T3) leaves the checkout `expired`;
   the order is still created from that snapshot.

Approval columns on `payments`: `approved_by` (FK `staff_users`, `ON DELETE RESTRICT`), `approved_at`,
`approval_idempotency_key` (partial unique where not null). T1 leaves all three null because no human
approved it; only T3 fills them.

## 3. Webhook processing

Only paid `checkout.session.completed` events are handled. Signature verification still uses the raw
body.

### 3.1 Event claim

New table `stripe_webhook_events` (PK `event_id`).

| Situation | Action | HTTP |
| --- | --- | --- |
| Event id not seen | `INSERT ... ON CONFLICT DO NOTHING` succeeds | continue |
| Existing row `processed` | Acknowledge | `200 { received: true, duplicate: true }` |
| Existing row `processing` | First delivery may still be in flight or may have crashed | `503` so Stripe retries |
| Existing row `failed` | Reclaim with `UPDATE ... SET status='processing' WHERE event_id=$1 AND status='failed'` | continue if the update returns a row, otherwise `503` |
| Row disappears between insert and select | Treat as `processing` | `503` |

A duplicate is never answered with `200` while the first delivery is still in `processing`.

Stale recovery: `src/workers/index.ts` starts a repeatable sweep (same pattern as
`sweep-pending-scan`, every 5 minutes) that marks `processing` rows older than 10 minutes as
`failed` with `last_error = 'stale_processing'`. A later Stripe retry reclaims them.

`markEventProcessed` runs only after the business transaction commits. On failure,
`markEventFailed` stores a bounded code (`http_<status>` or `internal_error`) and increments
`attempt_count`; the handler then rethrows so Stripe sees a non-2xx and retries. No raw payload,
session id, or URL is stored or logged.

### 3.2 Record first, decide second

`src/modules/webhooks/service.ts` (`completePendingCheckout`) currently returns `409` for an expired
checkout at lines 61–85, **before** recording anything — that is the bug that loses late money. Those
branches are removed.

New order of operations, all in one transaction:

1. Look up the checkout by `stripe_session_id`. An unknown session is acknowledged, not retried: mark
   the event `processed` with `last_error = 'unknown_session'`, write an error-level log line (event id
   and reference only, never the payload), and return `200`.
2. T0: insert the payment as `succeeded` (`ON CONFLICT (stripe_session_id) DO NOTHING`, then re-select).
3. Replay: an existing `order_created` returns its order; an existing `review_required` returns that
   status. No second order.
4. Decide with `decidePaymentOutcome(...)` using the checkout row, the Stripe amount/currency, and the
   deadline.
5. T1: guarded update to `order_created`, set `pending_checkouts.status = 'paid'` whether the checkout
   is `open` or `expired`, then create the order inside the same transaction.
6. T2: guarded update to `review_required` plus an `audit_logs` row
   (`actor_type = 'system'`, `action = 'payment.review_required'`, reason codes in metadata).

Order creation is extracted into one helper used by T1 and T3, parameterised only on the
`order_events.actor_type` (`stripe` for T1, `staff` for T3). `orders.pending_checkout_id` is UNIQUE,
so the database also guarantees one order per checkout.

## 4. Approval API contract

`POST /api/staff/payments/:id/approve`

| Item | Value |
| --- | --- |
| Auth | `requireStaff` then `requireRole("admin")` |
| Headers | `Authorization: Bearer <token>`, `Idempotency-Key: <8–255 chars>` (required) |
| Body | `{ "note"?: string }`, max 500 chars, optional; the approver's free text only (reason codes are server-derived) |
| Success | `200 { paymentId, orderId, orderNumber, created }` |

| Case | Status | Body |
| --- | --- | --- |
| Missing/invalid/expired token, inactive staff | `401` | `Missing or invalid token` |
| Authenticated agent | `403` | `Forbidden` |
| Missing or blank `Idempotency-Key` | `400` | `Idempotency-Key header is required` |
| Unknown payment id | `404` | `Payment not found` |
| Payment not in `review_required` (e.g. `succeeded`) | `409` | `Payment is not awaiting review` |
| Already approved with a different key | `409` | `Payment has already been approved` |
| `Idempotency-Key` already used by a different payment | `409` | `Idempotency-Key already used` |
| Replay with the same key | `200` | Original result, `created: false` |
| Non-uuid path param | `400` | Validation error |

One transaction:

1. Guarded `UPDATE payments SET status='order_created', approved_by, approved_at,
   approval_idempotency_key WHERE id=$1 AND status='review_required'`.
2. If the update violates the partial unique index on `approval_idempotency_key` (PostgreSQL `23505`)
   because another payment already used that key, map it to `409` (`Idempotency-Key already used`) —
   never a `500`.
3. If 0 rows: load the payment.
   - Missing → `404`.
   - `order_created` and `approval_idempotency_key` equals the request key → return the original
     `{ paymentId, orderId, orderNumber, created: false }`.
   - `order_created` with a different key → `409`.
   - Anything else → `409`.
4. On success: load the `pending_checkouts` row and create the order from **that snapshot**
   (amount/currency never come from the request body or the payment row).
5. Insert `audit_logs`: `actor_type = 'staff'`, `actor_id` = approving staff id,
   `action = 'payment.approved'`, `entity_type = 'payment'`, `entity_id` = payment id,
   `metadata = { previous_status: 'review_required', new_status: 'order_created', reason: ReasonCode[], note, idempotency_key }`.

`reason` is the array of codes that sent the payment to review (recomputed with the same decision
function at approval time); `note` is the approver's optional free text from the request body. Free
text is never stored in `reason`.

Exactly-once is enforced by the guarded update and by `orders.pending_checkout_id UNIQUE`. Two
concurrent requests with the same key: one wins, the other sees `order_created` and returns the same
`200`. Two different keys: the loser gets `409`.

Idempotency storage is `payments.approval_idempotency_key` (partial unique index). There is no
`idempotency_keys` table, and `audit_logs` is not used for idempotency.

## 5. List endpoint

`GET /api/staff/payments`

| Item | Value |
| --- | --- |
| Auth | `requireStaff` + `requireRole("admin", "agent")` — both roles may read |
| Query `status` | Optional; one of `succeeded`, `review_required`, `order_created` |
| Query `limit` | Optional, default `25`, range `1..100` |
| Query `offset` | Optional, default `0`, minimum `0` |
| Ordering | `created_at DESC`, then `id DESC` as a stable tiebreaker |
| Response | `{ payments: [...], total, limit, offset }` |

Each item: `id`, `pendingCheckoutId`, `reference` (from the `pending_checkouts` join), `amountCents`,
`currency`, `status`, `paidAt`, `createdAt`, `approvedBy`, `approvedAt`.

`total` is the count matching the same filter, so the client can page. Offset pagination is chosen
for the MVP because the review queue is small; no cursor is exposed. Errors: `401` without a valid
token, `400` for an invalid `status`/`limit`/`offset`. Approve remains admin-only; listing does not
imply approval rights.

## 6. Known risks

- **MFA is excluded from the MVP.** `staff_users.mfa_enabled` and `mfa_secret_enc` exist but this
  change ignores them; an admin account is protected by password plus JWT only.
- **Non-card compatibility window.** `payments.payment_method_type` is constrained to `'card'`, and
  new sessions request `payment_method_types: ["card"]`. Sessions created before that change carry no
  explicit method list, so a non-card payment from one of those sessions would fail the CHECK and
  produce a `500` with no recorded payment. The window closes once all pre-change sessions expire.
- **Login rate limiting is required before go-live.** No rate limiter exists in the app today; the
  staff login route ships without one. Add per-IP and per-email throttling before production.
- Late payments are kept, never refunded; there is no refund workflow in the MVP and no refund
  columns.
- **Unknown Stripe sessions are acknowledged.** An event for a `stripe_session_id` we never stored
  returns `200`, marks the event `processed` with `last_error = 'unknown_session'`, and writes an
  error-level log line. It is not retried, so a misrouted or test-mode event cannot loop for days.

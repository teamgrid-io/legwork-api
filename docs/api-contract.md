# Traveller API contract

Base URL: `/api/v1` (for example `https://<host>/api/v1`). Every endpoint below is relative to that prefix.

## Error shape

All errors return JSON in this shape:

```json
{ "error": "Applicant not found", "code": "http_error" }
```

`code` is one of:

- `http_error` — an expected request failure (most 4xx responses)
- `validation_error` — invalid or malformed request data
- `not_found` — unknown route, or an endpoint disabled in this environment
- `internal_error` — unexpected server failure (`500`)

## Notes

- `POST /requests` does not accept amounts, fees, or status. The server reads the active visa product and calculates the total. Unknown body fields are rejected.
- `GET /payments/verify` reports the stored checkout status only. It does not contact the payment provider and does not confirm payment by itself. Payment is confirmed by the payment webhook.

---

## 1. GET /countries

Purpose: List the countries known to the catalogue.

- **Auth:** none
- **Request:** no path params, query params, or body.

**Success — 200**

```json
[
  { "iso2": "AE", "name": "United Arab Emirates", "slug": "united-arab-emirates" },
  { "iso2": "GE", "name": "Georgia", "slug": "georgia" },
  { "iso2": "IN", "name": "India", "slug": "india" },
  { "iso2": "MY", "name": "Malaysia", "slug": "malaysia" },
  { "iso2": "TZ", "name": "Tanzania", "slug": "tanzania" }
]
```

Sorted by `name`.

**Errors**

| Status | Message | Code |
| --- | --- | --- |
| 500 | Something went wrong | `internal_error` |

---

## 2. GET /products/:iso2

Purpose: List the active visa products for a destination country.

- **Auth:** none

**Request**

| Location | Field | Type | Required | Notes |
| --- | --- | --- | --- | --- |
| Path | `iso2` | string | yes | Destination country code. Case-insensitive; uppercased by the server. |

**Success — 200**

```json
[
  {
    "id": "3f0c9a4e-6f2b-4c1d-9a77-2b1e5d8c4a10",
    "name": "Georgia e-visa: Complete Application",
    "visaType": "single_entry",
    "stayDays": 90,
    "processingDaysMin": 3,
    "processingDaysMax": 5,
    "requiredDocuments": [],
    "governmentFeeCents": 2000,
    "legworkFeeCents": 3500,
    "totalPerTravellerCents": 5500,
    "currency": "USD"
  }
]
```

`stayDays` may be `null`. Returns an empty array when the country exists but has no active product.

**Errors**

| Status | Message | Code |
| --- | --- | --- |
| 404 | Country not found | `http_error` |
| 500 | Something went wrong | `internal_error` |

---

## 3. GET /visa-check

Purpose: Look up the visa rule for a passport/destination pair.

- **Auth:** none

**Request**

| Location | Field | Type | Required | Notes |
| --- | --- | --- | --- | --- |
| Query | `passport` | string | yes | 2-letter country code. Case-insensitive. |
| Query | `destination` | string | yes | 2-letter country code. Case-insensitive. |

**Success — 200**

```json
{
  "status": "visa_required",
  "notes": null,
  "product": {
    "visaType": "single_entry",
    "stayDays": 90,
    "processingDaysMin": 3,
    "processingDaysMax": 5,
    "requiredDocuments": [],
    "totalPerTravellerCents": 5500,
    "currency": "USD"
  }
}
```

`status` is one of:

- `visa_required` — `product` is the active product, or `null` when none exists
- `visa_free` — returns `{ "status": "visa_free", "notes": ... }`
- `unknown` — returns `{ "status": "unknown", "message": "Contact us to confirm" }`

`notes` may be `null`.

**Errors**

| Status | Message | Code |
| --- | --- | --- |
| 400 | Invalid request data | `validation_error` |
| 404 | Country not found | `http_error` |
| 500 | Something went wrong | `internal_error` |

---

## 4. POST /requests

Purpose: Create a pending checkout from the basic traveller details.

- **Auth:** none

**Request body** (`application/json`)

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `destinationIso2` | string | yes | 2-letter country code. Case-insensitive. |
| `passportIso2` | string | yes | 2-letter country code. Case-insensitive. |
| `travelDate` | string | yes | `YYYY-MM-DD`; must be in the future. |
| `contactEmail` | string | yes | Valid email; trimmed and lowercased. |
| `contactPhone` | string | no | Max 30 characters; trimmed. |
| `applicants` | array | yes | 1 to 2 applicants. |
| `applicants[].fullName` | string | yes | 2 to 120 characters; trimmed. |
| `applicants[].dateOfBirth` | string | no | `YYYY-MM-DD`. |
| `applicants[].nationalityIso2` | string | no | 2-letter country code. |
| `applicants[].gender` | string | yes | `male`, `female`, or `other`. |
| `applicants[].maritalStatus` | string | yes | `single`, `married`, `divorced`, or `widowed`. |

The body is strict: extra fields are rejected. Amounts, fees, and status are not accepted.

```json
{
  "destinationIso2": "GE",
  "passportIso2": "IN",
  "travelDate": "2027-06-01",
  "contactEmail": "traveller@example.com",
  "contactPhone": "+91 98765 43210",
  "applicants": [
    {
      "fullName": "Asha Sharma",
      "dateOfBirth": "1992-04-18",
      "nationalityIso2": "IN",
      "gender": "female",
      "maritalStatus": "married"
    }
  ]
}
```

**Success — 201**

```json
{
  "id": "9c2f7d1a-5b3e-4a8f-8c21-6d4b0e9a7f35",
  "reference": "PC-7K3Q9",
  "amountCents": 5500,
  "currency": "USD"
}
```

`id` is the pending checkout id used by the checkout endpoint.

**Errors**

| Status | Message | Code |
| --- | --- | --- |
| 400 | Invalid request data | `validation_error` |
| 400 | travelDate must be in the future | `http_error` |
| 400 | Visa product amount must be greater than zero | `http_error` |
| 404 | Country not found | `http_error` |
| 404 | No visa product for this destination | `http_error` |
| 500 | Something went wrong | `internal_error` |

---

## 5. POST /requests/:id/checkout

Purpose: Create a payment checkout session for a pending request.

- **Auth:** none

**Request**

| Location | Field | Type | Required | Notes |
| --- | --- | --- | --- | --- |
| Path | `id` | string (UUID) | yes | The `id` returned by `POST /requests`. |

No body.

**Success — 200**

```json
{ "url": "https://app.example.com/thank-you?session_id=dummy_0f1e2d3c-4b5a-6978-8c9d-0e1f2a3b4c5d" }
```

**Errors**

| Status | Message | Code |
| --- | --- | --- |
| 400 | Invalid request data | `validation_error` |
| 404 | Pending checkout not found | `http_error` |
| 409 | Checkout is already paid | `http_error` |
| 409 | Checkout has expired | `http_error` |
| 500 | Something went wrong | `internal_error` |

---

## 6. POST /webhooks/dummy-payment

Purpose: Mark a dummy checkout as paid and create the order. **DEV ONLY — disabled in production.**

- **Auth:** none
- **Availability:** only when `PAYMENT_PROVIDER=dummy` and `NODE_ENV` is not `production`. Otherwise it responds as an unknown route.

**Request body** (`application/json`)

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `sessionId` | string | yes | Non-empty. The `session_id` from the dummy checkout URL. |

```json
{ "sessionId": "dummy_0f1e2d3c-4b5a-6978-8c9d-0e1f2a3b4c5d" }
```

**Success — 200**

```json
{ "orderNumber": "VISA-2026-004281", "created": true }
```

`created` is `false` when the checkout was already completed and the existing order is returned.

**Errors**

| Status | Message | Code |
| --- | --- | --- |
| 400 | Invalid request data | `validation_error` |
| 404 | Not found | `not_found` |
| 404 | Unknown payment session | `http_error` |
| 409 | Checkout expired | `http_error` |
| 500 | Something went wrong | `internal_error` |

---

## 7. GET /payments/verify

Purpose: Read the stored status of a checkout by its payment session id.

- **Auth:** none

**Request**

| Location | Field | Type | Required | Notes |
| --- | --- | --- | --- | --- |
| Query | `session_id` | string | yes | Must be a single string value. |

**Success — 200**

```json
{ "reference": "PC-7K3Q9", "paid": true, "status": "paid" }
```

`status` is one of `open`, `paid`, or `expired`. `paid` is `true` only when `status` is `paid`.

This endpoint is read-only: it does not contact the payment provider and does not confirm payment.

**Errors**

| Status | Message | Code |
| --- | --- | --- |
| 400 | session_id is required | `http_error` |
| 404 | Unknown payment session | `http_error` |
| 500 | Something went wrong | `internal_error` |

---

## 8. GET /visaProducts/:visaProductId/form

Purpose: Return the visible full-details form fields for a visa product, grouped by section.

- **Auth:** none

**Request**

| Location | Field | Type | Required | Notes |
| --- | --- | --- | --- | --- |
| Path | `visaProductId` | string | yes | The product `id` from `GET /products/:iso2`. |
| Query | `answers` | string | no | A JSON object, URL-encoded, used to evaluate conditional visibility. Defaults to `{}`. |

The `answers` JSON object accepts values of type string, number, boolean, null, or string array. It is not the saved applicant state; it only affects which conditional fields are returned.

Example query:

```text
?answers=%7B%22purpose%22%3A%22tourism%22%7D
```

**Success — 200**

```json
[]
```

The seeded pilot currently has no full-details fields, so the response is empty. Once fields are seeded, the response is an array of groups:

```json
[
  {
    "groupKey": "personal",
    "fields": [
      {
        "fieldKey": "passport_number",
        "label": "Passport number",
        "fieldType": "text",
        "required": true,
        "options": null,
        "sortOrder": 1
      }
    ]
  }
]
```

`fieldType` is one of `text`, `email`, `phone`, `date`, `select`, `radio`, `checkbox`, or `country`. `options` is field-specific (for example a string array for `select`/`radio`) and may be `null`.

**Errors**

| Status | Message | Code |
| --- | --- | --- |
| 400 | visaProductId is required | `http_error` |
| 400 | answers must be valid JSON | `http_error` |
| 400 | Invalid request data | `validation_error` |
| 404 | Visa product not found | `http_error` |
| 500 | Something went wrong | `internal_error` |

---

## 9. PUT /applicants/:applicantId/answers

Purpose: Save full-details answers for one applicant.

- **Auth:** `x-applicant-token` header (required)

**Request**

| Location | Field | Type | Required | Notes |
| --- | --- | --- | --- | --- |
| Path | `applicantId` | string (UUID) | yes | The applicant id. |
| Header | `x-applicant-token` | string | yes | Access token for this applicant. Missing or invalid returns `401`. |
| Body | `answers` | object | yes | Map of form field key to answer value. |

Each answer value must be one of: string, string array, boolean, number, or null. The body is strict and accepts only the `answers` key.

```json
{
  "answers": {
    "passport_number": "M1234567",
    "arrival_date": "2027-06-01",
    "purpose": "tourism"
  }
}
```

Values are validated against the seeded field definitions: type, allowed options, and conditional visibility. `passport_number` is stored encrypted.

**Success — 200**

```json
{
  "applicantId": "b6d1f0c2-8a4e-4f39-9c7d-1e2a3b4c5d6e",
  "savedFields": ["passport_number", "arrival_date", "purpose"]
}
```

**Errors**

| Status | Message | Code |
| --- | --- | --- |
| 400 | Invalid request data | `validation_error` |
| 400 | Unknown field: `<key>` | `http_error` |
| 400 | Field not visible: `<key>` | `http_error` |
| 400 | Invalid value for field: `<key>` | `http_error` |
| 401 | Invalid access token | `http_error` |
| 404 | Applicant not found | `http_error` |
| 409 | Application is locked | `http_error` |
| 500 | Something went wrong | `internal_error` |

---

## 10. POST /applicants/:applicantId/documents

Purpose: Upload one required document for an applicant.

- **Auth:** `x-applicant-token` header (required)

**Request** (`multipart/form-data`)

| Part | Type | Required | Notes |
| --- | --- | --- | --- |
| `documentType` | text | yes | `applicant_photo`, `passport_scan`, or `return_ticket`. The type must also be in the product's required documents. |
| `file` | file | yes | Exactly one file. Max 5 MB. Real content must be JPEG, PNG, or PDF and must match the declared `Content-Type`. |

- Allowed MIME types: `image/jpeg`, `image/png`, `application/pdf`.
- JPEG, PNG, and PDF are detected from magic bytes; the declared type is not trusted.
- A file for a type that already has an `accepted` document is rejected. `uploaded` and `needs_fix` documents are replaced.
- Only one current file per document type is kept.

The seeded products currently list no required documents, so uploads return `Document not required for this destination` until a product's required documents are configured.

**Success — 201**

```json
{
  "documentId": "d2e4f6a8-1b3c-4d5e-8f90-1a2b3c4d5e6f",
  "documentType": "passport_scan",
  "status": "uploaded"
}
```

**Errors**

| Status | Message | Code |
| --- | --- | --- |
| 400 | Invalid request data | `validation_error` |
| 400 | Unknown document type | `http_error` |
| 400 | Document not required for this destination | `http_error` |
| 400 | Invalid file size | `http_error` |
| 400 | File type not allowed | `http_error` |
| 400 | File is required | `http_error` |
| 401 | Invalid access token | `http_error` |
| 404 | Applicant not found | `http_error` |
| 409 | Application is locked | `http_error` |
| 409 | A verified document of this type already exists | `http_error` |
| 500 | Something went wrong | `internal_error` |

The multipart parser enforces the 5 MB limit before the controller runs.

---

## 11. POST /applicants/:applicantId/submit

Purpose: Submit the applicant's completed full-details application.

- **Auth:** `x-applicant-token` header (required)

**Request**

| Location | Field | Type | Required | Notes |
| --- | --- | --- | --- | --- |
| Path | `applicantId` | string (UUID) | yes | The applicant id. |
| Header | `x-applicant-token` | string | yes | Access token for this applicant. Missing or invalid returns `401`. |

No body.

A required document counts when the applicant has a document of that type with status `uploaded` or `accepted`. Documents with status `needs_fix` or `rejected` do not count.

**Success — 200**

```json
{
  "applicantId": "b6d1f0c2-8a4e-4f39-9c7d-1e2a3b4c5d6e",
  "status": "complete",
  "submittedAt": "2026-11-10T12:34:56.789Z"
}
```

**Errors**

| Status | Message | Code |
| --- | --- | --- |
| 400 | Invalid request data | `validation_error` |
| 400 | Missing required answers: `<keys>` | `http_error` |
| 400 | Missing required documents: `<types>` | `http_error` |
| 401 | Invalid access token | `http_error` |
| 404 | Applicant not found | `http_error` |
| 409 | Application is locked | `http_error` |
| 500 | Something went wrong | `internal_error` |

---

## Not yet available

- **Full-details question list:** not seeded. `GET /visaProducts/:visaProductId/form` returns an empty array for the seeded products until `form_fields` are added.
- **Real Stripe:** not implemented in the pilot; only the dummy payment provider is available.
- **Emailed traveller link:** no endpoint issues or emails the `x-applicant-token`. The token helper is dev-only.
- **Staff endpoints:** not available in this API yet.

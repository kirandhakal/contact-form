# Universal Contact Form Backend

**Status:** Working MVP  
**Stack:** TypeScript, nest.js, express, PostgreSQL , graphql  
**Purpose:** One reusable backend for contact forms hosted on many frontend-only websites.

---

## 1. Problem

Static websites need a backend only to receive and deliver form data. Creating a separate backend for every website causes duplicated code, maintenance, security, and hosting costs.

This project provides one backend where:

- Many websites can create independent forms.
- Every form has its own public key and allowed website origins.
- Fields are defined using JSON Schema.
- Text, email, number, checkbox, radio, select, date, and URL values are supported.
- Submissions can be delivered by email or signed webhook.
- Form data is retained only for a configured period.

## 2. MVP Scope

### Included

- Multi-tenant form storage
- Versioned form definitions
- Public form-schema endpoint
- Public submission endpoint
- Admin form-creation endpoint
- Admin submission-list endpoint
- Exact origin allowlist
- JSON Schema validation
- Request-size limit
- Per-form/IP rate limiting
- Honeypot spam detection
- Idempotency support
- PostgreSQL transactional outbox
- Email delivery
- HMAC-signed webhook delivery
- Retry and dead-letter handling
- Submission expiration cleanup
- Health endpoints
- Automated API tests
- Docker Compose development environment
- Plain JavaScript frontend example
-rate limiting and throtting

### Not included in the MVP

- User registration and billing
- Visual drag-and-drop form builder
- File uploads
- CAPTCHA provider integration
- Analytics dashboard
- Custom domains
- Full tenant OIDC/RBAC system
- Redis-based distributed rate limiting

## 3. Architecture

```mermaid
flowchart TD
    A[Static websites] --> B[Fastify API]
    C[Admin client] --> B
    B --> D[(PostgreSQL)]
    D --> E[Outbox worker]
    E --> F[Email server]
    E --> G[Customer webhook]
```

### Components

1. **API service**
   - Creates forms.
   - Returns public form definitions.
   - Validates and stores submissions.
   - Provides protected administration endpoints.

2. **PostgreSQL**
   - Stores tenants, forms, versions, destinations, submissions, and delivery jobs.
   - Commits a submission and its delivery jobs in one transaction.

3. **Worker**
   - Claims queued jobs using `FOR UPDATE SKIP LOCKED`.
   - Sends emails or signed webhooks.
   - Retries temporary failures.
   - Moves exhausted jobs to the `dead` state.
   - Deletes expired submissions daily.

## 4. Project Structure

```text
universal-contact-form-backend/
├── examples/
│   └── contact-form.html
├── migrations/
│   └── 001_initial.sql
├── src/
│   ├── db/
│   │   ├── migrate.ts
│   │   └── postgres-store.ts
│   ├── app.ts
│   ├── config.ts
│   ├── delivery.ts
│   ├── rate-limit.ts
│   ├── security.ts
│   ├── server.ts
│   ├── types.ts
│   └── worker.ts
├── tests/
│   └── app.test.ts
├── .env.example
├── .gitignore
├── docker-compose.yml
├── package.json
├── package-lock.json
├── README.md
└── tsconfig.json
```

## 5. Technology Choices

| Area | Selection | Reason |
|---|---|---|
| Runtime | Node.js 22+ | Modern JavaScript runtime with native `fetch` |
| Language | TypeScript | Static typing and maintainability |
| HTTP framework | Fastify | Validation support and low overhead |
| Database | PostgreSQL | Transactions, JSONB, arrays, and row locking |
| Form validation | JSON Schema 2020-12 + AJV | Standard, reusable form definitions |
| Configuration validation | Zod | Typed startup configuration |
| Email | Nodemailer 10 | SMTP delivery |
| Queue | PostgreSQL outbox | Reliable MVP without a separate queue service |
| Testing | Vitest + Fastify injection | Fast API-level tests |

## 6. Data Model

### `tenants`

| Column | Purpose |
|---|---|
| `id` | Tenant UUID |
| `name` | Tenant name |
| `created_at` | Creation time |

### `forms`

| Column | Purpose |
|---|---|
| `id` | Internal form UUID |
| `tenant_id` | Owning tenant |
| `public_key` | Public identifier used by frontend websites |
| `status` | `active` or `disabled` |
| `allowed_origins` | Exact website origins allowed to submit |
| `success_message` | Message returned after submission |
| `honeypot_field` | Hidden spam-detection field |

### `form_versions`

| Column | Purpose |
|---|---|
| `form_id` | Parent form |
| `version` | Incrementing definition version |
| `schema` | JSON Schema stored as JSONB |

Existing submissions retain the form-version number used during validation.

### `destinations`

| Column | Purpose |
|---|---|
| `form_id` | Parent form |
| `kind` | `email` or `webhook` |
| `config` | Destination settings |
| `secret` | Webhook signing secret |
| `active` | Delivery enabled/disabled |

### `submissions`

| Column | Purpose |
|---|---|
| `tenant_id` | Tenant isolation reference |
| `form_id` | Submitted form |
| `form_version` | Definition used for validation |
| `payload` | Validated JSON data |
| `status` | `accepted`, `spam`, or `deleted` |
| `source_origin` | Browser origin |
| `source_ip_hash` | HMAC hash of source IP |
| `idempotency_key` | Duplicate-request protection |
| `expires_at` | Data deletion deadline |

### `outbox_jobs`

| Column | Purpose |
|---|---|
| `submission_id` | Submission to deliver |
| `destination_id` | Delivery target |
| `status` | `pending`, `processing`, `delivered`, `failed`, or `dead` |
| `attempts` | Delivery attempt count |
| `available_at` | Next permitted retry time |
| `last_error` | Truncated failure detail |

## 7. API Endpoints

| Method | Endpoint | Access | Purpose |
|---|---|---|---|
| `GET` | `/health/live` | Public | Process health |
| `GET` | `/health/ready` | Public | Database readiness |
| `POST` | `/v1/admin/forms` | Admin bearer key | Create tenant and form |
| `GET` | `/v1/forms/:publicKey` | Allowed origin | Retrieve public schema |
| `POST` | `/v1/forms/:publicKey/submissions` | Allowed origin | Submit form data |
| `GET` | `/v1/admin/forms/:publicKey/submissions` | Admin bearer key | List recent submissions |

## 8. Environment Variables

```env
NODE_ENV=development
HOST=0.0.0.0
PORT=3000
DATABASE_URL=postgres://forms:forms@localhost:5432/forms
ADMIN_API_KEY=replace-with-at-least-24-random-characters
DATA_ENCRYPTION_KEY=replace-with-64-hex-characters
PUBLIC_BASE_URL=http://localhost:3000
MAX_BODY_BYTES=65536
RATE_LIMIT_WINDOW_SECONDS=60
RATE_LIMIT_MAX=20
RETENTION_DAYS=90
WORKER_POLL_MS=1000
SMTP_URL=
EMAIL_FROM=forms@example.com
WEBHOOK_TIMEOUT_MS=5000
```

### Important secrets

- `ADMIN_API_KEY`: at least 24 random characters.
- `DATA_ENCRYPTION_KEY`: exactly 64 hexadecimal characters.
- `SMTP_URL`: SMTP credentials; keep outside source control.
- Webhook secrets: unique random value for each destination.

## 9. Local Installation

### Requirements

- Node.js 22 or later
- npm
- Docker with Docker Compose

### Commands

```bash
cp .env.example .env
```

Replace the example secrets in `.env`, then run:

```bash
docker compose up -d postgres
npm install
npm run migrate
npm run dev
```

Start the worker in another terminal:

```bash
npm run worker
```

Default API address:

```text
http://localhost:3000
```

## 10. Create a Form

```bash
curl -X POST http://localhost:3000/v1/admin/forms \
  -H 'Authorization: Bearer YOUR_ADMIN_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{
    "tenantName": "Acme",
    "name": "Website contact",
    "allowedOrigins": ["https://www.example.com"],
    "successMessage": "Thank you. We received your message.",
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "required": ["name", "email", "topic"],
      "properties": {
        "name": {
          "type": "string",
          "minLength": 2,
          "maxLength": 100
        },
        "email": {
          "type": "string",
          "format": "email",
          "maxLength": 254
        },
        "topic": {
          "type": "string",
          "enum": ["sales", "support", "feedback"]
        },
        "message": {
          "type": "string",
          "maxLength": 2000
        },
        "subscribe": {
          "type": "boolean"
        }
      }
    },
    "destinations": [
      {
        "kind": "email",
        "config": {
          "to": "team@example.com",
          "subject": "New website message"
        }
      },
      {
        "kind": "webhook",
        "config": {
          "url": "https://hooks.example.com/forms"
        },
        "secret": "replace-with-24-or-more-random-characters"
      }
    ]
  }'
```

Example response:

```json
{
  "id": "019...",
  "publicKey": "frm_...",
  "submitUrl": "http://localhost:3000/v1/forms/frm_.../submissions"
}
```

## 11. Supported Form Fields

### Text

```json
{
  "fullName": {
    "type": "string",
    "minLength": 2,
    "maxLength": 100
  }
}
```

### Email

```json
{
  "email": {
    "type": "string",
    "format": "email",
    "maxLength": 254
  }
}
```

### Radio or select options

Both controls submit one enum value:

```json
{
  "department": {
    "type": "string",
    "enum": ["sales", "support", "billing"]
  }
}
```

### Checkbox

```json
{
  "acceptTerms": {
    "type": "boolean"
  }
}
```

### Number

```json
{
  "quantity": {
    "type": "number"
  }
}
```

### Date

```json
{
  "preferredDate": {
    "type": "string",
    "format": "date"
  }
}
```

## 12. Frontend Integration

```html
<form id="contact-form">
  <label>
    Email
    <input name="email" type="email" required maxlength="254">
  </label>

  <fieldset>
    <legend>Topic</legend>
    <label><input name="topic" type="radio" value="sales" required> Sales</label>
    <label><input name="topic" type="radio" value="support"> Support</label>
  </fieldset>

  <label>
    Message
    <textarea name="message" maxlength="2000"></textarea>
  </label>

  <label hidden>
    Website
    <input name="_website" tabindex="-1" autocomplete="off">
  </label>

  <button type="submit">Send</button>
  <p id="result" role="status" aria-live="polite"></p>
</form>

<script>
  const endpoint = 'https://api.example.com/v1/forms/REPLACE_PUBLIC_KEY/submissions';
  const form = document.querySelector('#contact-form');
  const result = document.querySelector('#result');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    result.textContent = 'Sending…';

    const data = Object.fromEntries(new FormData(form));

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': crypto.randomUUID()
        },
        body: JSON.stringify(data)
      });

      const body = await response.json();
      if (!response.ok) throw new Error(body.detail || 'Submission failed');

      result.textContent = body.message;
      form.reset();
    } catch (error) {
      result.textContent = error.message;
    }
  });
</script>
```

## 13. Submission Request

```http
POST /v1/forms/frm_example/submissions
Origin: https://www.example.com
Content-Type: application/json
Idempotency-Key: 765b53ce-813e-4512-ab33-f66b65d240ba
```

```json
{
  "name": "Example User",
  "email": "user@example.com",
  "topic": "support",
  "message": "Please contact me."
}
```

Successful response:

```json
{
  "id": "submission-uuid",
  "status": "accepted",
  "duplicate": false,
  "message": "Thank you. We received your message."
}
```

The normal status code is `202 Accepted`. A repeated idempotent request returns `200 OK` and `duplicate: true`.

## 14. Validation Errors

Errors use an RFC 9457-style problem structure:

```json
{
  "type": "about:blank",
  "title": "Validation failed",
  "status": 422,
  "detail": "Submission fields are invalid.",
  "errors": [
    {
      "path": "/email",
      "message": "must match format email",
      "keyword": "format"
    }
  ]
}
```

### Main status codes

| Code | Meaning |
|---|---|
| `200` | Duplicate submission already accepted |
| `201` | Form created |
| `202` | New submission accepted |
| `400` | Malformed request or invalid idempotency key |
| `401` | Missing or invalid admin token |
| `403` | Origin not allowed |
| `404` | Form not found or disabled |
| `413` | Request body too large |
| `422` | Schema validation failed |
| `429` | Rate limit exceeded |
| `500` | Internal error |
| `503` | Database not ready |

## 15. Delivery Process

### Transactional outbox

1. API validates the form payload.
2. API opens a database transaction.
3. Submission is inserted.
4. One outbox job is inserted for every active destination.
5. The transaction commits.
6. API returns `202`.
7. Worker claims and delivers each job.

This design avoids storing a submission without creating its delivery jobs.

### Retry policy

- Maximum attempts: 8
- Backoff: exponential
- Initial delay: approximately 10 seconds after the first failure
- Maximum delay: 1 hour
- Exhausted job status: `dead`

## 16. Signed Webhooks

Webhook body:

```json
{
  "id": "submission-uuid",
  "type": "form.submission.created",
  "createdAt": "2026-09-05T00:00:00.000Z",
  "form": {
    "id": "form-uuid",
    "name": "Website contact"
  },
  "data": {
    "email": "user@example.com",
    "topic": "support"
  }
}
```

Headers:

```text
X-Forms-Timestamp: 1788566400
X-Forms-Signature: v1=<hex-hmac-sha256>
```

Signature input:

```text
timestamp + "." + raw_request_body
```

Receiver verification steps:

1. Read the raw body without changing whitespace.
2. Reject an old timestamp, normally older than five minutes.
3. Calculate HMAC-SHA256 using the shared secret.
4. Compare signatures using constant-time comparison.
5. Deduplicate events using the submission ID.

## 17. Security Controls

### Implemented

- Exact HTTP/HTTPS origin comparison
- CORS headers
- Admin bearer-key comparison using constant-time logic
- Maximum request-body size
- Strict form-definition validation
- JSON Schema payload validation
- Additional fields rejected by schema
- Per-form/IP fixed-window rate limiting
- HMAC-hashed source IP storage
- Honeypot spam detection
- Idempotency-key validation
- HTTP security headers
- HTTPS-only webhook URLs
- Obvious localhost and literal-IP webhook blocking
- Webhook redirects disabled
- Webhook request timeout
- Webhook HMAC signatures
- Email subject CR/LF removal
- Submission expiration timestamps
- Dependency audit with zero known vulnerabilities at verification time

### Important production additions

- Replace the single admin key with OIDC authentication.
- Add tenant-scoped RBAC.
- Use Redis or gateway-based distributed rate limiting for multiple API replicas.
- Add CAPTCHA or challenge verification after abuse thresholds.
- Resolve webhook DNS and reject private, loopback, link-local, and metadata-service addresses.
- Revalidate DNS immediately before connection.
- Encrypt sensitive destination configuration at field level.
- Use a secret manager and automated secret rotation.
- Add immutable audit logs for administrative operations.
- Add backup encryption and restore testing.
- Restrict worker outbound network access.
- Add database row-level security as defense in depth.

## 18. Privacy and Retention

- Default retention period: 90 days.
- Every submission receives an `expires_at` value.
- Worker deletes expired submissions once daily.
- Source IP is stored as an HMAC hash, not raw text.
- Collect only fields required for the form purpose.
- Publish a privacy notice on every frontend form.
- Define controller/processor responsibilities before offering the service to customers.
- Record deletion and backup-retention procedures.
- Add export and erasure workflows before a public SaaS launch.

## 19. Testing

Run:

```bash
npm test
npm run typecheck
npm run build
npm audit --omit=dev
```

Current automated tests cover:

- Admin form creation
- Valid public submission
- Disallowed origin rejection
- Invalid field rejection
- Idempotent retry behavior
- Honeypot spam classification

Verified implementation result:

- API tests: 3 passed
- TypeScript type-check: passed
- Production build: passed
- Dependency audit: 0 known vulnerabilities at verification time

## 20. Deployment Checklist

### Infrastructure

- [ ] Managed PostgreSQL configured
- [ ] Database TLS enabled
- [ ] API deployed with HTTPS
- [ ] Worker deployed separately
- [ ] Database migrations run once
- [ ] Secrets stored outside container images
- [ ] SMTP or webhook destination tested
- [ ] API and worker health monitoring enabled
- [ ] Backups configured
- [ ] Restore procedure tested

### Security

- [ ] Strong admin key or OIDC configured
- [ ] Exact allowed origins reviewed
- [ ] Reverse-proxy trusted-IP configuration reviewed
- [ ] Production rate limiter configured
- [ ] CAPTCHA escalation configured where required
- [ ] Webhook egress restrictions configured
- [ ] Secrets rotation process documented
- [ ] Logs checked for personal data leakage
- [ ] Dependency scanning enabled in CI

### Operations

- [ ] API error-rate alert configured
- [ ] Queue age alert configured
- [ ] Dead-letter job alert configured
- [ ] Database connection alert configured
- [ ] SMTP/webhook delivery alert configured
- [ ] Retention cleanup monitored
- [ ] Incident-response owner assigned

## 21. Recommended Production Metrics

- HTTP request count by route and status group
- Submission acceptance and rejection count
- Validation failure count
- Rate-limit rejection count
- Spam classification count
- Outbox pending-job count
- Oldest pending-job age
- Delivery success/failure count by destination type
- Dead-letter count
- API latency percentiles
- Database query latency
- Worker processing duration
- Expired-row deletion count

Avoid using tenant IDs, form IDs, email addresses, or public keys as high-cardinality metric labels.

## 22. CI Pipeline

Recommended pull-request checks:

```yaml
steps:
  - npm ci
  - npm run typecheck
  - npm test
  - npm run build
  - npm audit --omit=dev
```

Recommended deployment order:

1. Build immutable container image.
2. Scan dependencies and image.
3. Back up the database when required.
4. Run forward-compatible migrations.
5. Deploy API.
6. Deploy worker.
7. Run health and submission smoke tests.
8. Monitor errors and queue age.

## 23. Scaling Path

### Phase 1 — MVP

- One API instance
- One worker
- PostgreSQL outbox
- In-memory rate limiter

### Phase 2 — Multi-instance

- Multiple API replicas
- Multiple workers
- Redis or API-gateway rate limiting
- Managed PostgreSQL with connection pooling
- Centralized logs and metrics

### Phase 3 — SaaS platform

- OIDC authentication
- Tenant RBAC
- Self-service form management
- Billing and quotas
- Audit logs
- Dashboard and exports
- Regional storage options
- Data-subject request workflows

## 24. Implementation Roadmap

| Phase | Work | Estimated effort |
|---|---|---|
| 0 | Product decisions, threat model, data classification | 2–3 days |
| 1 | API, schema validation, database migration | 1–2 weeks |
| 2 | Email/webhook outbox and retries | 1 week |
| 3 | Spam controls and operational limits | 1 week |
| 4 | Tenant authentication, RBAC, audit logs | 2 weeks |
| 5 | Observability, backup, restore, load testing | 1–2 weeks |
| 6 | Dashboard, billing, documentation, launch work | 2–4 weeks |

[Estimate] Two experienced engineers can move from the current MVP to a production-oriented initial release in approximately 8–12 additional weeks, depending on hosting, compliance, billing, and dashboard requirements.

## 25. Known Limitations

- Rate limiting is process-local and does not coordinate multiple API replicas.
- Admin access uses one global key.
- Webhook validation blocks obvious unsafe hosts but does not yet perform complete DNS/IP SSRF validation.
- Destination configuration is not field-level encrypted.
- Form update/version-publication endpoints are not implemented.
- Submission pagination uses a simple limit without cursors.
- File upload fields are intentionally unsupported.
- Database integration was not executed in the original build environment because Docker was unavailable there.

## 26. Launch Acceptance Criteria

- [ ] Form creation works for each supported field type.
- [ ] Allowed websites can submit successfully.
- [ ] Disallowed origins receive `403`.
- [ ] Unknown and oversized fields are rejected.
- [ ] Identical idempotency keys do not create duplicate submissions.
- [ ] Database transaction creates submissions and delivery jobs atomically.
- [ ] Email destination receives correct content.
- [ ] Webhook receiver verifies signatures.
- [ ] Failed deliveries retry and exhausted jobs become `dead`.
- [ ] Expired submissions are deleted.
- [ ] Backup restoration succeeds.
- [ ] Load test meets the selected latency and throughput targets.
- [ ] Logs and metrics contain no unnecessary personal data.
- [ ] Operational alerts reach the responsible team.

## 27. Immediate Next Tasks

1. Run the migration and API against a real PostgreSQL instance.
2. Add PostgreSQL integration tests using Testcontainers or CI services.
3. Implement form update and immutable version publication.
4. Add complete DNS/IP webhook SSRF protection.
5. Replace global admin-key access with OIDC and tenant RBAC.
6. Add Redis-backed distributed rate limiting.
7. Add structured audit logging and production metrics.
8. Perform load, restore, and failure-recovery tests.

## 28. Reference Standards and Guidance

- [JSON Schema Draft 2020-12](https://json-schema.org/draft/2020-12)
- [OpenAPI Specification 3.1.1](https://spec.openapis.org/oas/v3.1.1.html)
- [RFC 9457: Problem Details for HTTP APIs](https://datatracker.ietf.org/doc/rfc9457/)
- [OWASP Input Validation Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html)
- [OWASP SSRF Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html)
- [OWASP API Security Top 10](https://owasp.org/API-Security/)
- [W3C Forms Accessibility Tutorial](https://www.w3.org/WAI/tutorials/forms/)
- [PostgreSQL Row Security Policies](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)
- [PostgreSQL JSON Types](https://www.postgresql.org/docs/current/datatype-json.html)
- [Transactional Outbox Pattern](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html)
- [GitHub Webhook Signature Validation](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)
- [Cloudflare Turnstile Server-side Validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)

---

**Project outcome:** The implemented MVP provides one configurable backend for many frontend contact forms while establishing a practical foundation for reliable delivery, security, privacy, and efficient future scaling.

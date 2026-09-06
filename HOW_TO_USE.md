# How To Use This Project

This project is a reusable backend for contact forms. You can run one backend, create forms through the admin API, and submit form data from static websites.

## Requirements

- Node.js 22 or later
- npm
- Docker with Docker Compose

## 1. Install Dependencies

```bash
npm install
```

## 2. Create Environment File

Copy the example environment file:

```bash
cp .env.example .env
```

Open `.env` and set these important values:

```env
ADMIN_API_KEY=replace-with-at-least-24-random-characters
DATA_ENCRYPTION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
DATABASE_URL=postgres://forms:forms@localhost:5432/forms
PUBLIC_BASE_URL=http://localhost:3000
```

`ADMIN_API_KEY` is used for admin requests. `DATA_ENCRYPTION_KEY` must be exactly 64 hexadecimal characters.

## 3. Start PostgreSQL

```bash
docker compose up -d postgres
```

## 4. Run Database Migrations

```bash
npm run migrate
```

## 5. Start The API Server

```bash
npm run dev
```

The API runs at:

```text
http://localhost:3000
```

Check that it is alive:

```bash
curl http://localhost:3000/health/live
```

Expected response:

```json
{
  "status": "ok"
}
```

## 6. Start The Worker

Open a second terminal and run:

```bash
npm run worker
```

The worker sends queued email or webhook deliveries.

## 7. Create A Contact Form

Use the admin API to create a form:

```bash
curl -X POST http://localhost:3000/v1/admin/forms \
  -H "Authorization: Bearer YOUR_ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "tenantName": "Demo Site",
    "name": "Contact Form",
    "allowedOrigins": ["http://localhost:3000", "http://localhost:8080"],
    "successMessage": "Thanks, your message was sent.",
    "honeypotField": "_website",
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "required": ["name", "email", "topic"],
      "properties": {
        "name": { "type": "string", "minLength": 2, "maxLength": 100 },
        "email": { "type": "string", "format": "email", "maxLength": 254 },
        "topic": { "type": "string", "enum": ["sales", "support"] },
        "message": { "type": "string", "maxLength": 2000 }
      }
    },
    "destinations": []
  }'
```

The response includes a `publicKey` and `submitUrl`. Save the `publicKey`; the frontend uses it to submit messages.

## 8. Submit A Form

Replace `YOUR_PUBLIC_KEY` with the public key from the previous step:

```bash
curl -X POST http://localhost:3000/v1/forms/YOUR_PUBLIC_KEY/submissions \
  -H "Origin: http://localhost:8080" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: test-submit-001" \
  -d '{
    "name": "Test User",
    "email": "test@example.com",
    "topic": "support",
    "message": "Hello from the test form."
  }'
```

Expected response status is `202 Accepted` for a new submission.

## 9. Use The Example HTML Form

Open [examples/contact-form.html](./examples/contact-form.html).

Replace this line:

```js
const endpoint = 'http://localhost:3000/v1/forms/REPLACE_PUBLIC_KEY/submissions';
```

with your real form submit URL:

```js
const endpoint = 'http://localhost:3000/v1/forms/YOUR_PUBLIC_KEY/submissions';
```

Then serve the example file from an allowed origin, for example:

```bash
npx serve examples -l 8080
```

Open:

```text
http://localhost:8080/contact-form.html
```

## 10. View Submissions

```bash
curl http://localhost:3000/v1/admin/forms/YOUR_PUBLIC_KEY/submissions \
  -H "Authorization: Bearer YOUR_ADMIN_API_KEY"
```

## Useful Commands

```bash
npm run dev        # Start API in watch mode
npm run worker     # Start delivery worker
npm run migrate    # Run database migrations
npm test           # Run tests
npm run typecheck  # Check TypeScript types
npm run build      # Build dist output
```

## Common Problems

### Invalid admin token

Make sure the value in the request header matches `ADMIN_API_KEY` from `.env`:

```text
Authorization: Bearer YOUR_ADMIN_API_KEY
```

### Origin is not allowed

The browser origin must exactly match one of the values in `allowedOrigins`. For local testing, add the port you are using, such as:

```json
["http://localhost:8080"]
```

### Database not ready

Start PostgreSQL and run migrations:

```bash
docker compose up -d postgres
npm run migrate
```


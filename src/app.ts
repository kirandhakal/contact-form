import { createRequire } from "node:module";
import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import type { FormatsPlugin } from "ajv-formats";
import Fastify, { type FastifyError, type FastifyReply } from "fastify";
import type { AppConfig } from "./config.js";
import { FixedWindowRateLimiter } from "./rate-limit.js";
import {
  applyCors,
  applySecurityHeaders,
  constantTimeEqual,
  hashIp,
  isAllowedOrigin,
  isSafeWebhookUrl,
  isValidIdempotencyKey,
  newPublicKey
} from "./security.js";
import type { CreateFormInput, JsonObject, Store } from "./types.js";

const require = createRequire(import.meta.url);
const addFormats = require("ajv-formats") as FormatsPlugin;

function problem(reply: FastifyReply, status: number, title: string, detail: string, extra: JsonObject = {}) {
  return reply.code(status).send({ type: "about:blank", title, status, detail, ...extra });
}

function validationErrors(errors: ErrorObject[] | null | undefined) {
  return (errors ?? []).map((error) => ({
    path: error.instancePath || "/",
    message: error.message ?? "is invalid",
    keyword: error.keyword
  }));
}

function assertPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const createFormAjv = new Ajv2020({ allErrors: true, strict: false });
addFormats(createFormAjv);
const validateCreateForm = createFormAjv.compile({
  type: "object",
  additionalProperties: false,
  required: ["tenantName", "name", "allowedOrigins", "schema"],
  properties: {
    tenantName: { type: "string", minLength: 1, maxLength: 200 },
    name: { type: "string", minLength: 1, maxLength: 200 },
    allowedOrigins: {
      type: "array",
      minItems: 1,
      maxItems: 50,
      items: { type: "string", pattern: "^https?://[^/]+$" }
    },
    successMessage: { type: "string", minLength: 1, maxLength: 500 },
    honeypotField: { type: "string", minLength: 1, maxLength: 80 },
    schema: { type: "object" },
    destinations: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "config"],
        properties: {
          kind: { enum: ["email", "webhook"] },
          config: { type: "object" },
          secret: { type: "string", minLength: 24 }
        }
      }
    }
  }
});

const schemaAjv = new Ajv2020({ allErrors: true, strict: false, validateSchema: true });
addFormats(schemaAjv);

export function buildApp(config: AppConfig, store: Store) {
  const app = Fastify({
    logger: config.NODE_ENV === "test" ? false : true,
    bodyLimit: config.MAX_BODY_BYTES
  });
  const limiter = new FixedWindowRateLimiter(config.RATE_LIMIT_WINDOW_SECONDS * 1000, config.RATE_LIMIT_MAX);

  app.addHook("onSend", async (_request, reply) => {
    applySecurityHeaders(reply);
  });

  app.setErrorHandler((error: FastifyError, _request, reply) => {
    if (error.statusCode === 413) {
      void problem(reply, 413, "Payload too large", "Request body exceeds the configured limit.");
      return;
    }
    if (error.validation) {
      void problem(reply, 400, "Malformed request", "Request body is invalid.");
      return;
    }
    app.log.error(error);
    void problem(reply, 500, "Internal error", "The request could not be completed.");
  });

  app.options("/*", async (request, reply) => {
    applyCors(reply, request.headers.origin);
    return reply.code(204).send();
  });

  app.get("/health/live", async () => ({ status: "ok" }));

  app.get("/health/ready", async (_request, reply) => {
    if (await store.ready()) return { status: "ok" };
    return problem(reply, 503, "Database not ready", "Database connectivity check failed.");
  });

  app.post("/v1/admin/forms", async (request, reply) => {
    const auth = request.headers.authorization ?? "";
    const expected = `Bearer ${config.ADMIN_API_KEY}`;
    if (!constantTimeEqual(auth, expected)) {
      return problem(reply, 401, "Unauthorized", "Missing or invalid admin token.");
    }
    if (!validateCreateForm(request.body)) {
      return problem(reply, 422, "Validation failed", "Form definition is invalid.", {
        errors: validationErrors(validateCreateForm.errors)
      });
    }
    const input = request.body as CreateFormInput;
    for (const origin of input.allowedOrigins) {
      if (!isAllowedOrigin(origin, [origin])) {
        return problem(reply, 422, "Validation failed", "Allowed origins must be exact HTTP or HTTPS origins.");
      }
    }
    for (const destination of input.destinations ?? []) {
      if (destination.kind === "webhook" && !isSafeWebhookUrl(destination.config.url)) {
        return problem(reply, 422, "Validation failed", "Webhook destinations require a safe HTTPS URL.");
      }
    }
    if (!schemaAjv.validateSchema(input.schema)) {
      return problem(reply, 422, "Validation failed", "JSON Schema is invalid.", {
        errors: validationErrors(schemaAjv.errors)
      });
    }

    const publicKey = newPublicKey();
    const form = await store.createForm(input, publicKey);
    return reply.code(201).send({
      id: form.id,
      publicKey: form.publicKey,
      submitUrl: `${config.PUBLIC_BASE_URL}/v1/forms/${form.publicKey}/submissions`
    });
  });

  app.get<{ Params: { publicKey: string } }>("/v1/forms/:publicKey", async (request, reply) => {
    const form = await store.getActiveForm(request.params.publicKey);
    if (!form) return problem(reply, 404, "Not found", "Form not found or disabled.");
    if (!isAllowedOrigin(request.headers.origin, form.allowedOrigins)) {
      return problem(reply, 403, "Forbidden", "Origin is not allowed for this form.");
    }
    applyCors(reply, request.headers.origin);
    return {
      publicKey: form.publicKey,
      name: form.name,
      version: form.version,
      schema: form.schema,
      honeypotField: form.honeypotField,
      submitUrl: `${config.PUBLIC_BASE_URL}/v1/forms/${form.publicKey}/submissions`
    };
  });

  app.post<{ Params: { publicKey: string } }>("/v1/forms/:publicKey/submissions", async (request, reply) => {
    const form = await store.getActiveForm(request.params.publicKey);
    if (!form) return problem(reply, 404, "Not found", "Form not found or disabled.");
    if (!isAllowedOrigin(request.headers.origin, form.allowedOrigins)) {
      return problem(reply, 403, "Forbidden", "Origin is not allowed for this form.");
    }
    applyCors(reply, request.headers.origin);

    const ipHash = hashIp(request.ip, config.DATA_ENCRYPTION_KEY);
    const limited = limiter.check(`${form.publicKey}:${ipHash}`);
    if (!limited.allowed) {
      reply.header("Retry-After", limited.retryAfterSeconds);
      return problem(reply, 429, "Rate limit exceeded", "Too many submissions for this form.");
    }

    const idempotencyHeader = request.headers["idempotency-key"];
    const idempotencyKey = Array.isArray(idempotencyHeader) ? idempotencyHeader[0] : idempotencyHeader;
    if (idempotencyKey && !isValidIdempotencyKey(idempotencyKey)) {
      return problem(reply, 400, "Malformed request", "Invalid idempotency key.");
    }
    if (!assertPlainObject(request.body)) {
      return problem(reply, 400, "Malformed request", "Submission body must be a JSON object.");
    }

    const payload = { ...request.body };
    const spam = typeof payload[form.honeypotField] === "string" && payload[form.honeypotField] !== "";
    delete payload[form.honeypotField];

    const validatePayload = schemaAjv.compile(form.schema);
    if (!validatePayload(payload)) {
      return problem(reply, 422, "Validation failed", "Submission fields are invalid.", {
        errors: validationErrors(validatePayload.errors)
      });
    }

    const expiresAt = new Date(Date.now() + config.RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const result = await store.createSubmission({
      form,
      payload,
      status: spam ? "spam" : "accepted",
      sourceOrigin: request.headers.origin,
      sourceIpHash: ipHash,
      idempotencyKey,
      expiresAt
    });
    return reply.code(result.duplicate ? 200 : 202).send({
      id: result.submission.id,
      status: result.submission.status,
      duplicate: result.duplicate,
      message: form.successMessage
    });
  });

  app.get<{ Params: { publicKey: string }; Querystring: { limit?: string } }>(
    "/v1/admin/forms/:publicKey/submissions",
    async (request, reply) => {
      const auth = request.headers.authorization ?? "";
      const expected = `Bearer ${config.ADMIN_API_KEY}`;
      if (!constantTimeEqual(auth, expected)) {
        return problem(reply, 401, "Unauthorized", "Missing or invalid admin token.");
      }
      const limit = Math.min(Math.max(Number(request.query.limit ?? 50) || 50, 1), 200);
      return { submissions: await store.listSubmissions(request.params.publicKey, limit) };
    }
  );

  return app;
}

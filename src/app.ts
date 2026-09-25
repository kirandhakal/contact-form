import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import type { FormatsPlugin } from "ajv-formats";
import Fastify, { type FastifyError, type FastifyReply } from "fastify";
import { hashPassword, hashSessionToken, newSessionToken, verifyPassword } from "./admin-auth.js";
import type { AppConfig } from "./config.js";
import { FixedWindowRateLimiter } from "./rate-limit.js";
import {
  applyCors,
  applySecurityHeaders,
  constantTimeEqual,
  hashIp,
  hashSubmissionAccessToken,
  isAllowedOrigin,
  isSafeWebhookUrl,
  isValidIdempotencyKey,
  newPublicKey,
  newSubmissionAccessToken
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

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function normalizeExactOrigin(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

async function verifyTurnstile(secret: string, token: string | undefined, ip: string): Promise<boolean> {
  if (!secret) return true;
  if (!token) return false;

  const body = new URLSearchParams({
    secret,
    response: token,
    remoteip: ip
  });
  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body
  });
  if (!response.ok) return false;
  const result = (await response.json()) as { success?: boolean };
  return result.success === true;
}

const createFormAjv = new Ajv2020({ allErrors: true, strict: false });
addFormats(createFormAjv);
const validateCreateForm = createFormAjv.compile({
  type: "object",
  additionalProperties: false,
  required: ["tenantName", "name", "allowedOrigins", "schema"],
  properties: {
    tenantName: { type: "string", minLength: 1, maxLength: 200 },
    tenantId: { type: "string", format: "uuid" },
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
  const loginLimiter = new FixedWindowRateLimiter(15 * 60 * 1000, 10);
  const signupLimiter = new FixedWindowRateLimiter(60 * 60 * 1000, 5);

  async function sendPublicPage(reply: FastifyReply, filename: string) {
    const path = join(dirname(fileURLToPath(import.meta.url)), "..", "public", filename);
    reply.header("Cache-Control", "no-store");
    return reply.type("text/html; charset=utf-8").send(await readFile(path, "utf8"));
  }

  async function adminFor(request: { headers: Record<string, unknown> }) {
    const auth = request.headers.authorization;
    if (typeof auth === "string" && constantTimeEqual(auth, `Bearer ${config.ADMIN_API_KEY}`)) {
      return { id: "service-key", email: "service-key", role: "service" as const, tenantId: null };
    }
    const cookie = request.headers.cookie;
    const token = typeof cookie === "string" ? /(?:^|;\s*)contact_admin=([A-Za-z0-9_-]{43})/.exec(cookie)?.[1] : undefined;
    return token ? store.getAdminBySession(hashSessionToken(token)) : null;
  }

  function sameOrigin(request: { headers: Record<string, unknown> }): boolean {
    const origin = request.headers.origin;
    return typeof origin === "string" && origin === new URL(config.PUBLIC_BASE_URL).origin;
  }

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

  app.get("/", async (_request, reply) => reply.redirect("/auth"));
  app.get("/auth", async (_request, reply) => sendPublicPage(reply, "auth.html"));
  app.get("/auth/admin", async (_request, reply) => sendPublicPage(reply, "auth.html"));
  app.get("/dashboard", async (_request, reply) => sendPublicPage(reply, "admin.html"));
  app.get("/admin", async (_request, reply) => reply.redirect("/auth/admin"));

  app.get("/health/ready", async (_request, reply) => {
    if (await store.ready()) return { status: "ok" };
    return problem(reply, 503, "Database not ready", "Database connectivity check failed.");
  });

  app.post("/v1/admin/login", async (request, reply) => {
    if (!sameOrigin(request)) return problem(reply, 403, "Forbidden", "Use the hosted admin page.");
    const limit = loginLimiter.check(request.ip);
    if (!limit.allowed) return problem(reply, 429, "Too many attempts", "Try again later.");
    if (!assertPlainObject(request.body) || typeof request.body.email !== "string" ||
      typeof request.body.password !== "string") return problem(reply, 400, "Invalid request", "Email and password are required.");
    const email = request.body.email.trim().toLowerCase();
    const admin = await store.getAdminByEmail(email);
    if (!admin || !(await verifyPassword(request.body.password, admin.passwordHash))) {
      return problem(reply, 401, "Unauthorized", "Invalid email or password.");
    }
    const token = newSessionToken();
    await store.createAdminSession(admin.id, hashSessionToken(token), new Date(Date.now() + 8 * 60 * 60 * 1000));
    const secure = new URL(config.PUBLIC_BASE_URL).protocol === "https:" ? "; Secure" : "";
    reply.header("Set-Cookie", `contact_admin=${token}; HttpOnly; SameSite=Strict; Path=/v1/admin; Max-Age=28800${secure}`);
    reply.header("Cache-Control", "no-store");
    return { email: admin.email, role: admin.role };
  });

  app.post("/v1/auth/signup", async (request, reply) => {
    if (!sameOrigin(request)) return problem(reply, 403, "Forbidden", "Use the hosted signup page.");
    const limit = signupLimiter.check(request.ip);
    if (!limit.allowed) return problem(reply, 429, "Too many attempts", "Try again later.");
    if (!assertPlainObject(request.body) || typeof request.body.workspaceName !== "string" ||
      typeof request.body.email !== "string" || typeof request.body.password !== "string") {
      return problem(reply, 400, "Invalid request", "Workspace name, email, and password are required.");
    }
    const workspaceName = request.body.workspaceName.trim();
    const email = request.body.email.trim().toLowerCase();
    const password = request.body.password;
    if (!workspaceName || workspaceName.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      email.length > 254 || password.length < 12 || password.length > 256) {
      return problem(reply, 422, "Invalid request", "Use a valid workspace, email, and password of at least 12 characters.");
    }
    try {
      const account = await store.createSiteAccount(workspaceName, email, await hashPassword(password));
      return reply.code(201).send({ email, role: "site", tenantId: account.tenantId });
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
        return problem(reply, 409, "Account exists", "An account with this email already exists.");
      }
      throw error;
    }
  });

  app.post("/v1/admin/logout", async (request, reply) => {
    if (!sameOrigin(request)) return problem(reply, 403, "Forbidden", "Invalid origin.");
    const token = /(?:^|;\s*)contact_admin=([A-Za-z0-9_-]{43})/.exec(request.headers.cookie ?? "")?.[1];
    if (token) await store.deleteAdminSession(hashSessionToken(token));
    reply.header("Set-Cookie", "contact_admin=; HttpOnly; SameSite=Strict; Path=/v1/admin; Max-Age=0");
    return { ok: true };
  });

  app.get("/v1/admin/me", async (request, reply) => {
    const admin = await adminFor(request);
    if (!admin) return problem(reply, 401, "Unauthorized", "Sign in required.");
    reply.header("Cache-Control", "no-store");
    return { email: admin.email, role: admin.role, tenantId: admin.tenantId };
  });

  app.post("/v1/admin/users", async (request, reply) => {
    if (!sameOrigin(request) && !constantTimeEqual(request.headers.authorization ?? "", `Bearer ${config.ADMIN_API_KEY}`)) {
      return problem(reply, 403, "Forbidden", "Invalid origin.");
    }
    const actor = await adminFor(request);
    if (!actor) return problem(reply, 401, "Unauthorized", "Sign in required.");
    if (!assertPlainObject(request.body) || typeof request.body.email !== "string" ||
      typeof request.body.password !== "string" || typeof request.body.role !== "string") {
      return problem(reply, 400, "Invalid request", "Email, password, and role are required.");
    }
    const { email, password, role } = request.body;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || password.length < 12 || password.length > 256 ||
      !["service", "site"].includes(role)) return problem(reply, 422, "Invalid request", "Invalid email, password, or role.");
    if (actor.role !== "service" && role !== "site") return problem(reply, 403, "Forbidden", "Site admins can add site admins only.");
    const formKey = request.body.formKey;
    const tenantId = role === "site"
      ? actor.role === "site" ? actor.tenantId : typeof formKey === "string" ? await store.getTenantIdForForm(formKey) : null
      : null;
    if (role === "site" && !tenantId) return problem(reply, 422, "Invalid request", "A registered form key is required.");
    try {
      await store.createAdmin(email.trim().toLowerCase(), await hashPassword(password), role as "service" | "site", tenantId);
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
        return problem(reply, 409, "Conflict", "This email already has an account.");
      }
      throw error;
    }
    return reply.code(201).send({ email: email.trim().toLowerCase(), role, tenantId });
  });

  app.post("/v1/admin/forms", async (request, reply) => {
    const admin = await adminFor(request);
    if (!admin) return problem(reply, 401, "Unauthorized", "Sign in required.");
    if (admin.id !== "service-key" && !sameOrigin(request)) return problem(reply, 403, "Forbidden", "Invalid origin.");
    const body = assertPlainObject(request.body) && Array.isArray(request.body.allowedOrigins)
      ? {
          ...request.body,
          allowedOrigins: request.body.allowedOrigins.map((origin) =>
            typeof origin === "string" ? normalizeExactOrigin(origin) ?? origin : origin)
        }
      : request.body;
    if (!validateCreateForm(body)) {
      return problem(reply, 422, "Validation failed", "Form definition is invalid.", {
        errors: validationErrors(validateCreateForm.errors)
      });
    }
    // Site admins may add forms, but only to the tenant attached to their
    // account. Never trust a tenant id supplied by a browser session.
    const input: CreateFormInput = admin.role === "site"
      ? { ...(body as CreateFormInput), tenantId: admin.tenantId ?? undefined }
      : body as CreateFormInput;
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
      tenantId: form.tenantId,
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

  app.get("/v1/admin/forms/summary", async (request, reply) => {
    const admin = await adminFor(request);
    if (!admin) {
      return problem(reply, 401, "Unauthorized", "Missing or invalid admin token.");
    }
    reply.header("Cache-Control", "no-store");
    const forms = await store.listFormSummaries();
    return { forms: admin.role === "service" ? forms : forms.filter((form) => form.tenantId === admin.tenantId) };
  });

  app.patch<{ Params: { publicKey: string } }>("/v1/admin/forms/:publicKey", async (request, reply) => {
    const admin = await adminFor(request);
    if (!admin) return problem(reply, 401, "Unauthorized", "Sign in required.");
    if (!sameOrigin(request) && admin.id !== "service-key") return problem(reply, 403, "Forbidden", "Invalid origin.");
    if (!assertPlainObject(request.body) || !["active", "disabled"].includes(String(request.body.status))) {
      return problem(reply, 422, "Invalid request", "Status must be active or disabled.");
    }
    const tenantId = await store.getTenantIdForForm(request.params.publicKey);
    if (!tenantId || (admin.role === "site" && tenantId !== admin.tenantId)) {
      return problem(reply, 404, "Not found", "Form not found.");
    }
    const status = request.body.status as "active" | "disabled";
    await store.setFormStatus(request.params.publicKey, status);
    return { publicKey: request.params.publicKey, status };
  });

  app.post<{ Params: { publicKey: string } }>("/v1/forms/:publicKey/submissions", async (request, reply) => {
    const form = await store.getActiveForm(request.params.publicKey);
    if (!form) return problem(reply, 404, "Not found", "Form not found or disabled.");
    if (!isAllowedOrigin(request.headers.origin, form.allowedOrigins)) {
      return problem(reply, 403, "Forbidden", "Origin is not allowed for this form.");
    }
    applyCors(reply, request.headers.origin);

    const turnstileToken = firstHeader(request.headers["turnstile-token"]);
    if (!(await verifyTurnstile(config.TURNSTILE_SECRET_KEY, turnstileToken, request.ip))) {
      return problem(reply, 403, "Forbidden", "Bot verification failed.");
    }

    const ipHash = hashIp(request.ip, config.DATA_ENCRYPTION_KEY);
    const limited = limiter.check(`${form.publicKey}:${ipHash}`);
    if (!limited.allowed) {
      reply.header("Retry-After", limited.retryAfterSeconds);
      return problem(reply, 429, "Rate limit exceeded", "Too many submissions for this form.");
    }

    const idempotencyKey = firstHeader(request.headers["idempotency-key"]);
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
    const accessToken = newSubmissionAccessToken();
    const result = await store.createSubmission({
      form,
      payload,
      status: spam ? "spam" : "accepted",
      sourceOrigin: request.headers.origin,
      sourceIpHash: ipHash,
      idempotencyKey,
      accessTokenHash: hashSubmissionAccessToken(accessToken),
      expiresAt
    });
    const response = {
      status: result.submission.status,
      message: form.successMessage,
      ...(!result.duplicate && {
        submissionId: result.submission.id,
        responseUrl: `${config.PUBLIC_BASE_URL}/v1/submissions/${result.submission.id}`,
        responseToken: accessToken
      })
    };
    return reply.code(result.duplicate ? 200 : 202).send(response);
  });

  app.get<{ Params: { submissionId: string } }>("/v1/submissions/:submissionId", async (request, reply) => {
    const authorization = request.headers.authorization;
    const token = typeof authorization === "string" && authorization.startsWith("Bearer ")
      ? authorization.slice(7)
      : "";
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
      return problem(reply, 401, "Unauthorized", "A valid response token is required.");
    }
    const result = await store.getSubmissionByAccessToken(
      request.params.submissionId,
      hashSubmissionAccessToken(token)
    );
    if (!result) return problem(reply, 404, "Not found", "Submission not found or expired.");
    if (!isAllowedOrigin(request.headers.origin, result.allowedOrigins)) {
      return problem(reply, 403, "Forbidden", "Origin is not allowed for this form.");
    }
    applyCors(reply, request.headers.origin);
    reply.header("Cache-Control", "no-store");
    return {
      id: result.submission.id,
      status: result.submission.status,
      payload: result.submission.payload,
      createdAt: result.submission.createdAt
    };
  });

  app.get<{ Params: { publicKey: string }; Querystring: { limit?: string } }>(
    "/v1/admin/forms/:publicKey/submissions",
    async (request, reply) => {
      const admin = await adminFor(request);
      if (!admin) {
        return problem(reply, 401, "Unauthorized", "Missing or invalid admin token.");
      }
      const tenantId = await store.getTenantIdForForm(request.params.publicKey);
      if (!tenantId || (admin.role === "site" && tenantId !== admin.tenantId)) {
        return problem(reply, 404, "Not found", "Form not found.");
      }
      const limit = Math.min(Math.max(Number(request.query.limit ?? 50) || 50, 1), 200);
      reply.header("Cache-Control", "no-store");
      return { submissions: await store.listSubmissions(request.params.publicKey, limit) };
    }
  );

  return app;
}

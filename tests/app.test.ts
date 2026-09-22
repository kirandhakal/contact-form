import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type {
  CreateFormInput,
  FormSummary,
  FormRecord,
  JsonObject,
  OutboxJob,
  Store,
  SubmissionRecord,
  SubmissionResult,
  SubmissionStatus
} from "../src/types.js";

const config = {
  NODE_ENV: "test",
  HOST: "127.0.0.1",
  PORT: 3000,
  DATABASE_URL: "postgres://unused",
  ADMIN_API_KEY: "0123456789abcdef01234567",
  DATA_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  PUBLIC_BASE_URL: "http://localhost:3000",
  MAX_BODY_BYTES: 4096,
  RATE_LIMIT_WINDOW_SECONDS: 60,
  RATE_LIMIT_MAX: 20,
  RETENTION_DAYS: 90,
  WORKER_POLL_MS: 1000,
  SMTP_URL: "",
  EMAIL_FROM: "forms@example.com",
  WEBHOOK_TIMEOUT_MS: 5000,
  TURNSTILE_SECRET_KEY: ""
};

class MemoryStore implements Store {
  forms = new Map<string, FormRecord>();
  submissions: SubmissionRecord[] = [];
  admins = new Map<string, { id: string; email: string; passwordHash: string; role: "service" | "site"; tenantId: string | null }>();
  sessions = new Map<string, string>();

  async createAdmin(email: string, passwordHash: string, role: "service" | "site", tenantId: string | null) {
    this.admins.set(email, { id: randomUUID(), email, passwordHash, role, tenantId });
  }
  async getAdminByEmail(email: string) { return this.admins.get(email) ?? null; }
  async createAdminSession(adminId: string, tokenHash: string) { this.sessions.set(tokenHash, adminId); }
  async getAdminBySession(tokenHash: string) {
    return [...this.admins.values()].find((admin) => admin.id === this.sessions.get(tokenHash)) ?? null;
  }
  async deleteAdminSession(tokenHash: string) { this.sessions.delete(tokenHash); }
  async getTenantIdForForm(publicKey: string) { return this.forms.get(publicKey)?.tenantId ?? null; }
  async setFormStatus(publicKey: string, status: "active" | "disabled") {
    const form = this.forms.get(publicKey);
    if (!form) return false;
    form.status = status;
    return true;
  }

  async ready() {
    return true;
  }

  async createForm(input: CreateFormInput, publicKey: string): Promise<FormRecord> {
    const form: FormRecord = {
      id: randomUUID(),
      tenantId: input.tenantId ?? randomUUID(),
      publicKey,
      name: input.name,
      status: "active",
      allowedOrigins: input.allowedOrigins,
      successMessage: input.successMessage ?? "Thank you. We received your message.",
      honeypotField: input.honeypotField ?? "_website",
      version: 1,
      schema: input.schema as JsonObject
    };
    this.forms.set(publicKey, form);
    return form;
  }

  async getActiveForm(publicKey: string) {
    return this.forms.get(publicKey) ?? null;
  }

  async createSubmission(args: {
    form: FormRecord;
    payload: JsonObject;
    status: SubmissionStatus;
    sourceOrigin?: string;
    sourceIpHash: string;
    idempotencyKey?: string;
    accessTokenHash: string;
    expiresAt: Date;
  }): Promise<SubmissionResult> {
    const existing = args.idempotencyKey
      ? this.submissions.find((item) => item.formId === args.form.id && item.idempotencyKey === args.idempotencyKey)
      : undefined;
    if (existing) return { submission: existing, duplicate: true };
    const submission: SubmissionRecord = {
      id: randomUUID(),
      tenantId: args.form.tenantId,
      formId: args.form.id,
      formVersion: args.form.version,
      payload: args.payload,
      status: args.status,
      sourceOrigin: args.sourceOrigin,
      sourceIpHash: args.sourceIpHash,
      idempotencyKey: args.idempotencyKey,
      expiresAt: args.expiresAt.toISOString(),
      createdAt: new Date().toISOString()
    };
    this.submissions.push(submission);
    this.accessTokens.set(submission.id, args.accessTokenHash);
    return { submission, duplicate: false };
  }

  accessTokens = new Map<string, string>();
  async getSubmissionByAccessToken(submissionId: string, accessTokenHash: string) {
    const submission = this.submissions.find((item) => item.id === submissionId);
    const form = submission ? [...this.forms.values()].find((item) => item.id === submission.formId) : undefined;
    return submission && form && this.accessTokens.get(submissionId) === accessTokenHash
      ? { submission, allowedOrigins: form.allowedOrigins }
      : null;
  }

  async listSubmissions(publicKey: string, limit: number) {
    const form = this.forms.get(publicKey);
    return form ? this.submissions.filter((item) => item.formId === form.id).slice(0, limit) : [];
  }

  async listFormSummaries(): Promise<FormSummary[]> {
    return [...this.forms.values()]
      .map((form) => {
        const submissions = this.submissions.filter((item) => item.formId === form.id && item.status !== "deleted");
        const sourceOriginCounts = submissions.reduce<Record<string, number>>((counts, submission) => {
          const origin = submission.sourceOrigin ?? "unknown";
          counts[origin] = (counts[origin] ?? 0) + 1;
          return counts;
        }, {});
        return {
          tenantId: form.tenantId,
          tenantName: "Acme",
          publicKey: form.publicKey,
          name: form.name,
          status: form.status,
          allowedOrigins: form.allowedOrigins,
          submissionCount: submissions.length,
          acceptedCount: submissions.filter((item) => item.status === "accepted").length,
          spamCount: submissions.filter((item) => item.status === "spam").length,
          lastSubmittedAt: submissions.at(-1)?.createdAt,
          sourceOriginCounts
        };
      })
      .sort((a, b) => b.submissionCount - a.submissionCount);
  }

  async claimJobs(): Promise<OutboxJob[]> {
    return [];
  }

  async markJobDelivered() {}
  async markJobFailed() {}
  async deleteExpiredSubmissions() {
    return 0;
  }
  async close() {}
}

async function createTestForm(store: MemoryStore) {
  const app = buildApp(config, store);
  const response = await app.inject({
    method: "POST",
    url: "/v1/admin/forms",
    headers: {
      authorization: `Bearer ${config.ADMIN_API_KEY}`,
      "content-type": "application/json"
    },
    payload: {
      tenantName: "Acme",
      name: "Website contact",
      allowedOrigins: ["https://www.example.com"],
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["name", "email", "topic"],
        properties: {
          name: { type: "string", minLength: 2 },
          email: { type: "string", format: "email" },
          topic: { type: "string", enum: ["sales", "support"] },
          message: { type: "string", maxLength: 2000 }
        }
      }
    }
  });
  expect(response.statusCode).toBe(201);
  return { app, body: response.json() as { publicKey: string } };
}

describe("contact form API", () => {
  it("lets a site admin create forms only in their own tenant", async () => {
    const store = new MemoryStore();
    const { app, body } = await createTestForm(store);
    const tenantId = store.forms.get(body.publicKey)?.tenantId;
    await app.inject({
      method: "POST", url: "/v1/admin/users",
      headers: { authorization: `Bearer ${config.ADMIN_API_KEY}` },
      payload: { email: "builder@example.com", password: "a-long-secret-password", role: "site", formKey: body.publicKey }
    });
    const login = await app.inject({
      method: "POST", url: "/v1/admin/login", headers: { origin: config.PUBLIC_BASE_URL },
      payload: { email: "builder@example.com", password: "a-long-secret-password" }
    });
    const created = await app.inject({
      method: "POST", url: "/v1/admin/forms",
      headers: { cookie: login.headers["set-cookie"] as string, origin: config.PUBLIC_BASE_URL },
      payload: {
        tenantName: "Ignored browser value",
        tenantId: randomUUID(),
        name: "Registration",
        allowedOrigins: ["https://www.example.com"],
        schema: { type: "object", additionalProperties: false, properties: {} }
      }
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().tenantId).toBe(tenantId);
  });

  it("limits a site admin to their own tenant", async () => {
    const store = new MemoryStore();
    const { app, body } = await createTestForm(store);
    const other = await app.inject({
      method: "POST", url: "/v1/admin/forms",
      headers: { authorization: `Bearer ${config.ADMIN_API_KEY}` },
      payload: { tenantName: "Other", name: "Other form", allowedOrigins: ["https://other.example"],
        schema: { type: "object", additionalProperties: false, properties: {} } }
    });
    const otherKey = (other.json() as { publicKey: string }).publicKey;
    const created = await app.inject({
      method: "POST", url: "/v1/admin/users",
      headers: { authorization: `Bearer ${config.ADMIN_API_KEY}` },
      payload: { email: "owner@example.com", password: "a-long-secret-password", role: "site", formKey: body.publicKey }
    });
    expect(created.statusCode).toBe(201);
    const login = await app.inject({
      method: "POST", url: "/v1/admin/login", headers: { origin: config.PUBLIC_BASE_URL },
      payload: { email: "owner@example.com", password: "a-long-secret-password" }
    });
    expect(login.statusCode).toBe(200);
    const cookie = login.headers["set-cookie"] as string;
    const own = await app.inject({ method: "GET", url: "/v1/admin/forms/summary", headers: { cookie } });
    expect(own.json().forms.map((form: FormSummary) => form.publicKey)).toEqual([body.publicKey]);
    const forbidden = await app.inject({ method: "GET", url: `/v1/admin/forms/${otherKey}/submissions`, headers: { cookie } });
    expect(forbidden.statusCode).toBe(404);
    const cannotDisableOther = await app.inject({
      method: "PATCH", url: `/v1/admin/forms/${otherKey}`,
      headers: { cookie, origin: config.PUBLIC_BASE_URL }, payload: { status: "disabled" }
    });
    expect(cannotDisableOther.statusCode).toBe(404);
    const disableOwn = await app.inject({
      method: "PATCH", url: `/v1/admin/forms/${body.publicKey}`,
      headers: { cookie, origin: config.PUBLIC_BASE_URL }, payload: { status: "disabled" }
    });
    expect(disableOwn.statusCode).toBe(200);
    const allowed = await app.inject({ method: "GET", url: `/v1/admin/forms/${body.publicKey}/submissions`, headers: { cookie } });
    expect(allowed.statusCode).toBe(200);
  });
  it("creates a form through the admin endpoint", async () => {
    const { body } = await createTestForm(new MemoryStore());
    expect(body.publicKey).toMatch(/^frm_/);
  });

  it("accepts valid submissions and rejects disallowed origins", async () => {
    const store = new MemoryStore();
    const { app, body } = await createTestForm(store);
    const ok = await app.inject({
      method: "POST",
      url: `/v1/forms/${body.publicKey}/submissions`,
      headers: { origin: "https://www.example.com", "idempotency-key": "key-12345678" },
      payload: { name: "Jane", email: "jane@example.com", topic: "support" }
    });
    expect(ok.statusCode).toBe(202);
    expect(ok.json().status).toBe("accepted");
    expect(ok.json()).toEqual(expect.objectContaining({
      status: "accepted",
      message: "Thank you. We received your message.",
      submissionId: expect.any(String),
      responseUrl: expect.any(String),
      responseToken: expect.any(String)
    }));

    const created = ok.json() as { responseUrl: string; responseToken: string };
    const ownResponse = await app.inject({
      method: "GET",
      url: created.responseUrl,
      headers: { origin: "https://www.example.com", authorization: `Bearer ${created.responseToken}` }
    });
    expect(ownResponse.statusCode).toBe(200);
    expect(ownResponse.json()).toEqual(expect.objectContaining({
      status: "accepted",
      payload: { name: "Jane", email: "jane@example.com", topic: "support" }
    }));

    const cannotReadFromAnotherOrigin = await app.inject({
      method: "GET",
      url: created.responseUrl,
      headers: { origin: "https://evil.example.com", authorization: `Bearer ${created.responseToken}` }
    });
    expect(cannotReadFromAnotherOrigin.statusCode).toBe(403);

    const blocked = await app.inject({
      method: "POST",
      url: `/v1/forms/${body.publicKey}/submissions`,
      headers: { origin: "https://evil.example.com" },
      payload: { name: "Jane", email: "jane@example.com", topic: "support" }
    });
    expect(blocked.statusCode).toBe(403);
  });

  it("returns validation errors for invalid fields", async () => {
    const store = new MemoryStore();
    const { app, body } = await createTestForm(store);
    const response = await app.inject({
      method: "POST",
      url: `/v1/forms/${body.publicKey}/submissions`,
      headers: { origin: "https://www.example.com" },
      payload: { name: "J", email: "not-an-email", topic: "billing" }
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().errors.length).toBeGreaterThan(0);
  });

  it("deduplicates submissions by idempotency key", async () => {
    const store = new MemoryStore();
    const { app, body } = await createTestForm(store);
    const request = {
      method: "POST" as const,
      url: `/v1/forms/${body.publicKey}/submissions`,
      headers: { origin: "https://www.example.com", "idempotency-key": "retry-key-123" },
      payload: { name: "Jane", email: "jane@example.com", topic: "support" }
    };
    expect((await app.inject(request)).statusCode).toBe(202);
    const duplicate = await app.inject(request);
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json().status).toBe("accepted");
    expect(store.submissions).toHaveLength(1);
  });

  it("classifies honeypot submissions as spam", async () => {
    const store = new MemoryStore();
    const { app, body } = await createTestForm(store);
    const response = await app.inject({
      method: "POST",
      url: `/v1/forms/${body.publicKey}/submissions`,
      headers: { origin: "https://www.example.com" },
      payload: {
        name: "Jane",
        email: "jane@example.com",
        topic: "support",
        _website: "filled by bot"
      }
    });
    expect(response.statusCode).toBe(202);
    expect(response.json().status).toBe("spam");
  });

  it("summarizes traffic separately for every form", async () => {
    const store = new MemoryStore();
    const { app, body } = await createTestForm(store);
    const second = await app.inject({
      method: "POST",
      url: "/v1/admin/forms",
      headers: { authorization: `Bearer ${config.ADMIN_API_KEY}` },
      payload: {
        tenantName: "Gourav Studio",
        name: "Gourav inquiry",
        allowedOrigins: ["https://gourav.example"],
        schema: { type: "object", additionalProperties: false, properties: {} }
      }
    });
    const secondKey = (second.json() as { publicKey: string }).publicKey;

    await app.inject({
      method: "POST",
      url: `/v1/forms/${body.publicKey}/submissions`,
      headers: { origin: "https://www.example.com" },
      payload: { name: "Jane", email: "jane@example.com", topic: "support" }
    });
    await app.inject({
      method: "POST",
      url: `/v1/forms/${body.publicKey}/submissions`,
      headers: { origin: "https://www.example.com" },
      payload: { name: "John", email: "john@example.com", topic: "sales" }
    });
    await app.inject({
      method: "POST",
      url: `/v1/forms/${secondKey}/submissions`,
      headers: { origin: "https://gourav.example" },
      payload: {}
    });

    const summary = await app.inject({
      method: "GET",
      url: "/v1/admin/forms/summary",
      headers: { authorization: `Bearer ${config.ADMIN_API_KEY}` }
    });
    expect(summary.statusCode).toBe(200);
    expect(summary.json().forms).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          publicKey: body.publicKey,
          submissionCount: 2,
          sourceOriginCounts: { "https://www.example.com": 2 }
        }),
        expect.objectContaining({ publicKey: secondKey, submissionCount: 1 })
      ])
    );
  });

  it("requires bot verification when Turnstile is configured", async () => {
    const store = new MemoryStore();
    const secureConfig = { ...config, TURNSTILE_SECRET_KEY: "test-secret" };
    const app = buildApp(secureConfig, store);
    const create = await app.inject({
      method: "POST",
      url: "/v1/admin/forms",
      headers: {
        authorization: `Bearer ${config.ADMIN_API_KEY}`,
        "content-type": "application/json"
      },
      payload: {
        tenantName: "Acme",
        name: "Website contact",
        allowedOrigins: ["https://www.example.com"],
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["name", "email", "topic"],
          properties: {
            name: { type: "string", minLength: 2 },
            email: { type: "string", format: "email" },
            topic: { type: "string", enum: ["sales", "support"] }
          }
        }
      }
    });
    const { publicKey } = create.json() as { publicKey: string };

    const response = await app.inject({
      method: "POST",
      url: `/v1/forms/${publicKey}/submissions`,
      headers: { origin: "https://www.example.com" },
      payload: { name: "Jane", email: "jane@example.com", topic: "support" }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().detail).toBe("Bot verification failed.");
  });
});

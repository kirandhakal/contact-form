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
  accessTokens = new Map<string, string>();

  async ready() {
    return true;
  }

  async createForm(input: CreateFormInput, publicKey: string): Promise<FormRecord> {
    const form: FormRecord = {
      id: randomUUID(),
      tenantId: randomUUID(),
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
    expiresAt: Date;
    accessTokenHash?: string;
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
    if (args.accessTokenHash) this.accessTokens.set(submission.id, args.accessTokenHash);
    return { submission, duplicate: false };
  }

  async getSubmissionByAccessToken(publicKey: string, submissionId: string, accessTokenHash: string) {
    const form = this.forms.get(publicKey);
    const submission = this.submissions.find((item) => item.id === submissionId && item.formId === form?.id);
    return submission && this.accessTokens.get(submission.id) === accessTokenHash ? submission : null;
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
    expect(ok.json().accessToken).toEqual(expect.any(String));

    const own = await app.inject({
      method: "GET",
      url: `/v1/forms/${body.publicKey}/submissions/${ok.json().id}`,
      headers: {
        origin: "https://www.example.com",
        "submission-token": ok.json().accessToken
      }
    });
    expect(own.statusCode).toBe(200);
    expect(own.json().submission.payload.email).toBe("jane@example.com");

    const denied = await app.inject({
      method: "GET",
      url: `/v1/forms/${body.publicKey}/submissions/${ok.json().id}`,
      headers: { origin: "https://www.example.com", "submission-token": "wrong-token-that-is-long-enough-123456789" }
    });
    expect(denied.statusCode).toBe(404);

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
    expect(duplicate.json().duplicate).toBe(true);
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

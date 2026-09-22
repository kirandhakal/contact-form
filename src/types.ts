import type { JSONSchemaType } from "ajv";

export type JsonObject = Record<string, unknown>;
export type DestinationKind = "email" | "webhook";
export type SubmissionStatus = "accepted" | "spam" | "deleted";

export interface DestinationInput {
  kind: DestinationKind;
  config: JsonObject;
  secret?: string;
}

export interface CreateFormInput {
  tenantName: string;
  tenantId?: string;
  name: string;
  allowedOrigins: string[];
  successMessage?: string;
  honeypotField?: string;
  schema: JSONSchemaType<unknown> | JsonObject;
  destinations?: DestinationInput[];
}

export interface FormRecord {
  id: string;
  tenantId: string;
  publicKey: string;
  name: string;
  status: "active" | "disabled";
  allowedOrigins: string[];
  successMessage: string;
  honeypotField: string;
  version: number;
  schema: JsonObject;
}

export interface DestinationRecord {
  id: string;
  formId: string;
  kind: DestinationKind;
  config: JsonObject;
  secret?: string | null;
  active: boolean;
}

export interface SubmissionRecord {
  id: string;
  tenantId: string;
  formId: string;
  formVersion: number;
  payload: JsonObject;
  status: SubmissionStatus;
  sourceOrigin?: string;
  sourceIpHash: string;
  idempotencyKey?: string;
  expiresAt: string;
  createdAt: string;
}

export interface SubmissionResult {
  submission: SubmissionRecord;
  duplicate: boolean;
}

/**
 * Admin-only counts used to compare traffic between independent frontends.
 * A form has one public key, so its counts and submissions are isolated from
 * every other frontend or form type (for example, contact vs. enrolment).
 */
export interface FormSummary {
  tenantId: string;
  tenantName: string;
  publicKey: string;
  name: string;
  status: "active" | "disabled";
  allowedOrigins: string[];
  submissionCount: number;
  acceptedCount: number;
  spamCount: number;
  lastSubmittedAt?: string;
  sourceOriginCounts: Record<string, number>;
}

export interface OutboxJob {
  id: string;
  submission: SubmissionRecord;
  form: Pick<FormRecord, "id" | "name">;
  destination: DestinationRecord;
  attempts: number;
}

export interface Store {
  ready(): Promise<boolean>;
  createForm(input: CreateFormInput, publicKey: string): Promise<FormRecord>;
  getActiveForm(publicKey: string): Promise<FormRecord | null>;
  createSubmission(args: {
    form: FormRecord;
    payload: JsonObject;
    status: SubmissionStatus;
    sourceOrigin?: string;
    sourceIpHash: string;
    idempotencyKey?: string;
    accessTokenHash: string;
    expiresAt: Date;
  }): Promise<SubmissionResult>;
  getSubmissionByAccessToken(submissionId: string, accessTokenHash: string): Promise<{
    submission: SubmissionRecord;
    allowedOrigins: string[];
  } | null>;
  createAdmin(email: string, passwordHash: string, role: "service" | "site", tenantId: string | null): Promise<void>;
  getAdminByEmail(email: string): Promise<{ id: string; email: string; passwordHash: string; role: "service" | "site"; tenantId: string | null } | null>;
  createAdminSession(adminId: string, tokenHash: string, expiresAt: Date): Promise<void>;
  getAdminBySession(tokenHash: string): Promise<{ id: string; email: string; role: "service" | "site"; tenantId: string | null } | null>;
  deleteAdminSession(tokenHash: string): Promise<void>;
  getTenantIdForForm(publicKey: string): Promise<string | null>;
  setFormStatus(publicKey: string, status: "active" | "disabled"): Promise<boolean>;
  listSubmissions(publicKey: string, limit: number): Promise<SubmissionRecord[]>;
  listFormSummaries(): Promise<FormSummary[]>;
  claimJobs(limit: number): Promise<OutboxJob[]>;
  markJobDelivered(id: string): Promise<void>;
  markJobFailed(id: string, attempts: number, error: string): Promise<void>;
  deleteExpiredSubmissions(now: Date): Promise<number>;
  close(): Promise<void>;
}

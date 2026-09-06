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
    expiresAt: Date;
  }): Promise<SubmissionResult>;
  listSubmissions(publicKey: string, limit: number): Promise<SubmissionRecord[]>;
  claimJobs(limit: number): Promise<OutboxJob[]>;
  markJobDelivered(id: string): Promise<void>;
  markJobFailed(id: string, attempts: number, error: string): Promise<void>;
  deleteExpiredSubmissions(now: Date): Promise<number>;
  close(): Promise<void>;
}

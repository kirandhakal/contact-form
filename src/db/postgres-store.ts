import pg from "pg";
import type {
  CreateFormInput,
  DestinationRecord,
  FormRecord,
  JsonObject,
  OutboxJob,
  Store,
  SubmissionRecord,
  SubmissionResult,
  SubmissionStatus
} from "../types.js";

const { Pool } = pg;

function mapForm(row: pg.QueryResultRow): FormRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    publicKey: row.public_key,
    name: row.name,
    status: row.status,
    allowedOrigins: row.allowed_origins,
    successMessage: row.success_message,
    honeypotField: row.honeypot_field,
    version: Number(row.version),
    schema: row.schema
  };
}

function mapSubmission(row: pg.QueryResultRow): SubmissionRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    formId: row.form_id,
    formVersion: Number(row.form_version),
    payload: row.payload,
    status: row.status,
    sourceOrigin: row.source_origin ?? undefined,
    sourceIpHash: row.source_ip_hash,
    idempotencyKey: row.idempotency_key ?? undefined,
    expiresAt: row.expires_at instanceof Date ? row.expires_at.toISOString() : row.expires_at,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at
  };
}

function mapDestination(row: pg.QueryResultRow): DestinationRecord {
  return {
    id: row.destination_id ?? row.id,
    formId: row.destination_form_id ?? row.form_id,
    kind: row.kind,
    config: row.config,
    secret: row.secret,
    active: row.active
  };
}

export class PostgresStore implements Store {
  private readonly pool: pg.Pool;

  constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl });
  }

  async ready(): Promise<boolean> {
    try {
      await this.pool.query("select 1");
      return true;
    } catch {
      return false;
    }
  }

  async createForm(input: CreateFormInput, publicKey: string): Promise<FormRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const tenant = await client.query("insert into tenants(name) values($1) returning id", [input.tenantName]);
      const form = await client.query(
        `insert into forms(tenant_id, public_key, name, allowed_origins, success_message, honeypot_field)
         values($1, $2, $3, $4, $5, $6)
         returning *`,
        [
          tenant.rows[0].id,
          publicKey,
          input.name,
          input.allowedOrigins,
          input.successMessage ?? "Thank you. We received your message.",
          input.honeypotField ?? "_website"
        ]
      );
      await client.query("insert into form_versions(form_id, version, schema) values($1, 1, $2)", [
        form.rows[0].id,
        input.schema
      ]);
      for (const destination of input.destinations ?? []) {
        await client.query(
          "insert into destinations(form_id, kind, config, secret, active) values($1, $2, $3, $4, true)",
          [form.rows[0].id, destination.kind, destination.config, destination.secret ?? null]
        );
      }
      await client.query("commit");
      return { ...mapForm({ ...form.rows[0], version: 1, schema: input.schema }), tenantId: tenant.rows[0].id };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async getActiveForm(publicKey: string): Promise<FormRecord | null> {
    const result = await this.pool.query(
      `select f.*, fv.version, fv.schema
       from forms f
       join lateral (
         select version, schema from form_versions
         where form_id = f.id
         order by version desc
         limit 1
       ) fv on true
       where f.public_key = $1 and f.status = 'active'`,
      [publicKey]
    );
    return result.rowCount ? mapForm(result.rows[0]) : null;
  }

  async createSubmission(args: {
    form: FormRecord;
    payload: JsonObject;
    status: SubmissionStatus;
    sourceOrigin?: string;
    sourceIpHash: string;
    idempotencyKey?: string;
    expiresAt: Date;
  }): Promise<SubmissionResult> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      if (args.idempotencyKey) {
        const existing = await client.query(
          "select * from submissions where form_id = $1 and idempotency_key = $2",
          [args.form.id, args.idempotencyKey]
        );
        if (existing.rowCount) {
          await client.query("commit");
          return { submission: mapSubmission(existing.rows[0]), duplicate: true };
        }
      }

      const inserted = await client.query(
        `insert into submissions(tenant_id, form_id, form_version, payload, status, source_origin, source_ip_hash, idempotency_key, expires_at)
         values($1, $2, $3, $4, $5, $6, $7, $8, $9)
         returning *`,
        [
          args.form.tenantId,
          args.form.id,
          args.form.version,
          args.payload,
          args.status,
          args.sourceOrigin ?? null,
          args.sourceIpHash,
          args.idempotencyKey ?? null,
          args.expiresAt
        ]
      );
      if (args.status === "accepted") {
        await client.query(
          `insert into outbox_jobs(submission_id, destination_id)
           select $1, id from destinations where form_id = $2 and active = true`,
          [inserted.rows[0].id, args.form.id]
        );
      }
      await client.query("commit");
      return { submission: mapSubmission(inserted.rows[0]), duplicate: false };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async listSubmissions(publicKey: string, limit: number): Promise<SubmissionRecord[]> {
    const result = await this.pool.query(
      `select s.*
       from submissions s
       join forms f on f.id = s.form_id
       where f.public_key = $1 and s.status <> 'deleted'
       order by s.created_at desc
       limit $2`,
      [publicKey, limit]
    );
    return result.rows.map(mapSubmission);
  }

  async claimJobs(limit: number): Promise<OutboxJob[]> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const result = await client.query(
        `with claimed as (
          select
            j.id,
            j.attempts,
            s.id as submission_id,
            s.tenant_id,
            s.form_id,
            s.form_version,
            s.payload,
            s.status as submission_status,
            s.source_origin,
            s.source_ip_hash,
            s.idempotency_key,
            s.expires_at,
            s.created_at,
            f.name as form_name,
            d.id as destination_id,
            d.form_id as destination_form_id,
            d.kind,
            d.config,
            d.secret,
            d.active
          from outbox_jobs j
          join submissions s on s.id = j.submission_id
          join forms f on f.id = s.form_id
          join destinations d on d.id = j.destination_id
          where j.status in ('pending', 'failed') and j.available_at <= now()
          order by j.available_at asc
          limit $1
          for update of j skip locked
        )
        update outbox_jobs j
        set status = 'processing', updated_at = now()
        from claimed
        where j.id = claimed.id
        returning
          j.id,
          claimed.attempts,
          claimed.submission_id,
          claimed.tenant_id,
          claimed.form_id,
          claimed.form_version,
          claimed.payload,
          claimed.submission_status as status,
          claimed.source_origin,
          claimed.source_ip_hash,
          claimed.idempotency_key,
          claimed.expires_at,
          claimed.created_at,
          claimed.form_name,
          claimed.destination_id,
          claimed.destination_form_id,
          claimed.kind,
          claimed.config,
          claimed.secret,
          claimed.active`,
        [limit]
      );
      await client.query("commit");
      return result.rows.map((row) => ({
        id: row.id,
        attempts: Number(row.attempts),
        submission: mapSubmission(row),
        form: { id: row.form_id, name: row.form_name },
        destination: mapDestination(row)
      }));
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async markJobDelivered(id: string): Promise<void> {
    await this.pool.query("update outbox_jobs set status = 'delivered', updated_at = now() where id = $1", [id]);
  }

  async markJobFailed(id: string, attempts: number, error: string): Promise<void> {
    const dead = attempts >= 8;
    const delaySeconds = Math.min(3600, 10 * 2 ** Math.max(0, attempts - 1));
    await this.pool.query(
      `update outbox_jobs
       set status = $2, attempts = $3, available_at = now() + ($4 || ' seconds')::interval,
           last_error = $5, updated_at = now()
       where id = $1`,
      [id, dead ? "dead" : "failed", attempts, delaySeconds, error.slice(0, 1000)]
    );
  }

  async deleteExpiredSubmissions(now: Date): Promise<number> {
    const result = await this.pool.query(
      "update submissions set status = 'deleted', payload = '{}'::jsonb where status <> 'deleted' and expires_at <= $1",
      [now]
    );
    return result.rowCount ?? 0;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

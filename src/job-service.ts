import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { CmhError, type ScopeContext } from "@carmediahub/sdk";

const identifier = /^[a-z][a-z0-9_.-]{0,95}$/u;
const now = () => new Date().toISOString();
export const MAX_ACTIVE_JOBS_PER_SCOPE = 10;
export const MAX_ACTIVE_MEDIA_JOBS_PER_INSTALLATION = 1;
export const MAX_JOB_PAYLOAD_BYTES = 64 * 1024;
export const INTERRUPTED_JOB_ERROR = "CMH.JOBS.INTERRUPTED";

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export interface PluginJob { id: string; type: string; status: JobStatus; progress: number; payload: unknown; result?: unknown; errorCode?: string; createdAt: string; updatedAt: string; completedAt?: string; }

function assertIdentifier(value: string, field: string): void {
  if (!identifier.test(value)) throw new Error(`${field} is invalid`);
}

function scopeValues(scope: ScopeContext): [string, string, string] {
  assertIdentifier(scope.organizationId, "organizationId");
  assertIdentifier(scope.userId, "userId");
  assertIdentifier(scope.installationId, "installationId");
  return [scope.organizationId, scope.userId, scope.installationId];
}

function jobFromRow(row: Record<string, string | number | null>): PluginJob {
  return {
    id: String(row.id), type: String(row.type), status: String(row.status) as JobStatus, progress: Number(row.progress), payload: JSON.parse(String(row.payload_json)),
    ...(row.result_json === null ? {} : { result: JSON.parse(String(row.result_json)) }),
    ...(row.error_code === null ? {} : { errorCode: String(row.error_code) }),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at), ...(row.completed_at === null ? {} : { completedAt: String(row.completed_at) })
  };
}

/** Core-only job service. Every read and transition is bound to a plugin scope. */
export class PluginJobService {
  constructor(private readonly db: DatabaseSync) {}

  /** Mark work that was running when Core stopped; queued work remains resumable for a future executor. */
  recoverInterrupted(): number {
    const timestamp = now();
    const result = this.db.prepare("UPDATE plugin_jobs SET status = 'failed', error_code = ?, updated_at = ?, completed_at = ? WHERE status = 'running'")
      .run(INTERRUPTED_JOB_ERROR, timestamp, timestamp);
    return Number(result.changes);
  }

  enqueue(scope: ScopeContext, type: string, payload: unknown): PluginJob {
    const [organizationId, userId, installationId] = scopeValues(scope);
    assertIdentifier(type, "type");
    const payloadJson = JSON.stringify(payload);
    if (payloadJson === undefined) throw new Error("Job payload must be JSON serializable");
    if (Buffer.byteLength(payloadJson, "utf8") > MAX_JOB_PAYLOAD_BYTES) throw new CmhError({ code: "CMH.JOBS.PAYLOAD_TOO_LARGE", messageKey: "errors.jobs.payloadTooLarge", retryable: false, diagnosticId: "diag_jobs_payload_size" });
    const active = this.db.prepare("SELECT COUNT(*) AS count FROM plugin_jobs WHERE organization_id = ? AND user_id = ? AND installation_id = ? AND status IN ('queued', 'running')").get(organizationId, userId, installationId) as { count: number };
    if (Number(active.count) >= MAX_ACTIVE_JOBS_PER_SCOPE) throw new CmhError({ code: "CMH.JOBS.QUEUE_FULL", messageKey: "errors.jobs.queueFull", retryable: true, diagnosticId: "diag_jobs_queue_full", details: { limit: MAX_ACTIVE_JOBS_PER_SCOPE } });
    const createdAt = now();
    const job: PluginJob = { id: `job_${crypto.randomUUID()}`, type, status: "queued", progress: 0, payload, createdAt, updatedAt: createdAt };
    this.db.prepare(`INSERT INTO plugin_jobs (id, organization_id, user_id, installation_id, type, payload_json, status, progress, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(job.id, organizationId, userId, installationId, type, payloadJson, job.status, job.progress, createdAt, createdAt);
    return job;
  }

  enqueueMediaTransform(scope: ScopeContext, type: "media.remux" | "media.transcode", payload: unknown): PluginJob {
    const [organizationId, userId, installationId] = scopeValues(scope);
    const active = this.db.prepare("SELECT COUNT(*) AS count FROM plugin_jobs WHERE organization_id = ? AND user_id = ? AND installation_id = ? AND type IN ('media.remux', 'media.transcode') AND status IN ('queued', 'running')").get(organizationId, userId, installationId) as { count: number };
    if (Number(active.count) >= MAX_ACTIVE_MEDIA_JOBS_PER_INSTALLATION) throw new CmhError({ code: "CMH.MEDIA.QUOTA_EXCEEDED", messageKey: "errors.media.quotaExceeded", retryable: true, diagnosticId: "diag_media_job_quota", details: { limit: MAX_ACTIVE_MEDIA_JOBS_PER_INSTALLATION } });
    return this.enqueue(scope, type, payload);
  }

  /** Atomically claims the oldest queued job for a Core-registered handler. */
  claimNext(scope: ScopeContext, types: readonly string[]): PluginJob | undefined {
    const [organizationId, userId, installationId] = scopeValues(scope);
    const allowedTypes = [...new Set(types)];
    allowedTypes.forEach((type) => assertIdentifier(type, "type"));
    if (allowedTypes.length === 0) return undefined;
    const placeholders = allowedTypes.map(() => "?").join(", ");
    const timestamp = now();
    const claimed = this.db.prepare(`UPDATE plugin_jobs SET status = 'running', updated_at = ?
      WHERE id = (SELECT id FROM plugin_jobs WHERE organization_id = ? AND user_id = ? AND installation_id = ? AND status = 'queued' AND type IN (${placeholders}) ORDER BY created_at ASC LIMIT 1)
      AND status = 'queued' RETURNING *`).get(timestamp, organizationId, userId, installationId, ...allowedTypes) as Record<string, string | number | null> | undefined;
    return claimed === undefined ? undefined : jobFromRow(claimed);
  }

  list(scope: ScopeContext, limit = 100): PluginJob[] {
    const [organizationId, userId, installationId] = scopeValues(scope);
    return (this.db.prepare(`SELECT * FROM plugin_jobs WHERE organization_id = ? AND user_id = ? AND installation_id = ? ORDER BY created_at DESC LIMIT ?`)
      .all(organizationId, userId, installationId, Math.min(Math.max(limit, 1), 500)) as Array<Record<string, string | number | null>>).map(jobFromRow);
  }

  listOrganization(organizationId: string, limit = 200): Array<PluginJob & { userId: string; installationId: string }> {
    assertIdentifier(organizationId, "organizationId");
    return (this.db.prepare("SELECT * FROM plugin_jobs WHERE organization_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(organizationId, Math.min(Math.max(limit, 1), 500)) as Array<Record<string, string | number | null>>).map((row) => ({ ...jobFromRow(row), userId: String(row.user_id), installationId: String(row.installation_id) }));
  }

  cancelOrganization(organizationId: string, id: string): PluginJob | undefined {
    assertIdentifier(organizationId, "organizationId");
    if (!id.startsWith("job_")) throw new Error("job id is invalid");
    const current = this.db.prepare("SELECT * FROM plugin_jobs WHERE id = ? AND organization_id = ?").get(id, organizationId) as Record<string, string | number | null> | undefined;
    if (current === undefined || !["queued", "running"].includes(String(current.status))) return undefined;
    const completedAt = now();
    this.db.prepare("UPDATE plugin_jobs SET status = 'cancelled', updated_at = ?, completed_at = ? WHERE id = ? AND organization_id = ?").run(completedAt, completedAt, id, organizationId);
    return jobFromRow(this.db.prepare("SELECT * FROM plugin_jobs WHERE id = ?").get(id) as Record<string, string | number | null>);
  }

  transition(scope: ScopeContext, id: string, status: JobStatus, options: { progress?: number; result?: unknown; errorCode?: string } = {}): PluginJob | undefined {
    const [organizationId, userId, installationId] = scopeValues(scope);
    if (!id.startsWith("job_")) throw new Error("job id is invalid");
    const current = this.db.prepare(`SELECT * FROM plugin_jobs WHERE id = ? AND organization_id = ? AND user_id = ? AND installation_id = ?`).get(id, organizationId, userId, installationId) as Record<string, string | number | null> | undefined;
    if (current === undefined || !["queued", "running"].includes(String(current.status))) return undefined;
    const allowed = (current.status === "queued" && ["running", "cancelled"].includes(status)) || (current.status === "running" && ["succeeded", "failed", "cancelled"].includes(status));
    if (!allowed) throw new Error("Invalid job transition");
    const progress = options.progress === undefined ? Number(current.progress) : Math.min(Math.max(Math.floor(options.progress), 0), 100);
    const resultJson = options.result === undefined ? null : JSON.stringify(options.result);
    if (options.result !== undefined && resultJson === undefined) throw new Error("Job result must be JSON serializable");
    if (resultJson !== null && Buffer.byteLength(resultJson, "utf8") > MAX_JOB_PAYLOAD_BYTES) throw new CmhError({ code: "CMH.JOBS.RESULT_TOO_LARGE", messageKey: "errors.jobs.resultTooLarge", retryable: false, diagnosticId: "diag_jobs_result_size" });
    const completedAt = ["succeeded", "failed", "cancelled"].includes(status) ? now() : null;
    const updatedAt = now();
    this.db.prepare(`UPDATE plugin_jobs SET status = ?, progress = ?, result_json = ?, error_code = ?, updated_at = ?, completed_at = ? WHERE id = ?`)
      .run(status, progress, resultJson, options.errorCode ?? null, updatedAt, completedAt, id);
    const updated = this.db.prepare("SELECT * FROM plugin_jobs WHERE id = ?").get(id) as Record<string, string | number | null>;
    return jobFromRow(updated);
  }
}

import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { HistoryEntry, HistoryQuery, ScopeContext } from "@carmediahub/sdk";

const now = () => new Date().toISOString();

export class HistoryService {
  constructor(private readonly db: DatabaseSync) {}
  record(scope: ScopeContext, input: Omit<HistoryEntry, "id" | "visitedAt" | "pluginId">): HistoryEntry {
    if (!/^[a-z][a-z0-9_.-]{0,63}$/u.test(input.subjectType) || !/^[A-Za-z0-9._:-]{1,160}$/u.test(input.subjectId) || input.title.trim().length === 0 || !input.route.startsWith("/")) throw new Error("Invalid history entry");
    const entry: HistoryEntry = { ...input, id: `history_${crypto.randomUUID()}`, pluginId: scope.installationId, title: input.title.trim(), visitedAt: now() };
    this.db.prepare("INSERT INTO platform_history (id, organization_id, user_id, installation_id, subject_type, subject_id, plugin_id, route, title, category, visited_at, source_device, metadata_digest) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(entry.id, scope.organizationId, scope.userId, scope.installationId, entry.subjectType, entry.subjectId, entry.pluginId, entry.route, entry.title, entry.category ?? null, entry.visitedAt, entry.sourceDevice, entry.metadataDigest ?? null);
    return entry;
  }
  query(scope: ScopeContext, options: HistoryQuery = {}): HistoryEntry[] {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const rows = this.db.prepare("SELECT * FROM platform_history WHERE organization_id = ? AND user_id = ? AND installation_id = ? ORDER BY visited_at DESC LIMIT ?").all(scope.organizationId, scope.userId, scope.installationId, limit) as Array<Record<string, string | null>>;
    const keyword = options.keyword?.trim().toLocaleLowerCase();
    return rows.map((row) => ({ id: String(row.id), subjectType: String(row.subject_type), subjectId: String(row.subject_id), pluginId: String(row.plugin_id), route: String(row.route), title: String(row.title), ...(row.category === null ? {} : { category: row.category }), visitedAt: String(row.visited_at), sourceDevice: row.source_device as HistoryEntry["sourceDevice"], ...(row.metadata_digest === null ? {} : { metadataDigest: row.metadata_digest }) })).filter((entry) => (options.category === undefined || entry.category === options.category) && (keyword === undefined || `${entry.title} ${entry.route}`.toLocaleLowerCase().includes(keyword)));
  }
  clear(scope: ScopeContext, options: Pick<HistoryQuery, "category"> = {}): number {
    const result = options.category === undefined ? this.db.prepare("DELETE FROM platform_history WHERE organization_id = ? AND user_id = ? AND installation_id = ?").run(scope.organizationId, scope.userId, scope.installationId) : this.db.prepare("DELETE FROM platform_history WHERE organization_id = ? AND user_id = ? AND installation_id = ? AND category = ?").run(scope.organizationId, scope.userId, scope.installationId, options.category);
    return Number(result.changes);
  }
}

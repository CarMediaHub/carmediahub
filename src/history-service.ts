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
    return this.queryPage(["organization_id = ?", "user_id = ?", "installation_id = ?"], [scope.organizationId, scope.userId, scope.installationId], options).entries;
  }

  queryPage(where: string[], values: string[], options: HistoryQuery = {}): { entries: HistoryEntry[]; total: number } {
    const clauses = [...where];
    const parameters = [...values];
    if (options.pluginId !== undefined) { clauses.push("plugin_id = ?"); parameters.push(options.pluginId); }
    if (options.category !== undefined) { clauses.push("category = ?"); parameters.push(options.category); }
    if (options.keyword?.trim() !== undefined && options.keyword.trim() !== "") { clauses.push("LOWER(title || ' ' || route) LIKE ?"); parameters.push(`%${options.keyword.trim().toLocaleLowerCase()}%`); }
    const predicate = clauses.join(" AND ");
    const total = Number((this.db.prepare(`SELECT COUNT(*) AS count FROM platform_history WHERE ${predicate}`).get(...parameters) as { count: number | bigint }).count);
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const offset = Math.max(options.offset ?? 0, 0);
    const rows = this.db.prepare(`SELECT * FROM platform_history WHERE ${predicate} ORDER BY visited_at DESC LIMIT ? OFFSET ?`).all(...parameters, limit, offset) as Array<Record<string, string | null>>;
    return { total, entries: rows.map((row) => ({ id: String(row.id), subjectType: String(row.subject_type), subjectId: String(row.subject_id), pluginId: String(row.plugin_id), route: String(row.route), title: String(row.title), ...(row.category === null ? {} : { category: row.category }), visitedAt: String(row.visited_at), sourceDevice: row.source_device as HistoryEntry["sourceDevice"], ...(row.metadata_digest === null ? {} : { metadataDigest: row.metadata_digest }) })) };
  }
  queryUser(organizationId: string, userId: string, options: HistoryQuery = {}): HistoryEntry[] {
    return this.queryPage(["organization_id = ?", "user_id = ?"], [organizationId, userId], options).entries;
  }

  queryUserPage(organizationId: string, userId: string, options: HistoryQuery = {}): { entries: HistoryEntry[]; total: number } {
    return this.queryPage(["organization_id = ?", "user_id = ?"], [organizationId, userId], options);
  }
  clear(scope: ScopeContext, options: Pick<HistoryQuery, "category"> = {}): number {
    const result = options.category === undefined ? this.db.prepare("DELETE FROM platform_history WHERE organization_id = ? AND user_id = ? AND installation_id = ?").run(scope.organizationId, scope.userId, scope.installationId) : this.db.prepare("DELETE FROM platform_history WHERE organization_id = ? AND user_id = ? AND installation_id = ? AND category = ?").run(scope.organizationId, scope.userId, scope.installationId, options.category);
    return Number(result.changes);
  }
  clearUser(organizationId: string, userId: string, options: Pick<HistoryQuery, "category" | "pluginId"> = {}): number {
    const clauses = ["organization_id = ?", "user_id = ?"];
    const values: string[] = [organizationId, userId];
    if (options.category !== undefined) { clauses.push("category = ?"); values.push(options.category); }
    if (options.pluginId !== undefined) { clauses.push("plugin_id = ?"); values.push(options.pluginId); }
    return Number(this.db.prepare(`DELETE FROM platform_history WHERE ${clauses.join(" AND ")}`).run(...values).changes);
  }
}

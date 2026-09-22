import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { CatalogEntry, CatalogQuery, ScopeContext } from "@carmediahub/sdk";

const now = () => new Date().toISOString();

export class CatalogService {
  constructor(private readonly db: DatabaseSync) {}
  register(scope: ScopeContext, input: Omit<CatalogEntry, "id" | "pluginId" | "updatedAt"> & { id?: string }): CatalogEntry {
    if (!/^[a-z][a-z0-9_.-]{0,63}$/u.test(input.subjectType) || !/^[A-Za-z0-9._:-]{1,160}$/u.test(input.subjectId) || input.title.trim().length === 0 || !/^[a-z][a-z0-9_.-]{0,63}$/u.test(input.category) || !input.route.startsWith("/")) throw new Error("Invalid catalog entry");
    const entry: CatalogEntry = { ...input, id: input.id ?? `catalog_${crypto.randomUUID()}`, pluginId: scope.installationId, title: input.title.trim(), updatedAt: now() };
    this.db.prepare("INSERT OR REPLACE INTO catalog_entries (id, organization_id, user_id, installation_id, subject_type, subject_id, plugin_id, title, description, category, route, updated_at, metadata_digest) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(entry.id, scope.organizationId, scope.userId, scope.installationId, entry.subjectType, entry.subjectId, entry.pluginId, entry.title, entry.description ?? null, entry.category, entry.route, entry.updatedAt, entry.metadataDigest ?? null);
    return entry;
  }
  query(scope: ScopeContext, options: CatalogQuery = {}): CatalogEntry[] {
    return this.queryPage(["organization_id = ?", "user_id = ?", "installation_id = ?"], [scope.organizationId, scope.userId, scope.installationId], options).entries;
  }

  queryPage(where: string[], values: string[], options: CatalogQuery = {}): { entries: CatalogEntry[]; total: number } {
    const clauses = [...where];
    const parameters = [...values];
    if (options.category !== undefined) { clauses.push("category = ?"); parameters.push(options.category); }
    if (options.keyword?.trim() !== undefined && options.keyword.trim() !== "") { clauses.push("LOWER(title || ' ' || COALESCE(description, '')) LIKE ?"); parameters.push(`%${options.keyword.trim().toLocaleLowerCase()}%`); }
    const predicate = clauses.join(" AND ");
    const total = Number((this.db.prepare(`SELECT COUNT(*) AS count FROM catalog_entries WHERE ${predicate}`).get(...parameters) as { count: number | bigint }).count);
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const offset = Math.max(options.offset ?? 0, 0);
    const rows = this.db.prepare(`SELECT * FROM catalog_entries WHERE ${predicate} ORDER BY updated_at DESC LIMIT ? OFFSET ?`).all(...parameters, limit, offset) as Array<Record<string, string | null>>;
    return { total, entries: rows.map((row) => ({ id: String(row.id), pluginId: String(row.plugin_id), subjectType: String(row.subject_type), subjectId: String(row.subject_id), title: String(row.title), ...(row.description === null ? {} : { description: row.description }), category: String(row.category), route: String(row.route), updatedAt: String(row.updated_at), ...(row.metadata_digest === null ? {} : { metadataDigest: row.metadata_digest }) })) };
  }
  queryUser(organizationId: string, userId: string, options: CatalogQuery = {}): CatalogEntry[] {
    return this.queryPage(["organization_id = ?", "user_id = ?"], [organizationId, userId], options).entries;
  }

  queryUserPage(organizationId: string, userId: string, options: CatalogQuery = {}): { entries: CatalogEntry[]; total: number } {
    return this.queryPage(["organization_id = ?", "user_id = ?"], [organizationId, userId], options);
  }
  remove(scope: ScopeContext, id: string): boolean {
    return Number(this.db.prepare("DELETE FROM catalog_entries WHERE id = ? AND organization_id = ? AND user_id = ? AND installation_id = ?").run(id, scope.organizationId, scope.userId, scope.installationId).changes) === 1;
  }
}

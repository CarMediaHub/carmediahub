import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Notification, NotificationSeverity } from "@carmediahub/sdk";

export interface NotificationScope { organizationId: string; userId: string; installationId: string; }

export class NotificationService {
  constructor(private readonly db: DatabaseSync) {}

  publish(scope: NotificationScope, input: { severity: NotificationSeverity; title: string; body?: string }): Notification {
    if (!["info", "success", "warning", "error"].includes(input.severity) || input.title.trim().length === 0 || input.title.length > 160 || (input.body !== undefined && input.body.length > 4000)) throw new Error("Invalid notification");
    const notification: Notification = { id: `notification_${crypto.randomUUID()}`, pluginId: scope.installationId, severity: input.severity, title: input.title.trim(), ...(input.body === undefined ? {} : { body: input.body }), createdAt: new Date().toISOString() };
    this.db.prepare("INSERT INTO platform_notifications (id, organization_id, user_id, installation_id, plugin_id, severity, title, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(notification.id, scope.organizationId, scope.userId, scope.installationId, notification.pluginId, notification.severity, notification.title, notification.body ?? null, notification.createdAt);
    return notification;
  }

  list(scope: NotificationScope, options: { limit?: number; unreadOnly?: boolean } = {}): Notification[] {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const unread = options.unreadOnly ? " AND read_at IS NULL" : "";
    const rows = this.db.prepare(`SELECT * FROM platform_notifications WHERE organization_id = ? AND user_id = ? AND installation_id = ?${unread} ORDER BY created_at DESC LIMIT ?`).all(scope.organizationId, scope.userId, scope.installationId, limit) as Array<Record<string, string | null>>;
    return rows.map((row) => ({ id: row.id ?? "", pluginId: row.plugin_id ?? "", severity: row.severity as NotificationSeverity, title: row.title ?? "", ...(row.body === null ? {} : { body: row.body ?? "" }), createdAt: row.created_at ?? "", ...(row.read_at === null ? {} : { readAt: row.read_at ?? "" }) }));
  }

  listUser(organizationId: string, userId: string, options: { limit?: number; unreadOnly?: boolean } = {}): Notification[] {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const unread = options.unreadOnly ? " AND read_at IS NULL" : "";
    const rows = this.db.prepare(`SELECT * FROM platform_notifications WHERE organization_id = ? AND user_id = ?${unread} ORDER BY created_at DESC LIMIT ?`).all(organizationId, userId, limit) as Array<Record<string, string | null>>;
    return rows.map((row) => ({ id: row.id ?? "", pluginId: row.plugin_id ?? "", severity: row.severity as NotificationSeverity, title: row.title ?? "", ...(row.body === null ? {} : { body: row.body ?? "" }), createdAt: row.created_at ?? "", ...(row.read_at === null ? {} : { readAt: row.read_at ?? "" }) }));
  }

  markRead(scope: NotificationScope, id: string): boolean {
    return this.db.prepare("UPDATE platform_notifications SET read_at = ? WHERE id = ? AND organization_id = ? AND user_id = ? AND installation_id = ? AND read_at IS NULL").run(new Date().toISOString(), id, scope.organizationId, scope.userId, scope.installationId).changes === 1;
  }

  markAllRead(scope: NotificationScope): number {
    return Number(this.db.prepare("UPDATE platform_notifications SET read_at = ? WHERE organization_id = ? AND user_id = ? AND installation_id = ? AND read_at IS NULL").run(new Date().toISOString(), scope.organizationId, scope.userId, scope.installationId).changes);
  }

  markReadUser(organizationId: string, userId: string, id: string): boolean {
    return this.db.prepare("UPDATE platform_notifications SET read_at = ? WHERE id = ? AND organization_id = ? AND user_id = ? AND read_at IS NULL").run(new Date().toISOString(), id, organizationId, userId).changes === 1;
  }

  markAllReadUser(organizationId: string, userId: string): number {
    return Number(this.db.prepare("UPDATE platform_notifications SET read_at = ? WHERE organization_id = ? AND user_id = ? AND read_at IS NULL").run(new Date().toISOString(), organizationId, userId).changes);
  }
}

import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { decryptSecret, encryptSecret, generateTotpSecret, hashPassword, keyedHash, randomToken, verifyPassword, verifyTotp } from "./security.js";

const now = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;

export interface UserRecord { id: string; username: string; role: string; locale: string; organizationId: string; }
export interface ApplicationRecord { id: string; name: string; category: string; route: string; installationId: string; vehicleSupported: boolean; }
export interface EntryResolution { application: ApplicationRecord; userId: string; }
export interface EntryKeyRecord { id: string; applicationId: string; applicationName: string; route: string; expiresAt: string | null; revokedAt: string | null; createdAt: string; }
export interface TotpSetup { secret: string; otpauthUrl: string; }

export class Repository {
  constructor(private readonly db: DatabaseSync, private readonly serverKey: Buffer) {}

  initialized(): boolean { return this.db.prepare("SELECT 1 AS result FROM users LIMIT 1").get() !== undefined; }

  bootstrap(username: string, password: string, locale: string): UserRecord {
    if (this.initialized()) throw new Error("Deployment already initialized");
    const deploymentId = id("deployment");
    const organizationId = id("org");
    const userId = id("user");
    const createdAt = now();
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      this.db.prepare("INSERT INTO deployments (id, created_at, locale) VALUES (?, ?, ?)").run(deploymentId, createdAt, locale);
      this.db.prepare("INSERT INTO organizations (id, deployment_id, name) VALUES (?, ?, ?)").run(organizationId, deploymentId, "Default Organization");
      this.db.prepare("INSERT INTO users (id, organization_id, username, password_hash, role, locale, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(userId, organizationId, username, hashPassword(password), "admin", locale, createdAt);
      this.addBuiltinApplications();
      this.db.exec("COMMIT;");
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
    return { id: userId, username, role: "admin", locale, organizationId };
  }

  login(username: string, password: string, deviceLabel: string, otp?: string): { token: string; user: UserRecord } | "totp_required" | "totp_invalid" | undefined {
    const row = this.db.prepare("SELECT id, organization_id, username, password_hash, role, locale, revoked_at, totp_secret, totp_enabled FROM users WHERE username = ?").get(username) as Record<string, string | number | null> | undefined;
    if (row === undefined || row.revoked_at !== null || !verifyPassword(password, String(row.password_hash ?? ""))) return undefined;
    if (Number(row.totp_enabled) === 1) {
      if (otp === undefined || otp.length === 0) return "totp_required";
      const secret = decryptSecret(String(row.totp_secret), this.serverKey);
      if (!verifyTotp(secret, otp) && !this.consumeRecoveryCode(String(row.id), otp)) return "totp_invalid";
    }
    const token = randomToken();
    const createdAt = now();
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString();
    this.db.prepare("INSERT INTO sessions (id, user_id, token_hash, device_label, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id("session"), row.id ?? "", keyedHash(token, this.serverKey), deviceLabel.slice(0, 80), expiresAt, createdAt);
    return { token, user: this.userFromRow({ id: String(row.id), organization_id: String(row.organization_id), username: String(row.username), role: String(row.role), locale: String(row.locale) }) };
  }

  totpStatus(userId: string): { enabled: boolean } {
    const row = this.db.prepare("SELECT totp_enabled FROM users WHERE id = ?").get(userId) as { totp_enabled: number } | undefined;
    return { enabled: row !== undefined && Number(row.totp_enabled) === 1 };
  }

  beginTotpSetup(userId: string): TotpSetup {
    const secret = generateTotpSecret();
    this.db.prepare("UPDATE users SET totp_secret = ?, totp_enabled = 0 WHERE id = ?").run(encryptSecret(secret, this.serverKey), userId);
    const label = encodeURIComponent(`CarMediaHub:${userId}`);
    return { secret, otpauthUrl: `otpauth://totp/${label}?secret=${secret}&issuer=CarMediaHub` };
  }

  enableTotp(userId: string, code: string): string[] | undefined {
    const row = this.db.prepare("SELECT totp_secret FROM users WHERE id = ?").get(userId) as { totp_secret: string | null } | undefined;
    if (row?.totp_secret === null || row?.totp_secret === undefined || !verifyTotp(decryptSecret(row.totp_secret, this.serverKey), code)) return undefined;
    this.db.prepare("UPDATE users SET totp_enabled = 1 WHERE id = ?").run(userId);
    this.db.prepare("DELETE FROM recovery_codes WHERE user_id = ?").run(userId);
    const codes = Array.from({ length: 8 }, () => `${randomToken().slice(0, 4)}-${randomToken().slice(0, 4)}`.toUpperCase());
    const statement = this.db.prepare("INSERT INTO recovery_codes (id, user_id, code_hash, created_at) VALUES (?, ?, ?, ?)");
    for (const recoveryCode of codes) statement.run(id("recovery"), userId, keyedHash(recoveryCode, this.serverKey), now());
    return codes;
  }

  private consumeRecoveryCode(userId: string, code: string): boolean {
    const hash = keyedHash(code.toUpperCase(), this.serverKey);
    const row = this.db.prepare("SELECT id FROM recovery_codes WHERE user_id = ? AND code_hash = ? AND used_at IS NULL").get(userId, hash) as { id: string } | undefined;
    if (row === undefined) return false;
    this.db.prepare("UPDATE recovery_codes SET used_at = ? WHERE id = ?").run(now(), row.id);
    return true;
  }

  session(token: string): UserRecord | undefined {
    const row = this.db.prepare(`SELECT u.id, u.organization_id, u.username, u.role, u.locale
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.revoked_at IS NULL AND u.revoked_at IS NULL AND s.expires_at > ?`).get(keyedHash(token, this.serverKey), now()) as Record<string, string> | undefined;
    return row === undefined ? undefined : this.userFromRow(row);
  }

  revokeSession(token: string): void { this.db.prepare("UPDATE sessions SET revoked_at = ? WHERE token_hash = ?").run(now(), keyedHash(token, this.serverKey)); }

  applications(): ApplicationRecord[] {
    return (this.db.prepare("SELECT id, name, category, route, installation_id, vehicle_supported FROM applications WHERE enabled = 1 ORDER BY category, name").all() as Array<Record<string, string | number>>)
      .map((row) => ({ id: String(row.id), name: String(row.name), category: String(row.category), route: String(row.route), installationId: String(row.installation_id), vehicleSupported: Number(row.vehicle_supported) === 1 }));
  }

  addApplication(input: Omit<ApplicationRecord, "id">): ApplicationRecord {
    if (!input.route.startsWith("/apps/") && input.route !== "/system") throw new Error("Application routes must start with /apps/");
    const record = { ...input, id: id("app") };
    this.db.prepare("INSERT INTO applications (id, name, category, route, installation_id, vehicle_supported) VALUES (?, ?, ?, ?, ?, ?)")
      .run(record.id, record.name, record.category, record.route, record.installationId, record.vehicleSupported ? 1 : 0);
    return record;
  }

  createEntryKey(applicationId: string, userId: string, expiresAt?: string): { id: string; key: string } {
    const application = this.db.prepare("SELECT id FROM applications WHERE id = ? AND enabled = 1").get(applicationId);
    if (application === undefined) throw new Error("Application not found");
    const key = randomToken();
    const keyId = id("key");
    this.db.prepare("INSERT INTO entry_keys (id, key_hash, application_id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(keyId, keyedHash(key, this.serverKey), applicationId, userId, expiresAt ?? null, now());
    return { id: keyId, key };
  }

  resolveEntryKey(key: string, userId?: string): EntryResolution | undefined {
    const userClause = userId === undefined ? "" : " AND k.user_id = ?";
    const parameters = userId === undefined ? [keyedHash(key, this.serverKey), now()] : [keyedHash(key, this.serverKey), userId, now()];
    const row = this.db.prepare(`SELECT a.id, a.name, a.category, a.route, a.installation_id, a.vehicle_supported, k.user_id
      FROM entry_keys k JOIN applications a ON a.id = k.application_id
      WHERE k.key_hash = ?${userClause} AND k.revoked_at IS NULL AND a.enabled = 1
        AND (k.expires_at IS NULL OR k.expires_at > ?)`).get(...parameters) as (Record<string, string | number> & { user_id: string }) | undefined;
    if (row === undefined) return undefined;
    return { userId: String(row.user_id), application: { id: String(row.id), name: String(row.name), category: String(row.category), route: String(row.route), installationId: String(row.installation_id), vehicleSupported: Number(row.vehicle_supported) === 1 } };
  }

  revokeEntryKey(keyId: string): void { this.db.prepare("UPDATE entry_keys SET revoked_at = ? WHERE id = ?").run(now(), keyId); }

  entryKeys(userId: string): EntryKeyRecord[] {
    return (this.db.prepare(`SELECT k.id, k.application_id, a.name AS application_name, a.route,
      k.expires_at, k.revoked_at, k.created_at
      FROM entry_keys k JOIN applications a ON a.id = k.application_id
      WHERE k.user_id = ? ORDER BY k.created_at DESC`).all(userId) as Array<Record<string, string | null>>)
      .map((row) => ({
        id: String(row.id), applicationId: String(row.application_id), applicationName: String(row.application_name),
        route: String(row.route), expiresAt: row.expires_at ?? null, revokedAt: row.revoked_at ?? null, createdAt: String(row.created_at)
      }));
  }

  registerComponent(input: { id: string; version: string; executable: string; checksum: string }): void {
    if (input.executable.includes("..") || input.executable.startsWith("/") || /^[A-Za-z]:/.test(input.executable)) throw new Error("Managed component executable must be a relative path");
    this.db.prepare("INSERT OR REPLACE INTO managed_components (id, version, executable, checksum, installed_at, health) VALUES (?, ?, ?, ?, ?, ?)")
      .run(input.id, input.version, input.executable, input.checksum, now(), "unknown");
  }

  bindService(input: { componentId: string; name: string; endpoint: string }): void {
    this.db.prepare("INSERT INTO service_bindings (id, component_id, name, endpoint, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id("binding"), input.componentId, input.name, input.endpoint, now());
  }

  components(): Array<Record<string, string>> {
    return this.db.prepare("SELECT id, version, executable, checksum, installed_at, health FROM managed_components ORDER BY id").all() as Array<Record<string, string>>;
  }

  serviceBindings(): Array<Record<string, string>> {
    return this.db.prepare("SELECT id, component_id, name, endpoint, created_at FROM service_bindings ORDER BY name").all() as Array<Record<string, string>>;
  }

  audit(actorId: string | undefined, type: string, subject: string): void {
    this.db.prepare("INSERT INTO audit_events (id, actor_id, type, subject, created_at) VALUES (?, ?, ?, ?, ?)").run(id("audit"), actorId ?? null, type, subject, now());
  }

  private userFromRow(row: Record<string, string | null>): UserRecord {
    return { id: row.id ?? "", organizationId: row.organization_id ?? "", username: row.username ?? "", role: row.role ?? "", locale: row.locale ?? "en" };
  }

  private addBuiltinApplications(): void {
    this.addApplication({ name: "Management", category: "system", route: "/system", installationId: "core-management", vehicleSupported: false });
    this.addApplication({ name: "Diagnostics", category: "core-companion", route: "/apps/diagnostics", installationId: "core-diagnostics", vehicleSupported: true });
  }
}

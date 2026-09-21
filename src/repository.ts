import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { decryptSecret, encryptSecret, generateTotpSecret, hashPassword, keyedHash, randomToken, verifyPassword, verifyTotp } from "./security.js";
import type { PluginManifest } from "@carmediahub/sdk";

const now = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;

export interface UserRecord { id: string; username: string; role: string; locale: string; timeZone: string; theme: "light" | "dark" | "system"; density: "comfortable" | "compact"; organizationId: string; }
export interface SessionContext { user: UserRecord; sessionId: string; deviceLabel: string; }
export interface ApplicationRecord { id: string; name: string; category: string; route: string; installationId: string; vehicleSupported: boolean; }
export interface EntryResolution { application: ApplicationRecord; userId: string; }
export interface EntryKeyRecord { id: string; applicationId: string; applicationName: string; route: string; expiresAt: string | null; revokedAt: string | null; createdAt: string; }
export interface TotpSetup { secret: string; otpauthUrl: string; }
export interface ManagedUserRecord extends UserRecord { createdAt: string; revokedAt: string | null; }
export interface PluginInstallationRecord { id: string; packageId: string; packageVersion: string; runtime: string; status: "installed" | "disabled"; createdAt: string; updatedAt: string; }
export interface VerifiedPluginPackageRecord { packageId: string; packageVersion: string; digest: string; location: string; workerEntry: string; verifiedAt: string; }

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
    return { id: userId, username, role: "admin", locale, timeZone: "UTC", theme: "system", density: "comfortable", organizationId };
  }

  login(username: string, password: string, deviceLabel: string, otp?: string): { token: string; user: UserRecord } | "totp_required" | "totp_invalid" | undefined {
    const row = this.db.prepare("SELECT id, organization_id, username, password_hash, role, locale, time_zone, theme, density, revoked_at, totp_secret, totp_enabled FROM users WHERE username = ?").get(username) as Record<string, string | number | null> | undefined;
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
    return { token, user: this.userFromRow({ id: String(row.id), organization_id: String(row.organization_id), username: String(row.username), role: String(row.role), locale: String(row.locale), time_zone: String(row.time_zone), theme: String(row.theme), density: String(row.density) }) };
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
    const row = this.db.prepare(`SELECT u.id, u.organization_id, u.username, u.role, u.locale, u.time_zone, u.theme, u.density
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.revoked_at IS NULL AND u.revoked_at IS NULL AND s.expires_at > ?`).get(keyedHash(token, this.serverKey), now()) as Record<string, string> | undefined;
    return row === undefined ? undefined : this.userFromRow(row);
  }

  sessionContext(token: string): SessionContext | undefined {
    const row = this.db.prepare(`SELECT s.id AS session_id, s.device_label, u.id, u.organization_id, u.username, u.role, u.locale, u.time_zone, u.theme, u.density
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.revoked_at IS NULL AND u.revoked_at IS NULL AND s.expires_at > ?`).get(keyedHash(token, this.serverKey), now()) as Record<string, string> | undefined;
    if (row === undefined) return undefined;
    return { user: this.userFromRow(row), sessionId: row.session_id ?? "", deviceLabel: row.device_label ?? "" };
  }

  revokeSession(token: string): void { this.db.prepare("UPDATE sessions SET revoked_at = ? WHERE token_hash = ?").run(now(), keyedHash(token, this.serverKey)); }

  rateLimited(subject: string): boolean {
    const row = this.db.prepare("SELECT locked_until FROM rate_limit_buckets WHERE subject_hash = ?").get(keyedHash(subject, this.serverKey)) as { locked_until: string | null } | undefined;
    return row?.locked_until !== null && row?.locked_until !== undefined && row.locked_until > now();
  }

  recordFailedAttempt(subject: string, maxFailures = 5, windowMilliseconds = 600_000, lockMilliseconds = 900_000): boolean {
    const subjectHash = keyedHash(subject, this.serverKey);
    const current = new Date();
    const currentTime = current.toISOString();
    const row = this.db.prepare("SELECT window_started_at, failures, locked_until FROM rate_limit_buckets WHERE subject_hash = ?").get(subjectHash) as { window_started_at: string; failures: number; locked_until: string | null } | undefined;
    if (row?.locked_until !== null && row?.locked_until !== undefined && row.locked_until > currentTime) return true;
    const windowStart = row === undefined || current.getTime() - Date.parse(row.window_started_at) >= windowMilliseconds ? currentTime : row.window_started_at;
    const failures = windowStart === currentTime ? 1 : Number(row?.failures ?? 0) + 1;
    const lockedUntil = failures >= maxFailures ? new Date(current.getTime() + lockMilliseconds).toISOString() : null;
    this.db.prepare(`INSERT INTO rate_limit_buckets (subject_hash, window_started_at, failures, locked_until) VALUES (?, ?, ?, ?)
      ON CONFLICT(subject_hash) DO UPDATE SET window_started_at = excluded.window_started_at, failures = excluded.failures, locked_until = excluded.locked_until`)
      .run(subjectHash, windowStart, failures, lockedUntil);
    return lockedUntil !== null;
  }

  clearFailedAttempts(subject: string): void { this.db.prepare("DELETE FROM rate_limit_buckets WHERE subject_hash = ?").run(keyedHash(subject, this.serverKey)); }

  users(organizationId: string): ManagedUserRecord[] {
    return (this.db.prepare("SELECT id, organization_id, username, role, locale, time_zone, theme, density, created_at, revoked_at FROM users WHERE organization_id = ? ORDER BY created_at").all(organizationId) as Array<Record<string, string | null>>)
      .map((row) => ({ ...this.userFromRow(row), createdAt: String(row.created_at), revokedAt: row.revoked_at ?? null }));
  }

  createUser(input: { organizationId: string; username: string; password: string; role: string; locale: string }): UserRecord {
    if (input.role !== "admin" && input.role !== "member") throw new Error("Invalid role");
    const record = { id: id("user"), organizationId: input.organizationId, username: input.username, role: input.role, locale: input.locale, timeZone: "UTC", theme: "system" as const, density: "comfortable" as const };
    this.db.prepare("INSERT INTO users (id, organization_id, username, password_hash, role, locale, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(record.id, record.organizationId, record.username, hashPassword(input.password), record.role, record.locale, now());
    return record;
  }

  updateUserPreferences(userId: string, input: { locale?: unknown; timeZone?: unknown; theme?: unknown; density?: unknown }): UserRecord | undefined {
    const locale = input.locale === undefined ? undefined : (input.locale === "en" || input.locale === "zh-CN" || input.locale === "ko" ? input.locale : undefined);
    const timeZone = input.timeZone === undefined ? undefined : (typeof input.timeZone === "string" && input.timeZone.length <= 80 && (() => { try { new Intl.DateTimeFormat("en", { timeZone: input.timeZone }).format(); return true; } catch { return false; } })() ? input.timeZone : undefined);
    const theme = input.theme === undefined ? undefined : (input.theme === "light" || input.theme === "dark" || input.theme === "system" ? input.theme : undefined);
    const density = input.density === undefined ? undefined : (input.density === "comfortable" || input.density === "compact" ? input.density : undefined);
    if ((input.locale !== undefined && locale === undefined) || (input.timeZone !== undefined && timeZone === undefined) || (input.theme !== undefined && theme === undefined) || (input.density !== undefined && density === undefined)) return undefined;
    const current = this.db.prepare("SELECT locale, time_zone, theme, density FROM users WHERE id = ? AND revoked_at IS NULL").get(userId) as { locale: string; time_zone: string; theme: string; density: string } | undefined;
    if (current === undefined) return undefined;
    const result = this.db.prepare("UPDATE users SET locale = ?, time_zone = ?, theme = ?, density = ? WHERE id = ? AND revoked_at IS NULL").run(locale ?? current.locale, timeZone ?? current.time_zone, theme ?? current.theme, density ?? current.density, userId);
    if (result.changes !== 1) return undefined;
    const row = this.db.prepare("SELECT id, organization_id, username, role, locale, time_zone, theme, density FROM users WHERE id = ?").get(userId) as Record<string, string | null> | undefined;
    return row === undefined ? undefined : this.userFromRow(row);
  }

  revokeUser(userId: string, organizationId: string): "revoked" | "not_found" | "last_admin" {
    const target = this.db.prepare("SELECT id, role, revoked_at FROM users WHERE id = ? AND organization_id = ?").get(userId, organizationId) as { id: string; role: string; revoked_at: string | null } | undefined;
    if (target === undefined || target.revoked_at !== null) return "not_found";
    if (target.role === "admin") {
      const admins = this.db.prepare("SELECT COUNT(*) AS count FROM users WHERE organization_id = ? AND role = 'admin' AND revoked_at IS NULL").get(organizationId) as { count: number };
      if (Number(admins.count) <= 1) return "last_admin";
    }
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      this.db.prepare("UPDATE users SET revoked_at = ? WHERE id = ?").run(now(), userId);
      this.db.prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").run(now(), userId);
      this.db.exec("COMMIT;");
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
    return "revoked";
  }

  applications(): ApplicationRecord[] {
    return (this.db.prepare("SELECT id, name, category, route, installation_id, vehicle_supported FROM applications WHERE enabled = 1 ORDER BY category, name").all() as Array<Record<string, string | number>>)
      .map((row) => ({ id: String(row.id), name: String(row.name), category: String(row.category), route: String(row.route), installationId: String(row.installation_id), vehicleSupported: Number(row.vehicle_supported) === 1 }));
  }

  applicationForPath(requestPath: string): ApplicationRecord | undefined {
    return this.applications().find((application) => requestPath === application.route || requestPath.startsWith(`${application.route}/`));
  }

  runtimeScope(userId: string, installationId: string, sessionId = "gateway", deviceId = "gateway", presentation: { entry?: "navigation" | "key"; display?: { deviceClass: "desktop" | "mobile" | "vehicle" | "unknown"; input: Array<"touch" | "keyboard" | "pointer" | "remote">; fullscreenAvailable: boolean; viewport: { width: number; height: number } } } = {}): { deploymentId: string; organizationId: string; userId: string; deviceId: string; sessionId: string; installationId: string; locale: "en" | "zh-CN" | "ko"; timeZone: string; theme: "light" | "dark" | "system"; density: "comfortable" | "compact"; entry: "navigation" | "key"; display: { deviceClass: "desktop" | "mobile" | "vehicle" | "unknown"; input: Array<"touch" | "keyboard" | "pointer" | "remote">; fullscreenAvailable: boolean; viewport: { width: number; height: number } }; policyVersion: number } | undefined {
    const row = this.db.prepare(`SELECT u.organization_id, u.locale, u.time_zone, u.theme, u.density, o.deployment_id
      FROM users u JOIN organizations o ON o.id = u.organization_id
      WHERE u.id = ? AND u.revoked_at IS NULL`).get(userId) as { organization_id: string; locale: string; time_zone: string; theme: string; density: string; deployment_id: string } | undefined;
    if (row === undefined || this.pluginInstallation(installationId)?.status !== "installed") return undefined;
    const locale = row.locale === "zh-CN" || row.locale === "ko" ? row.locale : "en";
    return { deploymentId: row.deployment_id, organizationId: row.organization_id, userId, deviceId, sessionId, installationId, locale, timeZone: row.time_zone, theme: row.theme === "light" || row.theme === "dark" ? row.theme : "system", density: row.density === "compact" ? "compact" : "comfortable", entry: presentation.entry ?? "navigation", display: presentation.display ?? { deviceClass: "unknown", input: [], fullscreenAvailable: false, viewport: { width: 0, height: 0 } }, policyVersion: 1 };
  }

  addApplication(input: Omit<ApplicationRecord, "id">): ApplicationRecord {
    if (!input.route.startsWith("/apps/") && input.route !== "/system") throw new Error("Application routes must start with /apps/");
    const record = { ...input, id: id("app") };
    this.db.prepare("INSERT INTO applications (id, name, category, route, installation_id, vehicle_supported) VALUES (?, ?, ?, ?, ?, ?)")
      .run(record.id, record.name, record.category, record.route, record.installationId, record.vehicleSupported ? 1 : 0);
    return record;
  }

  installPlugin(manifest: PluginManifest): PluginInstallationRecord {
    const installationId = id("plugin");
    const createdAt = now();
    const route = `/apps/${manifest.id}/${installationId}`;
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      this.db.prepare("INSERT INTO plugin_installations (id, package_id, package_version, runtime, manifest_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(installationId, manifest.id, manifest.version, manifest.runtime, JSON.stringify(manifest), "installed", createdAt, createdAt);
      this.addApplication({ name: manifest.name.en, category: manifest.category, route, installationId, vehicleSupported: manifest.ui?.vehicleSupported ?? false });
      this.db.exec("COMMIT;");
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
    return { id: installationId, packageId: manifest.id, packageVersion: manifest.version, runtime: manifest.runtime, status: "installed", createdAt, updatedAt: createdAt };
  }

  pluginInstallations(): PluginInstallationRecord[] {
    return (this.db.prepare("SELECT id, package_id, package_version, runtime, status, created_at, updated_at FROM plugin_installations ORDER BY created_at DESC").all() as Array<Record<string, string>>)
      .map((row) => ({ id: row.id ?? "", packageId: row.package_id ?? "", packageVersion: row.package_version ?? "", runtime: row.runtime ?? "", status: row.status === "disabled" ? "disabled" : "installed", createdAt: row.created_at ?? "", updatedAt: row.updated_at ?? "" }));
  }

  pluginInstallation(installationId: string): PluginInstallationRecord | undefined {
    const row = this.db.prepare("SELECT id, package_id, package_version, runtime, status, created_at, updated_at FROM plugin_installations WHERE id = ?").get(installationId) as Record<string, string> | undefined;
    if (row === undefined) return undefined;
    return { id: row.id ?? "", packageId: row.package_id ?? "", packageVersion: row.package_version ?? "", runtime: row.runtime ?? "", status: row.status === "disabled" ? "disabled" : "installed", createdAt: row.created_at ?? "", updatedAt: row.updated_at ?? "" };
  }

  pluginHasCapability(installationId: string, capability: string): boolean {
    const row = this.db.prepare("SELECT manifest_json FROM plugin_installations WHERE id = ? AND status = 'installed'").get(installationId) as { manifest_json?: string } | undefined;
    if (row?.manifest_json === undefined) return false;
    try {
      const manifest = JSON.parse(row.manifest_json) as { capabilities?: unknown };
      return Array.isArray(manifest.capabilities) && manifest.capabilities.includes(capability);
    } catch { return false; }
  }

  registerVerifiedPluginPackage(input: Omit<VerifiedPluginPackageRecord, "verifiedAt">): void {
    if (!/^[a-z][a-z0-9-]{1,63}$/u.test(input.packageId) || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(input.packageVersion) || !/^[a-f0-9]{64}$/u.test(input.digest) || !/^plugins\/[A-Za-z0-9_./-]+$/u.test(input.location) || input.location.includes("..") || !/^\.\/[A-Za-z0-9_./-]+$/u.test(input.workerEntry) || input.workerEntry.includes("..")) throw new Error("Invalid verified plugin package record");
    this.db.prepare("INSERT OR REPLACE INTO verified_plugin_packages (package_id, package_version, digest, location, worker_entry, verified_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(input.packageId, input.packageVersion, input.digest, input.location, input.workerEntry, now());
  }

  verifiedPluginPackages(): VerifiedPluginPackageRecord[] {
    return (this.db.prepare("SELECT package_id, package_version, digest, location, worker_entry, verified_at FROM verified_plugin_packages ORDER BY verified_at DESC").all() as Array<Record<string, string>>)
      .map((row) => ({ packageId: row.package_id ?? "", packageVersion: row.package_version ?? "", digest: row.digest ?? "", location: row.location ?? "", workerEntry: row.worker_entry ?? "", verifiedAt: row.verified_at ?? "" }));
  }

  disablePlugin(installationId: string): boolean {
    const current = this.db.prepare("SELECT id FROM plugin_installations WHERE id = ? AND status = 'installed'").get(installationId);
    if (current === undefined) return false;
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const updatedAt = now();
      this.db.prepare("UPDATE plugin_installations SET status = 'disabled', updated_at = ? WHERE id = ?").run(updatedAt, installationId);
      this.db.prepare("UPDATE applications SET enabled = 0 WHERE installation_id = ?").run(installationId);
      this.db.exec("COMMIT;");
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
    return true;
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
    if (!/^[a-z][a-z0-9-]{1,63}$/u.test(input.componentId) || input.name.trim().length === 0 || input.name.trim().length > 80 || input.endpoint.length > 2048) throw new Error("Invalid service binding identity");
    const endpoint = new URL(input.endpoint);
    if (!(endpoint.protocol === "http:" || endpoint.protocol === "https:") || endpoint.username !== "" || endpoint.password !== "" || endpoint.search !== "" || endpoint.hash !== "" || endpoint.hostname === "" || (endpoint.port !== "" && (!/^\d+$/u.test(endpoint.port) || Number(endpoint.port) < 1 || Number(endpoint.port) > 65535))) throw new Error("Invalid service binding endpoint");
    this.db.prepare("INSERT INTO service_bindings (id, component_id, name, endpoint, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id("binding"), input.componentId, input.name.trim(), endpoint.toString(), now());
  }

  components(): Array<Record<string, string>> {
    return this.db.prepare("SELECT id, version, executable, checksum, installed_at, health FROM managed_components ORDER BY id").all() as Array<Record<string, string>>;
  }

  serviceBindings(): Array<Record<string, string>> {
    return this.db.prepare("SELECT id, component_id, name, endpoint, created_at FROM service_bindings ORDER BY name").all() as Array<Record<string, string>>;
  }

  revokeServiceBinding(bindingId: string): boolean {
    if (!/^binding_[A-Za-z0-9-]+$/u.test(bindingId)) throw new Error("Invalid service binding ID");
    return this.db.prepare("DELETE FROM service_bindings WHERE id = ?").run(bindingId).changes === 1;
  }

  audit(actorId: string | undefined, type: string, subject: string): void {
    this.db.prepare("INSERT INTO audit_events (id, actor_id, type, subject, created_at) VALUES (?, ?, ?, ?, ?)").run(id("audit"), actorId ?? null, type, subject, now());
  }

  auditEvents(limit = 200): Array<{ id: string; actorId: string | null; type: string; subject: string; createdAt: string }> {
    return (this.db.prepare("SELECT id, actor_id, type, subject, created_at FROM audit_events ORDER BY created_at DESC LIMIT ?").all(Math.min(Math.max(Math.floor(limit), 1), 500)) as Array<Record<string, string | null>>)
      .map((row) => ({ id: String(row.id), actorId: row.actor_id ?? null, type: String(row.type), subject: String(row.subject), createdAt: String(row.created_at) }));
  }

  private userFromRow(row: Record<string, string | null>): UserRecord {
    return { id: row.id ?? "", organizationId: row.organization_id ?? "", username: row.username ?? "", role: row.role ?? "", locale: row.locale ?? "en", timeZone: row.time_zone ?? "UTC", theme: row.theme === "light" || row.theme === "dark" ? row.theme : "system", density: row.density === "compact" ? "compact" : "comfortable" };
  }

  private addBuiltinApplications(): void {
    this.addApplication({ name: "Management", category: "system", route: "/system", installationId: "core-management", vehicleSupported: false });
    this.addApplication({ name: "Diagnostics", category: "core-companion", route: "/apps/diagnostics", installationId: "core-diagnostics", vehicleSupported: true });
  }
}

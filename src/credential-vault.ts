import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { decryptSecret, encryptSecret } from "./security.js";
import type { ScopeContext } from "@carmediahub/sdk";

export type CredentialKind = "cookie" | "authorization";
export interface CredentialRecord { id: string; name: string; kind: CredentialKind; organizationId: string; userId: string; installationId: string; createdAt: string; expiresAt: string | null; revokedAt: string | null; }
export interface CredentialUserScope { organizationId: string; userId: string; }
interface StoredCredential extends CredentialRecord { value: string; }

const now = () => new Date().toISOString();
const id = () => `cred_${crypto.randomUUID()}`;

export class CredentialVault {
  private readonly location: string;
  private records: StoredCredential[];

  constructor(dataDir: string, private readonly key: Buffer) {
    const directory = path.join(dataDir, "secrets");
    fs.mkdirSync(directory, { recursive: true });
    this.location = path.join(directory, "credentials.json");
    this.records = this.read();
  }

  list(scope: CredentialUserScope): CredentialRecord[] {
    return this.records.filter((record) => record.organizationId === scope.organizationId && record.userId === scope.userId && record.revokedAt === null && !this.expired(record)).map(({ value: _value, ...record }) => ({ ...record }));
  }

  create(scope: ScopeContext, input: { name: string; kind: CredentialKind; value: string; expiresAt?: string | null }): CredentialRecord {
    if (!/^[^\r\n]{1,80}$/u.test(input.name.trim()) || input.value.length < 1 || input.value.length > 16_384) throw new Error("Invalid credential");
    if (input.kind !== "cookie" && input.kind !== "authorization") throw new Error("Invalid credential kind");
    const expiresAt = input.expiresAt ?? null;
    if (expiresAt !== null && !this.validFutureExpiry(expiresAt)) throw new Error("Invalid credential expiry");
    const record: StoredCredential = { id: id(), name: input.name.trim(), kind: input.kind, organizationId: scope.organizationId, userId: scope.userId, installationId: scope.installationId, createdAt: now(), expiresAt, revokedAt: null, value: encryptSecret(input.value, this.key) };
    this.records.push(record);
    this.persist();
    const { value: _value, ...publicRecord } = record;
    return publicRecord;
  }

  revoke(scope: CredentialUserScope, credentialId: string): boolean {
    const record = this.records.find((candidate) => candidate.id === credentialId && candidate.organizationId === scope.organizationId && candidate.userId === scope.userId && candidate.revokedAt === null);
    if (record === undefined) return false;
    record.revokedAt = now();
    this.persist();
    return true;
  }

  revokeInstallation(organizationId: string, installationId: string): number {
    const timestamp = now();
    const count = this.records.reduce((total, record) => {
      if (record.organizationId === organizationId && record.installationId === installationId && record.revokedAt === null) { record.revokedAt = timestamp; return total + 1; }
      return total;
    }, 0);
    if (count > 0) this.persist();
    return count;
  }

  revokeUser(organizationId: string, userId: string): number {
    const timestamp = now();
    const count = this.records.reduce((total, record) => {
      if (record.organizationId === organizationId && record.userId === userId && record.revokedAt === null) { record.revokedAt = timestamp; return total + 1; }
      return total;
    }, 0);
    if (count > 0) this.persist();
    return count;
  }

  resolve(scope: ScopeContext, credentialId: string): { name: "cookie" | "authorization"; value: string } | undefined {
    const record = this.records.find((candidate) => candidate.id === credentialId && candidate.organizationId === scope.organizationId && candidate.userId === scope.userId && candidate.installationId === scope.installationId && candidate.revokedAt === null && !this.expired(candidate));
    if (record === undefined) return undefined;
    return { name: record.kind, value: decryptSecret(record.value, this.key) };
  }

  private read(): StoredCredential[] {
    if (!fs.existsSync(this.location)) return [];
    try {
      const value = JSON.parse(fs.readFileSync(this.location, "utf8")) as unknown;
      if (!Array.isArray(value)) return [];
      return value.filter((record): record is StoredCredential => typeof record === "object" && record !== null && typeof (record as StoredCredential).id === "string" && typeof (record as StoredCredential).value === "string" && ((record as StoredCredential).kind === "cookie" || (record as StoredCredential).kind === "authorization")).map((record) => ({ ...record, expiresAt: typeof record.expiresAt === "string" ? record.expiresAt : null, revokedAt: typeof record.revokedAt === "string" ? record.revokedAt : null }));
    } catch {
      throw new Error("Credential vault is invalid");
    }
  }

  private expired(record: CredentialRecord): boolean { return record.expiresAt !== null && Date.parse(record.expiresAt) <= Date.now(); }
  private validFutureExpiry(value: string): boolean { return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) && Number.isFinite(Date.parse(value)) && Date.parse(value) > Date.now(); }

  private persist(): void {
    const temporary = `${this.location}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.records), { mode: 0o600 });
    fs.renameSync(temporary, this.location);
  }
}

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

  rotate(scope: ScopeContext, credentialId: string, input: { value: string; expiresAt?: string | null }): CredentialRecord | undefined {
    if (input.value.length < 1 || input.value.length > 16_384) throw new Error("Invalid credential");
    const current = this.records.find((record) => record.id === credentialId && record.organizationId === scope.organizationId && record.userId === scope.userId && record.installationId === scope.installationId && record.revokedAt === null && !this.expired(record));
    if (current === undefined) return undefined;
    const expiresAt = input.expiresAt ?? null;
    if (expiresAt !== null && !this.validFutureExpiry(expiresAt)) throw new Error("Invalid credential expiry");
    const timestamp = now();
    const replacement: StoredCredential = { id: id(), name: current.name, kind: current.kind, organizationId: current.organizationId, userId: current.userId, installationId: current.installationId, createdAt: timestamp, expiresAt, revokedAt: null, value: encryptSecret(input.value, this.key) };
    const nextRecords = this.records.map((record) => record.id === current.id ? { ...record, revokedAt: timestamp } : record);
    nextRecords.push(replacement);
    this.persist(nextRecords);
    this.records = nextRecords;
    const { value: _value, ...publicRecord } = replacement;
    return publicRecord;
  }

  revoke(scope: CredentialUserScope, credentialId: string): boolean {
    const record = this.records.find((candidate) => candidate.id === credentialId && candidate.organizationId === scope.organizationId && candidate.userId === scope.userId && candidate.revokedAt === null);
    if (record === undefined) return false;
    const timestamp = now();
    const nextRecords = this.records.map((candidate) => candidate.id === record.id ? { ...candidate, revokedAt: timestamp } : candidate);
    this.persist(nextRecords);
    this.records = nextRecords;
    return true;
  }

  revokeInstallation(organizationId: string, installationId: string): number {
    const timestamp = now();
    let count = 0;
    const nextRecords = this.records.map((record) => {
      if (record.organizationId === organizationId && record.installationId === installationId && record.revokedAt === null) {
        count += 1;
        return { ...record, revokedAt: timestamp };
      }
      return record;
    });
    if (count > 0) { this.persist(nextRecords); this.records = nextRecords; }
    return count;
  }

  revokeUser(organizationId: string, userId: string): number {
    const timestamp = now();
    let count = 0;
    const nextRecords = this.records.map((record) => {
      if (record.organizationId === organizationId && record.userId === userId && record.revokedAt === null) {
        count += 1;
        return { ...record, revokedAt: timestamp };
      }
      return record;
    });
    if (count > 0) { this.persist(nextRecords); this.records = nextRecords; }
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
      if (!value.every((record) => this.validStoredCredential(record))) throw new Error("Credential vault is invalid");
      return value.map((record) => ({ ...(record as StoredCredential), expiresAt: typeof (record as StoredCredential).expiresAt === "string" ? (record as StoredCredential).expiresAt : null, revokedAt: typeof (record as StoredCredential).revokedAt === "string" ? (record as StoredCredential).revokedAt : null }));
    } catch {
      throw new Error("Credential vault is invalid");
    }
  }

  private expired(record: CredentialRecord): boolean { return record.expiresAt !== null && Date.parse(record.expiresAt) <= Date.now(); }
  private validFutureExpiry(value: string): boolean { return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) && Number.isFinite(Date.parse(value)) && Date.parse(value) > Date.now(); }
  private validStoredCredential(value: unknown): value is StoredCredential {
    if (typeof value !== "object" || value === null) return false;
    const record = value as Partial<StoredCredential>;
    const safeText = (candidate: unknown, max: number) => typeof candidate === "string" && candidate.length > 0 && candidate.length <= max && !/[\u0000-\u001f\u007f]/u.test(candidate);
    if (!safeText(record.id, 128) || !safeText(record.name, 80) || !safeText(record.organizationId, 128) || !safeText(record.userId, 128) || !safeText(record.installationId, 128) || !safeText(record.createdAt, 64) || !safeText(record.value, 100_000)) return false;
    if (record.kind !== "cookie" && record.kind !== "authorization") return false;
    if (typeof record.createdAt !== "string" || !Number.isFinite(Date.parse(record.createdAt))) return false;
    if (record.revokedAt !== null && record.revokedAt !== undefined && (typeof record.revokedAt !== "string" || !safeText(record.revokedAt, 64) || !Number.isFinite(Date.parse(record.revokedAt)))) return false;
    if (record.expiresAt !== undefined && record.expiresAt !== null && (typeof record.expiresAt !== "string" || !this.canonicalTimestamp(record.expiresAt))) return false;
    return true;
  }
  private canonicalTimestamp(value: unknown): value is string { return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) && Number.isFinite(Date.parse(value)); }

  private persist(records = this.records): void {
    const temporary = `${this.location}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(records), { mode: 0o600 });
    fs.renameSync(temporary, this.location);
  }
}

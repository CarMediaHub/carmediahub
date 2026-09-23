import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import { openDatabase } from "./database.js";
import { Repository, type UserRecord, type VerifiedPluginPackageRecord } from "./repository.js";
import { ensureServerKey } from "./security.js";
import { loadComponentCatalog, resolveInstalledExecutable } from "./components.js";
import { installSignedComponentRelease, type SignedComponentRelease } from "./component-release.js";
import { currentPlatformKey } from "./components.js";
import { RuntimeBroker } from "./runtime-broker.js";
import { createPluginDataStore, deletePluginData, exportPluginData } from "./data-service.js";
import { PluginJobService } from "./job-service.js";
import { verifyPluginRelease, type SignedPluginRelease } from "./plugin-release.js";
import { WorkerSupervisor } from "./worker-supervisor.js";
import { createTrustedNodeWorkerFactory, type TrustedWorkerPackage } from "./trusted-worker-factory.js";
import { createTrustedSharedAdapterFactory, type TrustedSharedAdapterPackage } from "./trusted-shared-adapter-factory.js";
import { installStagedPluginPackage } from "./plugin-package-installer.js";
import { verifyPluginPackageRelease, type SignedPluginPackageRelease } from "./plugin-package-release.js";
import { MediaLibraryService } from "./media-library-service.js";
import { RemoteWebDavProvider } from "./remote-webdav-provider.js";
import { GatewayStreamQuota } from "./gateway-stream-quota.js";
import { HistoryService } from "./history-service.js";
import { CatalogService } from "./catalog-service.js";
import { NotificationService } from "./notification-service.js";
import { executeNetworkRequest } from "./network-service.js";
import { CredentialVault } from "./credential-vault.js";
import { JobExecutor } from "./job-executor.js";
import { cleanupExpiredTransformOutputs, readHlsAsset, readTransformOutput, readTransformOutputForUser, registerMediaTransformHandlers, revokeHlsForInstallation, revokeHlsForUser } from "./media-transform-service.js";
import type { PluginJob, ScopeContext } from "@carmediahub/sdk";
import { BrowserWorkerManager } from "./browser-worker-manager.js";
import { BrowserTaskExecutor } from "./browser-task-executor.js";
import { BrowserTargetRegistry } from "./browser-target-registry.js";
import { createNavigateAndCaptureHandler, type BrowserWorkerOptionsResolver } from "./browser-task-handlers.js";
import { createManagedBrowserWorkerOptionsResolver } from "./browser-task-runtime.js";
import { loadBrowserTargetRegistry } from "./browser-target-config.js";

export interface AppOptions { dataDir: string; cookieSecure?: boolean; componentTrustKeys?: readonly string[]; pluginTrustKeys?: readonly string[]; trustedWorkerPackages?: readonly TrustedWorkerPackage[]; trustedSharedAdapterPackages?: readonly TrustedSharedAdapterPackage[]; gatewayStreamQuota?: GatewayStreamQuota; jobExecutor?: JobExecutor; browserWorkerManager?: BrowserWorkerManager; browserTaskExecutor?: BrowserTaskExecutor; browserTargetRegistry?: BrowserTargetRegistry; browserWorkerOptionsResolver?: BrowserWorkerOptionsResolver; }

function body<T>(request: FastifyRequest): T { return request.body as T; }

function pagination(query: { limit?: string; offset?: string }): { limit: number; offset: number } | undefined {
  const limit = query.limit === undefined ? 100 : Number(query.limit);
  const offset = query.offset === undefined ? 0 : Number(query.offset);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500 || !Number.isSafeInteger(offset) || offset < 0 || offset > 10_000_000) return undefined;
  return { limit, offset };
}

type DisplayContext = { deviceClass: "desktop" | "mobile" | "vehicle" | "unknown"; input: Array<"touch" | "keyboard" | "pointer" | "remote">; fullscreenAvailable: boolean; viewport: { width: number; height: number } };

const gatewayRequestHeaders = new Set(["accept", "accept-encoding", "accept-language", "content-type", "if-match", "if-modified-since", "if-none-match", "if-range", "if-unmodified-since", "range"]);

function singleHeader(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
}

/** Client hints are deliberately bounded UI hints, never identity or authorization input. */
function presentationContext(request: FastifyRequest, applicationId: string): { entry: "navigation" | "key"; display: DisplayContext } {
  const deviceClass = singleHeader(request, "x-cmh-device-class");
  const allowedDevice = deviceClass === "desktop" || deviceClass === "mobile" || deviceClass === "vehicle" ? deviceClass : "unknown";
  const rawInput = singleHeader(request, "x-cmh-input");
  const input = rawInput === undefined ? [] : [...new Set(rawInput.split(",").map((value) => value.trim()).filter((value): value is DisplayContext["input"][number] => value === "touch" || value === "keyboard" || value === "pointer" || value === "remote"))];
  const boundedDimension = (name: string) => {
    const value = singleHeader(request, name);
    return value !== undefined && /^(0|[1-9][0-9]{0,4})$/.test(value) && Number(value) <= 16_384 ? Number(value) : 0;
  };
  return {
    entry: request.cookies.cmh_entry === applicationId ? "key" : "navigation",
    display: {
      deviceClass: allowedDevice,
      input,
      fullscreenAvailable: singleHeader(request, "x-cmh-fullscreen") === "true",
      viewport: { width: boundedDimension("x-cmh-viewport-width"), height: boundedDimension("x-cmh-viewport-height") }
    }
  };
}

export function filterGatewayHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => gatewayRequestHeaders.has(entry[0].toLowerCase()) && typeof entry[1] === "string"));
}

function pluginRequestHeaders(request: FastifyRequest): Record<string, string> {
  return filterGatewayHeaders(request.headers);
}

function validCredential(value: string, field: string): void {
  if (value.trim().length < 3 || value.length > 128) throw new Error(`${field} must contain 3 to 128 characters`);
}

async function sha256File(location: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(location)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function publicWorkerStatus(status: ReturnType<WorkerSupervisor["status"]>): { installationId: string; state: string; attempts: number; diagnostic?: string } {
  return { installationId: status.installationId, state: status.state, attempts: status.attempts, ...(status.state === "failed" ? { diagnostic: "worker_failed" } : {}) };
}

export async function createApp(options: AppOptions): Promise<FastifyInstance> {
  const database = openDatabase(options.dataDir);
  cleanupExpiredTransformOutputs(database.db, options.dataDir);
  const serverKey = ensureServerKey(options.dataDir);
  const repository = new Repository(database.db, serverKey);
  const credentialVault = new CredentialVault(options.dataDir, serverKey);
  const mediaLibrary = new MediaLibraryService(database.db, serverKey);
  const remoteMediaSources = new RemoteWebDavProvider(
    (name, installationId) => repository.serviceBindingByName(name, installationId),
    (scope, credentialRef) => credentialVault.resolve({ ...scope, deploymentId: "core", sessionId: "media-source" }, credentialRef),
    database.db
  );
  remoteMediaSources.restore();
  const jobs = new PluginJobService(database.db);
  jobs.recoverInterrupted();
  const jobExecutor = options.jobExecutor ?? new JobExecutor(jobs);
  const browserWorkerManager = options.browserWorkerManager ?? new BrowserWorkerManager();
  const browserTaskExecutor = options.browserTaskExecutor ?? new BrowserTaskExecutor(repository);
  const browserTargetRegistry = options.browserTargetRegistry ?? loadBrowserTargetRegistry(options.dataDir);
  const history = new HistoryService(database.db);
  const catalogService = new CatalogService(database.db);
  const notifications = new NotificationService(database.db);
  const gatewayStreamQuota = options.gatewayStreamQuota ?? new GatewayStreamQuota();
  const runtimeBroker = new RuntimeBroker({
    dataDir: options.dataDir,
    installationEnabled: (installationId) => repository.pluginInstallation(installationId)?.status === "installed",
    onWorkerRequest: async (request, scope) => {
      if (request.method === "media.list") {
        if (!repository.pluginHasCapability(scope.installationId, "media")) throw new Error("Plugin media capability is not granted");
        return { media: mediaLibrary.roots(scope.organizationId, scope.installationId).flatMap((root) => mediaLibrary.list(scope.organizationId, scope.installationId, root.id)) };
      }
      if (request.method === "media.createPlayback") {
        if (!repository.pluginHasCapability(scope.installationId, "media")) throw new Error("Plugin media capability is not granted");
        const mediaId = (request.params as { mediaId?: unknown } | undefined)?.mediaId;
        if (typeof mediaId !== "string") throw new Error("Invalid playback request");
        return mediaLibrary.createPlayback(scope, mediaId);
      }
      if (request.method === "media.probe") {
        if (!repository.pluginHasCapability(scope.installationId, "media")) throw new Error("Plugin media capability is not granted");
        const mediaId = (request.params as { mediaId?: unknown } | undefined)?.mediaId;
        if (typeof mediaId !== "string") throw new Error("Invalid media probe request");
        return mediaLibrary.probe(scope, mediaId);
      }
      if (request.method === "media.transform") {
        if (!repository.pluginHasCapability(scope.installationId, "media")) throw new Error("Plugin media capability is not granted");
        const input = request.params as { mediaId?: unknown; mode?: unknown; container?: unknown; videoCodec?: unknown; audioCodec?: unknown } | undefined;
        if (typeof input?.mediaId !== "string" || (input.mode !== "remux" && input.mode !== "transcode")) throw new Error("Invalid media transform request");
        const allowedContainers = new Set(["mp4", "fmp4", "ts"]);
        const allowedVideo = new Set(["copy", "h264", "h265"]);
        const allowedAudio = new Set(["copy", "aac", "opus"]);
        if ((input.container !== undefined && (typeof input.container !== "string" || !allowedContainers.has(input.container))) || (input.videoCodec !== undefined && (typeof input.videoCodec !== "string" || !allowedVideo.has(input.videoCodec))) || (input.audioCodec !== undefined && (typeof input.audioCodec !== "string" || !allowedAudio.has(input.audioCodec)))) throw new Error("Invalid media transform profile");
        const probe = mediaLibrary.probe(scope, input.mediaId);
        if (!probe.availableModes.includes(input.mode)) throw new Error("Media transform mode is unavailable");
        const job = jobs.enqueueMediaTransform(scope, `media.${input.mode}`, { mediaId: input.mediaId, mode: input.mode, ...(input.container === undefined ? {} : { container: input.container }), ...(input.videoCodec === undefined ? {} : { videoCodec: input.videoCodec }), ...(input.audioCodec === undefined ? {} : { audioCodec: input.audioCodec }) });
        void jobExecutor.runOnce(scope).catch(() => undefined);
        return job;
      }
      if (request.method === "media.read") {
        if (!repository.pluginHasCapability(scope.installationId, "media")) throw new Error("Plugin media capability is not granted");
        const input = request.params as { mediaId?: unknown; sessionId?: unknown; start?: unknown; end?: unknown } | undefined;
        if (typeof input?.mediaId !== "string" || typeof input.sessionId !== "string" || typeof input.start !== "number" || typeof input.end !== "number") throw new Error("Invalid media read request");
        return mediaLibrary.readWithPlayback(scope, input.sessionId, input.mediaId, input.start, input.end);
      }
      if (request.method === "media.readOutput") {
        if (!repository.pluginHasCapability(scope.installationId, "media")) throw new Error("Plugin media capability is not granted");
        const input = request.params as { outputId?: unknown; start?: unknown; end?: unknown } | undefined;
        if (typeof input?.outputId !== "string" || typeof input.start !== "number" || typeof input.end !== "number") throw new Error("Invalid transform output request");
        return readTransformOutput(database.db, options.dataDir, scope, input.outputId, input.start, input.end);
      }
      if (request.method === "media.hls") {
        if (!repository.pluginHasCapability(scope.installationId, "media")) throw new Error("Plugin media capability is not granted");
        const input = request.params as { mediaId?: unknown; segmentDurationSeconds?: unknown } | undefined;
        if (typeof input?.mediaId !== "string" || (input.segmentDurationSeconds !== undefined && ![2, 4, 6].includes(input.segmentDurationSeconds as number))) throw new Error("Invalid HLS request");
        mediaLibrary.probe(scope, input.mediaId);
        const job = jobs.enqueueHls(scope, { mediaId: input.mediaId, ...(input.segmentDurationSeconds === undefined ? {} : { segmentDurationSeconds: input.segmentDurationSeconds }) });
        void jobExecutor.runOnce(scope).catch(() => undefined);
        return job;
      }
      if (request.method === "media.readHlsAsset") {
        if (!repository.pluginHasCapability(scope.installationId, "media")) throw new Error("Plugin media capability is not granted");
        const input = request.params as { sessionId?: unknown; asset?: unknown; start?: unknown; end?: unknown } | undefined;
        if (typeof input?.sessionId !== "string" || typeof input.asset !== "string" || typeof input.start !== "number" || typeof input.end !== "number") throw new Error("Invalid HLS asset request");
        return readHlsAsset(database.db, options.dataDir, scope, input.sessionId, input.asset, input.start, input.end);
      }
      if (request.method === "mediaSource.list" || request.method === "mediaSource.stat" || request.method === "mediaSource.probe" || request.method === "mediaSource.createPlayback" || request.method === "mediaSource.read") {
        if (!repository.pluginHasCapability(scope.installationId, "media-source")) throw new Error("Plugin media-source capability is not granted");
        const input = request.params as { sourceHandle?: unknown; itemHandle?: unknown; sessionId?: unknown; start?: unknown; end?: unknown; limit?: unknown } | undefined;
        if (request.method === "mediaSource.list") {
          if (typeof input?.sourceHandle !== "string" || (input.limit !== undefined && typeof input.limit !== "number")) throw new Error("Invalid media source list request");
          if (input.sourceHandle.startsWith("remote_source_")) return remoteMediaSources.list(scope, input.sourceHandle, input.limit ?? 200);
          return mediaLibrary.listSource(scope, input.sourceHandle, input.limit ?? 200);
        }
        if (request.method === "mediaSource.read") {
          if (typeof input?.sessionId !== "string" || typeof input.start !== "number" || typeof input.end !== "number") throw new Error("Invalid media source read request");
          if (input.sessionId.startsWith("remote_playback_")) return remoteMediaSources.read(scope, input.sessionId, input.start, input.end);
          if (typeof input.sourceHandle === "string" && typeof input.itemHandle === "string") return mediaLibrary.sourceRead(scope, input.sourceHandle, input.itemHandle, input.sessionId, input.start, input.end);
          return mediaLibrary.sourceReadSession(scope, input.sessionId, input.start, input.end);
        }
        if (typeof input?.sourceHandle !== "string" || typeof input.itemHandle !== "string") throw new Error("Invalid media source item request");
        if (input.sourceHandle.startsWith("remote_source_")) {
          if (request.method === "mediaSource.stat") return remoteMediaSources.stat(scope, input.sourceHandle, input.itemHandle);
          if (request.method === "mediaSource.probe") return remoteMediaSources.probe(scope, input.sourceHandle, input.itemHandle);
          return remoteMediaSources.createPlayback(scope, input.sourceHandle, input.itemHandle);
        }
        if (request.method === "mediaSource.stat") return mediaLibrary.sourceStat(scope, input.sourceHandle, input.itemHandle);
        if (request.method === "mediaSource.probe") return mediaLibrary.sourceProbe(scope, input.sourceHandle, input.itemHandle);
        return mediaLibrary.sourceCreatePlayback(scope, input.sourceHandle, input.itemHandle);
      }
      if (request.method === "network.request") {
        if (!repository.pluginHasCapability(scope.installationId, "network")) throw new Error("Plugin network capability is not granted");
        const input = request.params as { binding?: unknown; method?: unknown; path?: unknown; headers?: unknown; body?: unknown; credentialRef?: unknown } | undefined;
        if (typeof input?.binding !== "string" || typeof input.method !== "string" || typeof input.path !== "string") throw new Error("Invalid network request");
        if (input.credentialRef !== undefined && typeof input.credentialRef !== "string") throw new Error("Invalid credential reference");
        return executeNetworkRequest({ binding: input.binding, method: input.method, path: input.path, headers: input.headers, body: input.body, ...(input.credentialRef === undefined ? {} : { credentialRef: input.credentialRef }) }, (name) => repository.serviceBindingByName(name, scope.installationId), (credentialRef) => credentialVault.resolve(scope, credentialRef));
      }
      if (request.method === "data.get" || request.method === "data.put" || request.method === "data.delete" || request.method === "data.list" || request.method === "data.migrate" || request.method === "data.migrations") {
        if (!repository.pluginHasCapability(scope.installationId, "db")) throw new Error("Plugin db capability is not granted");
        const input = request.params as { collection?: unknown; key?: unknown; value?: unknown; prefix?: unknown; limit?: unknown; version?: unknown; name?: unknown } | undefined;
        if (input === undefined && request.method !== "data.migrations") throw new Error("Invalid data request");
        const store = createPluginDataStore(database.db, scope);
        if (request.method === "data.migrations") return { migrations: await store.migrations() };
        if (input === undefined) throw new Error("Invalid data request");
        if (request.method !== "data.migrate" && typeof input.collection !== "string") throw new Error("Invalid data collection");
        if (request.method === "data.get") {
          if (typeof input.key !== "string") throw new Error("Invalid data key");
          return { record: await store.get(input.collection as string, input.key) };
        }
        if (request.method === "data.put") {
          if (typeof input.key !== "string" || !Object.prototype.hasOwnProperty.call(input, "value")) throw new Error("Invalid data record");
          return { record: await store.put(input.collection as string, input.key, input.value) };
        }
        if (request.method === "data.delete") {
          if (typeof input.key !== "string") throw new Error("Invalid data key");
          return { deleted: await store.delete(input.collection as string, input.key) };
        }
        if (request.method === "data.migrate") {
          if (typeof input.version !== "number" || !Number.isSafeInteger(input.version) || typeof input.name !== "string") throw new Error("Invalid data migration");
          return { migration: await store.migrate({ version: input.version, name: input.name }) };
        }
        if (input.prefix !== undefined && typeof input.prefix !== "string") throw new Error("Invalid data prefix");
        if (input.limit !== undefined && typeof input.limit !== "number") throw new Error("Invalid data limit");
        return { records: await store.list(input.collection as string, { ...(input.prefix === undefined ? {} : { prefix: input.prefix }), ...(input.limit === undefined ? {} : { limit: input.limit }) }) };
      }
      if (request.method === "jobs.enqueue") {
        if (!repository.pluginHasCapability(scope.installationId, "jobs")) throw new Error("Plugin jobs capability is not granted");
        const input = request.params as { type?: unknown; payload?: unknown } | undefined;
        if (typeof input?.type !== "string") throw new Error("Invalid job request");
        return jobs.enqueue(scope, input.type, input.payload);
      }
      if (request.method === "jobs.list") {
        if (!repository.pluginHasCapability(scope.installationId, "jobs")) throw new Error("Plugin jobs capability is not granted");
        const input = request.params as { limit?: unknown } | undefined;
        return { jobs: jobs.list(scope, typeof input?.limit === "number" ? input.limit : 100) };
      }
      if (request.method === "jobs.cancel") {
        if (!repository.pluginHasCapability(scope.installationId, "jobs")) throw new Error("Plugin jobs capability is not granted");
        const input = request.params as { id?: unknown } | undefined;
        if (typeof input?.id !== "string") throw new Error("Invalid job cancel request");
        return { job: jobs.transition(scope, input.id, "cancelled") };
      }
      if (request.method === "browser.session.request") {
        if (!repository.pluginHasCapability(scope.installationId, "browser")) throw new Error("Plugin browser capability is not granted");
        const input = request.params as { name?: unknown; purpose?: unknown; expiresInSeconds?: unknown } | undefined;
        if (typeof input?.name !== "string" || typeof input.purpose !== "string" || (input.expiresInSeconds !== undefined && typeof input.expiresInSeconds !== "number")) throw new Error("Invalid browser session request");
        return repository.createBrowserSession(scope, { name: input.name, purpose: input.purpose, ...(input.expiresInSeconds === undefined ? {} : { expiresInSeconds: input.expiresInSeconds }) });
      }
      if (request.method === "browser.session.list") {
        if (!repository.pluginHasCapability(scope.installationId, "browser")) throw new Error("Plugin browser capability is not granted");
        return { sessions: repository.browserSessions(scope) };
      }
      if (request.method === "browser.session.revoke") {
        if (!repository.pluginHasCapability(scope.installationId, "browser")) throw new Error("Plugin browser capability is not granted");
        const id = (request.params as { id?: unknown } | undefined)?.id;
        if (typeof id !== "string") throw new Error("Invalid browser session ID");
        const revoked = repository.revokeBrowserSession(scope, id);
        if (revoked) { browserTaskExecutor.cancelSession(scope, id); await browserWorkerManager.stopSession(scope.organizationId, id); }
        return { revoked };
      }
      if (request.method === "browser.task.enqueue") {
        if (!repository.pluginHasCapability(scope.installationId, "browser")) throw new Error("Plugin browser capability is not granted");
        const input = request.params as { sessionId?: unknown; kind?: unknown; input?: unknown } | undefined;
        if (typeof input?.sessionId !== "string" || typeof input.kind !== "string" || (input.input !== undefined && (typeof input.input !== "object" || input.input === null || Array.isArray(input.input)))) throw new Error("Invalid browser task request");
        return repository.createBrowserTask(scope, { sessionId: input.sessionId, kind: input.kind as never, ...(input.input === undefined ? {} : { input: input.input as { target?: string; label?: string } }) });
      }
      if (request.method === "browser.task.list") {
        if (!repository.pluginHasCapability(scope.installationId, "browser")) throw new Error("Plugin browser capability is not granted");
        return { tasks: repository.browserTasks(scope) };
      }
      if (request.method === "browser.task.cancel") {
        if (!repository.pluginHasCapability(scope.installationId, "browser")) throw new Error("Plugin browser capability is not granted");
        const id = (request.params as { id?: unknown } | undefined)?.id;
        if (typeof id !== "string") throw new Error("Invalid browser task ID");
        return { task: repository.cancelBrowserTask(scope, id) };
      }
      if (request.method === "history.record") {
        if (!repository.pluginHasCapability(scope.installationId, "history")) throw new Error("Plugin history capability is not granted");
        const input = request.params as Parameters<HistoryService["record"]>[1] | undefined;
        if (input === undefined) throw new Error("Invalid history record request");
        return history.record(scope, input);
      }
      if (request.method === "history.query") {
        if (!repository.pluginHasCapability(scope.installationId, "history")) throw new Error("Plugin history capability is not granted");
        return { entries: history.query(scope, request.params as Parameters<HistoryService["query"]>[1] | undefined) };
      }
      if (request.method === "history.clear") {
        if (!repository.pluginHasCapability(scope.installationId, "history")) throw new Error("Plugin history capability is not granted");
        return { cleared: history.clear(scope, request.params as Parameters<HistoryService["clear"]>[1] | undefined) };
      }
      if (request.method === "catalog.register") {
        if (!repository.pluginHasCapability(scope.installationId, "catalog")) throw new Error("Plugin catalog capability is not granted");
        const input = request.params as Parameters<CatalogService["register"]>[1] | undefined;
        if (input === undefined) throw new Error("Invalid catalog register request");
        return catalogService.register(scope, input);
      }
      if (request.method === "catalog.query") {
        if (!repository.pluginHasCapability(scope.installationId, "catalog")) throw new Error("Plugin catalog capability is not granted");
        return { entries: catalogService.query(scope, request.params as Parameters<CatalogService["query"]>[1] | undefined) };
      }
      if (request.method === "catalog.remove") {
        if (!repository.pluginHasCapability(scope.installationId, "catalog")) throw new Error("Plugin catalog capability is not granted");
        const input = request.params as { id?: unknown } | undefined;
        if (typeof input?.id !== "string") throw new Error("Invalid catalog remove request");
        return { removed: catalogService.remove(scope, input.id) };
      }
      if (request.method === "display.capabilities") {
        if (!repository.pluginHasCapability(scope.installationId, "display")) throw new Error("Plugin display capability is not granted");
        return scope.display;
      }
      if (request.method === "display.requestMode") {
        if (!repository.pluginHasCapability(scope.installationId, "display")) throw new Error("Plugin display capability is not granted");
        const input = request.params as { mode?: unknown } | undefined;
        if (input?.mode !== "normal" && input?.mode !== "fullscreen") throw new Error("Invalid display mode");
        if (input.mode === "fullscreen" && !scope.display.fullscreenAvailable) return { mode: input.mode, accepted: false, reason: "unsupported" };
        return { mode: input.mode, accepted: true };
      }
      if (request.method === "notifications.publish") {
        if (!repository.pluginHasCapability(scope.installationId, "events")) throw new Error("Plugin events capability is not granted");
        const input = request.params as { severity?: unknown; title?: unknown; body?: unknown } | undefined;
        if (input === undefined || typeof input.severity !== "string" || typeof input.title !== "string" || (input.body !== undefined && typeof input.body !== "string")) throw new Error("Invalid notification request");
        return notifications.publish(scope, { severity: input.severity as "info" | "success" | "warning" | "error", title: input.title, ...(input.body === undefined ? {} : { body: input.body }) });
      }
      if (request.method === "notifications.list") {
        if (!repository.pluginHasCapability(scope.installationId, "events")) throw new Error("Plugin events capability is not granted");
        const input = request.params as { limit?: unknown; unreadOnly?: unknown } | undefined;
        return { notifications: notifications.list(scope, { limit: typeof input?.limit === "number" ? input.limit : 100, unreadOnly: input?.unreadOnly === true }) };
      }
      if (request.method === "notifications.markRead") {
        if (!repository.pluginHasCapability(scope.installationId, "events")) throw new Error("Plugin events capability is not granted");
        const id = (request.params as { id?: unknown } | undefined)?.id;
        if (typeof id !== "string") throw new Error("Invalid notification ID");
        return { marked: notifications.markRead(scope, id) };
      }
      if (request.method === "notifications.markAllRead") {
        if (!repository.pluginHasCapability(scope.installationId, "events")) throw new Error("Plugin events capability is not granted");
        return { marked: notifications.markAllRead(scope) };
      }
      throw new Error("Worker method is not available");
    }
  });
  const supervisor = new WorkerSupervisor({
    endpoint: runtimeBroker.endpoint,
    issueCredential: (scope) => runtimeBroker.issueCredential(scope),
    installation: (installationId) => {
      const installation = repository.pluginInstallation(installationId);
      return installation === undefined ? undefined : { packageId: installation.packageId, status: installation.status };
    }
  });
  const registerVerifiedPluginRuntime = (verified: VerifiedPluginPackageRecord): void => {
    if (supervisor.hasFactory(verified.packageId)) return;
    if (verified.workerEntry !== undefined) supervisor.register(createTrustedNodeWorkerFactory({ packageId: verified.packageId, packageRoot: path.resolve(options.dataDir, verified.location), workerEntry: verified.workerEntry }));
    else if (verified.runtimeEntry !== undefined) supervisor.register(createTrustedSharedAdapterFactory({ packageId: verified.packageId, packageRoot: path.resolve(options.dataDir, verified.location), runtimeEntry: verified.runtimeEntry }));
  };
  for (const verified of repository.verifiedPluginPackages()) registerVerifiedPluginRuntime(verified);
  for (const workerPackage of options.trustedWorkerPackages ?? []) {
    if (!supervisor.hasFactory(workerPackage.packageId)) supervisor.register(createTrustedNodeWorkerFactory(workerPackage));
  }
  for (const adapterPackage of options.trustedSharedAdapterPackages ?? []) {
    if (!supervisor.hasFactory(adapterPackage.packageId)) supervisor.register(createTrustedSharedAdapterFactory(adapterPackage));
  }
  const catalog = loadComponentCatalog(path.resolve(import.meta.dirname, ".."));
  if (options.browserTaskExecutor === undefined && browserTargetRegistry !== undefined && browserTargetRegistry.ids().length > 0) {
    const resolveOptions = options.browserWorkerOptionsResolver ?? createManagedBrowserWorkerOptionsResolver({ dataDir: options.dataDir, catalog, repository, targetRegistry: browserTargetRegistry });
    browserTaskExecutor.register("navigate-and-capture", createNavigateAndCaptureHandler(browserWorkerManager, resolveOptions), { allowedTargets: browserTargetRegistry.ids() });
  }
  const ffmpegRecord = repository.componentById("ffmpeg");
  const ffmpegCatalog = catalog.find((component) => component.id === "ffmpeg");
  const ffmpeg = ffmpegRecord === undefined ? undefined : { ...ffmpegRecord, ...(ffmpegCatalog === undefined ? {} : { provides: ffmpegCatalog.provides }) };
  if (ffmpeg !== undefined && ffmpeg.health === "healthy") {
    mediaLibrary.enableTransforms();
    registerMediaTransformHandlers({ executor: jobExecutor, jobs, media: mediaLibrary, dataDir: options.dataDir, ffmpeg, database: database.db });
  }
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_request, payload, done) => {
    done(null, payload);
  });
  await app.register(cookie);
  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "same-origin");
    reply.header("permissions-policy", "camera=(), geolocation=(), microphone=(), payment=(), usb=()");
    reply.header("x-frame-options", "DENY");
    if (!request.url.startsWith("/apps/")) reply.header("content-security-policy", "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'");
    return payload;
  });
  const loginSubject = (request: FastifyRequest, username: string) => `login:${request.ip}:${username.trim().toLowerCase()}`;
  const entrySubject = (request: FastifyRequest) => `entry:${request.ip}`;

  await runtimeBroker.start();
  app.addHook("onClose", async () => {
    await browserWorkerManager.stopAll();
    await supervisor.stopAll();
    await runtimeBroker.stop();
    database.close();
  });

  const requireUser = async (request: FastifyRequest, reply: { code(status: number): { send(body: unknown): void } }): Promise<UserRecord | undefined> => {
    const token = request.cookies.cmh_session;
    const user = token === undefined ? undefined : repository.session(token);
    if (user === undefined) {
      reply.code(401).send({ code: "CMH.AUTH.REQUIRED", messageKey: "errors.auth.required" });
      return undefined;
    }
    return user;
  };

  const requireAdmin = async (request: FastifyRequest, reply: { code(status: number): { send(body: unknown): void } }): Promise<UserRecord | undefined> => {
    const user = await requireUser(request, reply);
    if (user !== undefined && user.role !== "admin") {
      reply.code(403).send({ code: "CMH.POLICY.ADMIN_REQUIRED", messageKey: "errors.policy.adminRequired" });
      return undefined;
    }
    return user;
  };

  const healthSnapshot = () => ({ status: "ok" as const, initialized: repository.initialized() });
  const diagnosticSnapshot = () => ({
    status: "ok" as const,
    initialized: repository.initialized(),
    components: repository.components().reduce((summary, component) => {
      summary.total += 1;
      if (component.health === "healthy") summary.healthy += 1;
      else if (component.health === "unhealthy") summary.unhealthy += 1;
      return summary;
    }, { total: 0, healthy: 0, unhealthy: 0 }),
    plugins: repository.pluginInstallations().reduce((summary, plugin) => {
      summary.total += 1;
      if (plugin.status === "installed") summary.enabled += 1;
      else summary.disabled += 1;
      return summary;
    }, { total: 0, enabled: 0, disabled: 0 })
  });
  // Keep health probes unauthenticated and free of paths, URLs, identifiers, and secrets.
  app.get("/health/live", async () => healthSnapshot());
  app.get("/health/ready", async (_request, reply) => {
    const health = healthSnapshot();
    if (!health.initialized) return reply.code(503).send({ ...health, status: "not_ready" as const });
    return health;
  });
  app.get("/health/diagnostic", async () => diagnosticSnapshot());
  app.get("/api/health", async () => healthSnapshot());
  app.get("/api/bootstrap", async () => ({ initialized: repository.initialized() }));

  app.post("/api/bootstrap", async (request, reply) => {
    try {
      const input = body<{ username: string; password: string; locale?: string }>(request);
      validCredential(input.username, "username");
      const user = repository.bootstrap(input.username, input.password, input.locale ?? "en");
      repository.audit(user.id, "deployment.bootstrapped", "deployment");
      reply.code(201).send({ user });
    } catch (error) {
      reply.code(repository.initialized() ? 409 : 400).send({ code: "CMH.BOOTSTRAP.INVALID", messageKey: "errors.bootstrap.invalid" });
    }
  });

  app.post("/api/auth/login", async (request, reply) => {
    const input = body<{ username: string; password: string; deviceLabel?: string; otp?: string }>(request);
    const subject = loginSubject(request, input.username ?? "");
    if (repository.rateLimited(subject)) return reply.code(429).send({ code: "CMH.AUTH.RATE_LIMITED", messageKey: "errors.auth.rateLimited" });
    const result = repository.login(input.username ?? "", input.password ?? "", input.deviceLabel ?? "Browser", input.otp);
    if (result === "totp_required") return reply.code(401).send({ code: "CMH.AUTH.TOTP_REQUIRED", messageKey: "errors.auth.totpRequired" });
    if (result === "totp_invalid" || result === undefined) {
      repository.recordFailedAttempt(subject);
      repository.audit(undefined, "auth.login.failed", "redacted");
      return reply.code(401).send({ code: result === "totp_invalid" ? "CMH.AUTH.TOTP_INVALID" : "CMH.AUTH.INVALID_CREDENTIALS", messageKey: result === "totp_invalid" ? "errors.auth.totpInvalid" : "errors.auth.invalidCredentials" });
    }
    repository.clearFailedAttempts(subject);
    repository.audit(result.user.id, "auth.login", "session");
    reply.setCookie("cmh_session", result.token, { httpOnly: true, sameSite: "strict", path: "/", secure: options.cookieSecure ?? false, maxAge: 60 * 60 * 24 * 30 });
    return { user: result.user };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    if (request.cookies.cmh_session !== undefined) {
      const session = repository.sessionContext(request.cookies.cmh_session);
      repository.revokeSession(request.cookies.cmh_session);
      if (session !== undefined) { mediaLibrary.revokePlaybackForUser(session.user.id); revokeHlsForUser(database.db, session.user.id); }
    }
    reply.clearCookie("cmh_session", { path: "/" });
    return reply.code(204).send();
  });

  app.get("/api/me", async (request, reply) => {
    const user = await requireUser(request, reply);
    return user === undefined ? undefined : { user };
  });

  app.patch("/api/me/preferences", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (user === undefined) return undefined;
    const input = body<{ locale?: unknown; timeZone?: unknown; theme?: unknown; density?: unknown }>(request);
    const updated = repository.updateUserPreferences(user.id, input);
    if (updated === undefined) return reply.code(400).send({ code: "CMH.PREFERENCE.INVALID_LOCALE", messageKey: "errors.preference.invalidLocale" });
    runtimeBroker.broadcastContext(user.id, { ...(updated.locale === "en" || updated.locale === "zh-CN" || updated.locale === "ko" ? { locale: updated.locale } : {}), timeZone: updated.timeZone, theme: updated.theme === "light" || updated.theme === "dark" || updated.theme === "system" ? updated.theme : "system", density: updated.density === "compact" ? "compact" : "comfortable" });
    repository.audit(user.id, "user.preference.updated", user.id);
    return { user: updated };
  });

  app.get("/api/auth/totp", async (request, reply) => {
    const user = await requireAdmin(request, reply);
    return user === undefined ? undefined : repository.totpStatus(user.id);
  });

  app.post("/api/auth/totp/setup", async (request, reply) => {
    const user = await requireAdmin(request, reply);
    return user === undefined ? undefined : repository.beginTotpSetup(user.id);
  });

  app.post("/api/auth/totp/enable", async (request, reply) => {
    const user = await requireAdmin(request, reply);
    if (user === undefined) return undefined;
    const input = body<{ code: string }>(request);
    const recoveryCodes = repository.enableTotp(user.id, input.code ?? "");
    if (recoveryCodes === undefined) return reply.code(400).send({ code: "CMH.AUTH.TOTP_INVALID", messageKey: "errors.auth.totpInvalid" });
    repository.audit(user.id, "auth.totp.enabled", user.id);
    return { recoveryCodes };
  });

  app.get("/api/apps", async (request, reply) => {
    const user = await requireUser(request, reply);
    return user === undefined ? undefined : { applications: repository.applications() };
  });

  app.get("/api/history", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (user === undefined) return undefined;
    const query = request.query as { limit?: string; offset?: string; keyword?: string; category?: string; pluginId?: string };
    const page = pagination(query);
    if (page === undefined) return reply.code(400).send({ code: "CMH.PAGINATION.INVALID", messageKey: "errors.pagination.invalid" });
    return history.queryUserPage(user.organizationId, user.id, { ...page, ...(query.keyword === undefined ? {} : { keyword: query.keyword }), ...(query.category === undefined ? {} : { category: query.category }), ...(query.pluginId === undefined ? {} : { pluginId: query.pluginId }) });
  });

  app.delete("/api/history", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (user === undefined) return undefined;
    const input = body<{ category?: string; pluginId?: string }>(request);
    const cleared = history.clearUser(user.organizationId, user.id, input ?? {});
    repository.audit(user.id, "history.cleared", String(cleared));
    return { cleared };
  });

  app.get("/api/catalog", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (user === undefined) return undefined;
    const query = request.query as { limit?: string; offset?: string; keyword?: string; category?: string };
    const page = pagination(query);
    if (page === undefined) return reply.code(400).send({ code: "CMH.PAGINATION.INVALID", messageKey: "errors.pagination.invalid" });
    return catalogService.queryUserPage(user.organizationId, user.id, { ...page, ...(query.keyword === undefined ? {} : { keyword: query.keyword }), ...(query.category === undefined ? {} : { category: query.category }) });
  });

  app.get("/api/notifications", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (user === undefined) return undefined;
    const query = request.query as { limit?: string; unreadOnly?: string };
    return { notifications: notifications.listUser(user.organizationId, user.id, { limit: query.limit === undefined ? 100 : Number(query.limit), unreadOnly: query.unreadOnly === "true" }) };
  });

  app.get("/api/audit", async (request, reply) => {
    const user = await requireAdmin(request, reply);
    if (user === undefined) return undefined;
    const query = request.query as { limit?: string; type?: string; actor?: string; keyword?: string };
    const parsed = query.limit === undefined ? 200 : Number(query.limit);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 500) return reply.code(400).send({ code: "CMH.AUDIT.INVALID_LIMIT", messageKey: "errors.audit.invalidLimit" });
    if (query.type !== undefined && (query.type.length === 0 || query.type.length > 96) || query.actor !== undefined && (query.actor.length === 0 || query.actor.length > 128) || query.keyword !== undefined && (query.keyword.length === 0 || query.keyword.length > 120)) return reply.code(400).send({ code: "CMH.AUDIT.INVALID_FILTER", messageKey: "errors.audit.invalidFilter" });
    const events = repository.auditEvents({ limit: parsed, ...(query.type === undefined ? {} : { type: query.type }), ...(query.actor === undefined ? {} : { actorId: query.actor }), ...(query.keyword === undefined ? {} : { keyword: query.keyword }) });
    if ((request.query as { format?: string }).format === "csv") {
      const csvCell = (value: string | null): string => `"${(value ?? "").replaceAll('"', '""')}"`;
      repository.audit(user.id, "audit.exported", `count:${events.length}`);
      const csv = ["id,actor_id,type,subject,created_at", ...events.map((event) => [event.id, event.actorId, event.type, event.subject, event.createdAt].map(csvCell).join(","))].join("\r\n") + "\r\n";
      return reply.type("text/csv; charset=utf-8").header("Content-Disposition", "attachment; filename=car-media-hub-audit.csv").header("Cache-Control", "no-store").send(csv);
    }
    return { events };
  });

  app.post("/api/notifications/:id/read", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (user === undefined) return undefined;
    const marked = notifications.markReadUser(user.organizationId, user.id, (request.params as { id: string }).id);
    if (!marked) return reply.code(404).send({ code: "CMH.NOTIFICATION.NOT_FOUND", messageKey: "errors.notification.notFound" });
    return { marked: true };
  });

  app.post("/api/notifications/read-all", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (user === undefined) return undefined;
    const marked = notifications.markAllReadUser(user.organizationId, user.id);
    repository.audit(user.id, "notifications.read_all", String(marked));
    return { marked };
  });

  app.get("/api/diagnostics/speed/download", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (user === undefined) return undefined;
    const rawBytes = (request.query as { bytes?: string }).bytes;
    const bytes = rawBytes === undefined ? 256 * 1024 : Number(rawBytes);
    if (!Number.isSafeInteger(bytes) || bytes < 64 * 1024 || bytes > 2 * 1024 * 1024) {
      return reply.code(400).send({ code: "CMH.DIAGNOSTICS.INVALID_SIZE", messageKey: "errors.diagnostics.invalidSize" });
    }
    repository.audit(user.id, "diagnostics.speed.download", String(bytes));
    return reply.header("cache-control", "no-store, max-age=0").header("content-type", "application/octet-stream").header("content-length", String(bytes)).send(Buffer.alloc(bytes, 0));
  });

  app.post("/api/diagnostics/speed/upload", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (user === undefined) return undefined;
    const contentLength = request.headers["content-length"];
    const bodyValue = request.body;
    const bytes = Buffer.isBuffer(bodyValue) ? bodyValue.length : 0;
    if (contentLength !== undefined && (!/^\d+$/u.test(contentLength) || Number(contentLength) !== bytes) || bytes < 64 * 1024 || bytes > 2 * 1024 * 1024) {
      return reply.code(400).send({ code: "CMH.DIAGNOSTICS.INVALID_SIZE", messageKey: "errors.diagnostics.invalidSize" });
    }
    repository.audit(user.id, "diagnostics.speed.upload", String(bytes));
    return reply.header("cache-control", "no-store, max-age=0").send({ bytes });
  });

  app.get("/api/users", async (request, reply) => {
    const user = await requireAdmin(request, reply);
    return user === undefined ? undefined : { users: repository.users(user.organizationId) };
  });

  app.post("/api/users", async (request, reply) => {
    const user = await requireAdmin(request, reply);
    if (user === undefined) return undefined;
    try {
      const input = body<{ username: string; password: string; role?: string; locale?: string }>(request);
      validCredential(input.username, "username");
      const created = repository.createUser({ organizationId: user.organizationId, username: input.username, password: input.password, role: input.role ?? "member", locale: input.locale ?? user.locale });
      repository.audit(user.id, "user.created", created.id);
      return reply.code(201).send({ user: created });
    } catch {
      return reply.code(400).send({ code: "CMH.USER.INVALID", messageKey: "errors.user.invalid" });
    }
  });

  app.post("/api/users/:id/revoke", async (request, reply) => {
    const user = await requireAdmin(request, reply);
    if (user === undefined) return undefined;
    const result = repository.revokeUser((request.params as { id: string }).id, user.organizationId);
    if (result === "last_admin") return reply.code(409).send({ code: "CMH.USER.LAST_ADMIN", messageKey: "errors.user.lastAdmin" });
    if (result === "not_found") return reply.code(404).send({ code: "CMH.USER.NOT_FOUND", messageKey: "errors.user.notFound" });
    mediaLibrary.revokePlaybackForUser((request.params as { id: string }).id);
    revokeHlsForUser(database.db, (request.params as { id: string }).id);
    runtimeBroker.revokeUserConnections((request.params as { id: string }).id);
    credentialVault.revokeUser(user.organizationId, (request.params as { id: string }).id);
    jobExecutor.cancelUser(user.organizationId, (request.params as { id: string }).id);
    browserTaskExecutor.cancelUser(user.organizationId, (request.params as { id: string }).id);
    await browserWorkerManager.stopUser(user.organizationId, (request.params as { id: string }).id);
    repository.audit(user.id, "user.revoked", (request.params as { id: string }).id);
    return reply.code(204).send();
  });

  app.get("/api/components/catalog", async (request, reply) => {
    const user = await requireAdmin(request, reply);
    return user === undefined ? undefined : { components: catalog.map(({ executable: _executablePath, ...component }) => ({ ...component, executable: _executablePath })) };
  });

  app.get("/api/media-roots", async (request, reply) => {
    const user = await requireAdmin(request, reply);
    return user === undefined ? undefined : { roots: mediaLibrary.roots(user.organizationId) };
  });

  app.post("/api/media-roots", async (request, reply) => {
    const user = await requireAdmin(request, reply);
    if (user === undefined) return undefined;
    try {
      const input = body<{ installationId: string; name: string; path: string }>(request);
      const root = mediaLibrary.addRoot(user.organizationId, input.installationId, input.name, input.path);
      repository.audit(user.id, "mediaRoot.created", root.id);
      return reply.code(201).send({ root });
    } catch {
      return reply.code(400).send({ code: "CMH.MEDIA_ROOT.INVALID", messageKey: "errors.mediaRoot.invalid" });
    }
  });

  app.get("/api/media-roots/:id/items", async (request, reply) => {
    const user = await requireAdmin(request, reply);
    if (user === undefined) return undefined;
    try {
      const limit = Number((request.query as { limit?: string }).limit ?? "200");
      const rootId = (request.params as { id: string }).id;
      const row = database.db.prepare("SELECT installation_id FROM media_roots WHERE id = ? AND organization_id = ?").get(rootId, user.organizationId) as { installation_id?: string } | undefined;
      if (row === undefined) return reply.code(404).send({ code: "CMH.MEDIA_ROOT.NOT_FOUND", messageKey: "errors.mediaRoot.notFound" });
      return { items: mediaLibrary.list(user.organizationId, row.installation_id ?? "__unbound__", rootId, limit) };
    } catch {
      return reply.code(404).send({ code: "CMH.MEDIA_ROOT.NOT_FOUND", messageKey: "errors.mediaRoot.notFound" });
    }
  });

  app.post("/api/media-roots/:id/revoke", async (request, reply) => {
    const user = await requireAdmin(request, reply);
    if (user === undefined) return undefined;
    if (!mediaLibrary.revoke(user.organizationId, (request.params as { id: string }).id)) return reply.code(404).send({ code: "CMH.MEDIA_ROOT.NOT_FOUND", messageKey: "errors.mediaRoot.notFound" });
    repository.audit(user.id, "mediaRoot.revoked", (request.params as { id: string }).id);
    return reply.code(204).send();
  });

  app.get("/api/media-sources", async (request, reply) => {
    const user = await requireAdmin(request, reply);
    if (user === undefined) return undefined;
    const installationId = (request.query as { installationId?: string }).installationId;
    if (typeof installationId !== "string") return reply.code(400).send({ code: "CMH.MEDIA_SOURCE.INVALID", messageKey: "errors.mediaSource.invalid" });
    return { sources: remoteMediaSources.listRegistered({ organizationId: user.organizationId, userId: user.id, deviceId: "admin", installationId }) };
  });

  app.post("/api/media-sources", async (request, reply) => {
    const user = await requireAdmin(request, reply);
    if (user === undefined) return undefined;
    try {
      const input = body<{ installationId?: unknown; name?: unknown; binding?: unknown; rootPath?: unknown; credentialRef?: unknown }>(request);
      if (typeof input.installationId !== "string" || typeof input.name !== "string" || typeof input.binding !== "string" || typeof input.rootPath !== "string" || (input.credentialRef !== undefined && typeof input.credentialRef !== "string")) throw new Error("Invalid media source");
      const installation = repository.pluginInstallation(input.installationId);
      if (installation?.status !== "installed" || !repository.pluginHasCapability(input.installationId, "media-source")) throw new Error("Media source capability is unavailable");
      if (input.credentialRef !== undefined && credentialVault.resolve({ deploymentId: "core", organizationId: user.organizationId, userId: user.id, deviceId: "admin", sessionId: "media-source", installationId: input.installationId }, input.credentialRef) === undefined) throw new Error("Credential is unavailable");
      const source = remoteMediaSources.register({ organizationId: user.organizationId, userId: user.id, deviceId: "admin", installationId: input.installationId }, { name: input.name, binding: input.binding, rootPath: input.rootPath, ...(input.credentialRef === undefined ? {} : { credentialRef: input.credentialRef }) });
      repository.audit(user.id, "mediaSource.created", source.sourceHandle);
      return reply.code(201).send({ source: { sourceHandle: source.sourceHandle, name: input.name.trim(), binding: source.binding, rootPath: source.rootPath } });
    } catch {
      return reply.code(400).send({ code: "CMH.MEDIA_SOURCE.INVALID", messageKey: "errors.mediaSource.invalid" });
    }
  });

  app.post("/api/media-sources/:handle/revoke", async (request, reply) => {
    const user = await requireAdmin(request, reply);
    if (user === undefined) return undefined;
    const sourceHandle = (request.params as { handle?: unknown }).handle;
    const installationId = (request.query as { installationId?: string }).installationId;
    if (typeof sourceHandle !== "string" || typeof installationId !== "string") return reply.code(400).send({ code: "CMH.MEDIA_SOURCE.INVALID", messageKey: "errors.mediaSource.invalid" });
    if (!remoteMediaSources.revoke({ organizationId: user.organizationId, userId: user.id, deviceId: "admin", installationId }, sourceHandle)) return reply.code(404).send({ code: "CMH.MEDIA_SOURCE.NOT_FOUND", messageKey: "errors.mediaSource.notFound" });
    repository.audit(user.id, "mediaSource.revoked", sourceHandle);
    return reply.code(204).send();
  });

  app.post("/api/media-sources/:handle/health", async (request, reply) => {
    const user = await requireAdmin(request, reply);
    if (user === undefined) return undefined;
    const sourceHandle = (request.params as { handle?: unknown }).handle;
    const installationId = (request.query as { installationId?: string }).installationId;
    if (typeof sourceHandle !== "string" || typeof installationId !== "string") return reply.code(400).send({ code: "CMH.MEDIA_SOURCE.INVALID", messageKey: "errors.mediaSource.invalid" });
    try { return await remoteMediaSources.health({ organizationId: user.organizationId, userId: user.id, deviceId: "admin", installationId }, sourceHandle); }
    catch { return reply.code(404).send({ code: "CMH.MEDIA_SOURCE.NOT_FOUND", messageKey: "errors.mediaSource.notFound" }); }
  });

  const transformOutputHandler = async (request: FastifyRequest, reply: { code(status: number): typeof reply; send(body?: unknown): unknown; header(name: string, value: string): typeof reply; type(value: string): typeof reply }) => {
    const user = await requireUser(request, reply);
    if (user === undefined) return undefined;
    const outputId = (request.params as { id: string }).id;
    const rangeHeader = singleHeader(request, "range");
    const match = rangeHeader === undefined ? undefined : /^bytes=(\d+)-(\d*)$/u.exec(rangeHeader);
    if (rangeHeader !== undefined && match === null) return reply.code(416).send({ code: "CMH.MEDIA.OUTPUT_RANGE_INVALID", messageKey: "errors.media.outputRangeInvalid" });
    const validMatch = match === null ? undefined : match;
    const start = validMatch === undefined ? 0 : Number(validMatch[1]);
    const requestedEnd = validMatch === undefined || validMatch[2] === "" ? start + 262_143 : Number(validMatch[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || requestedEnd < start) return reply.code(416).send({ code: "CMH.MEDIA.OUTPUT_RANGE_INVALID", messageKey: "errors.media.outputRangeInvalid" });
    try {
      const result = readTransformOutputForUser(database.db, options.dataDir, user.organizationId, user.id, outputId, start, requestedEnd);
      const bytes = Buffer.from(result.data, "base64");
      const end = start + bytes.byteLength - 1;
      reply.header("accept-ranges", "bytes").header("content-length", String(bytes.byteLength)).header("content-range", `bytes ${start}-${end}/${result.size}`).type(result.contentType);
      return reply.code(206).send(bytes);
    } catch {
      return reply.code(404).send({ code: "CMH.MEDIA.OUTPUT_NOT_FOUND", messageKey: "errors.media.outputNotFound" });
    }
  };
  app.get("/api/media/outputs/:id", transformOutputHandler);

  app.get("/api/components", async (request, reply) => {
    const user = await requireAdmin(request, reply);
    return user === undefined ? undefined : { components: repository.components(), bindings: repository.serviceBindings(), bindingGrants: repository.serviceBindingGrants() };
  });

  app.get("/api/credentials", async (request, reply) => {
    const user = await requireAdmin(request, reply);
    return user === undefined ? undefined : { credentials: credentialVault.list({ organizationId: user.organizationId, userId: user.id }) };
  });

  app.post("/api/credentials", async (request, reply) => {
    const user = await requireAdmin(request, reply);
    if (user === undefined) return undefined;
    try {
      const input = body<{ name?: unknown; kind?: unknown; value?: unknown; installationId?: unknown }>(request);
      if (typeof input?.name !== "string" || (input.kind !== "cookie" && input.kind !== "authorization") || typeof input.value !== "string" || typeof input.installationId !== "string") throw new Error("Invalid credential");
      const installation = repository.pluginInstallation(input.installationId);
      if (installation?.status !== "installed" || !repository.pluginHasCapability(input.installationId, "secrets")) throw new Error("Plugin installation is unavailable");
      const scope: ScopeContext = { deploymentId: "admin", organizationId: user.organizationId, userId: user.id, deviceId: "admin", sessionId: "admin", installationId: input.installationId };
      const credential = credentialVault.create(scope, { name: input.name, kind: input.kind, value: input.value });
      repository.audit(user.id, "credential.created", credential.id);
      return reply.code(201).send({ credential });
    } catch {
      return reply.code(400).send({ code: "CMH.CREDENTIAL.INVALID", messageKey: "errors.credential.invalid" });
    }
  });

  app.delete("/api/credentials/:id", async (request, reply) => {
    const user = await requireAdmin(request, reply);
    if (user === undefined) return undefined;
    const credentialId = (request.params as { id?: unknown }).id;
    if (typeof credentialId !== "string" || !credentialVault.revoke({ organizationId: user.organizationId, userId: user.id }, credentialId)) return reply.code(404).send({ code: "CMH.CREDENTIAL.NOT_FOUND", messageKey: "errors.credential.notFound" });
    repository.audit(user.id, "credential.revoked", credentialId);
    return reply.code(204).send();
  });

  app.get("/api/plugins", async (request, reply) => {
    const user = await requireAdmin(request, reply);
    return user === undefined ? undefined : { installations: repository.pluginInstallations().map((installation) => ({ ...installation, capabilities: repository.pluginCapabilities(installation.id), declaredCapabilities: repository.pluginDeclaredCapabilities(installation.id), worker: publicWorkerStatus(supervisor.status(installation.id)) })) };
  });

  app.patch("/api/plugins/:id/capabilities", async (request, reply) => {
    const user = await requireAdmin(request, reply);
    if (user === undefined) return undefined;
    const installationId = (request.params as { id: string }).id;
    const input = body<{ capabilities?: unknown }>(request);
    if (!Array.isArray(input?.capabilities) || input.capabilities.some((capability) => typeof capability !== "string")) return reply.code(400).send({ code: "CMH.PLUGIN.CAPABILITIES_INVALID", messageKey: "errors.plugin.capabilitiesInvalid" });
    const hadSecrets = repository.pluginHasCapability(installationId, "secrets");
    if (!repository.updatePluginCapabilities(installationId, input.capabilities as never[])) return reply.code(400).send({ code: "CMH.PLUGIN.CAPABILITIES_INVALID", messageKey: "errors.plugin.capabilitiesInvalid" });
    // Capability revocation must invalidate the Worker credential immediately.
    runtimeBroker.revokeInstallationCredentials(installationId);
    if (hadSecrets && !input.capabilities.includes("secrets")) credentialVault.revokeInstallation(user.organizationId, installationId);
    jobExecutor.cancelInstallation(user.organizationId, installationId);
    browserTaskExecutor.cancelInstallation(user.organizationId, installationId);
    await browserWorkerManager.stopInstallation(user.organizationId, installationId);
    await supervisor.stop(installationId);
    repository.audit(user.id, "plugin.capabilities.updated", installationId);
    return { installationId, capabilities: repository.pluginCapabilities(installationId) };
  });

  app.get("/api/jobs", async (request, reply) => {
    const user = await requireAdmin(request, reply);
    if (user === undefined) return undefined;
    const query = request.query as { limit?: string };
    return { jobs: jobs.listOrganization(user.organizationId, query.limit === undefined ? 200 : Number(query.limit)).map(({ payload: _payload, result: _result, ...metadata }) => metadata) };
  });

  app.get("/api/browser/sessions", async (request, reply) => {
    const user = await requireAdmin(request, reply);
    if (user === undefined) return undefined;
    return { sessions: repository.browserSessionsForOrganization(user.organizationId).map(({ userId, installationId, ...session }) => ({ ...session, userId, installationId })) };
  });

  app.post("/api/browser/sessions/:id/revoke", async (request, reply) => {
    const user = await requireAdmin(request, reply);
    if (user === undefined) return undefined;
    const sessionId = (request.params as { id?: unknown }).id;
    if (typeof sessionId !== "string" || !repository.revokeBrowserSessionForOrganization(user.organizationId, sessionId)) return reply.code(404).send({ code: "CMH.BROWSER.SESSION_NOT_FOUND", messageKey: "errors.browser.sessionNotFound" });
    const session = repository.browserSessionsForOrganization(user.organizationId).find((item) => item.id === sessionId);
    if (session !== undefined) browserTaskExecutor.cancelSession({ deploymentId: "core", organizationId: user.organizationId, userId: session.userId, deviceId: "core", sessionId: "core", installationId: session.installationId }, sessionId);
    await browserWorkerManager.stopSession(user.organizationId, sessionId);
    repository.audit(user.id, "browser.session.revoked", sessionId);
    return { revoked: true };
  });

  app.get("/api/browser/tasks", async (request, reply) => {
    const user = await requireAdmin(request, reply);
    if (user === undefined) return undefined;
    return { tasks: repository.browserTasksForOrganization(user.organizationId).map(({ input: _input, userId, installationId, ...task }) => ({ ...task, userId, installationId })) };
  });

  app.post("/api/browser/tasks/run", async (request, reply) => {
    const user = await requireAdmin(request, reply);
    if (user === undefined) return undefined;
    const limitValue = (body<{ limit?: unknown }>(request) ?? {}).limit;
    const limit = limitValue === undefined ? 10 : Number(limitValue);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return reply.code(400).send({ code: "CMH.BROWSER.TASK_LIMIT_INVALID", messageKey: "errors.browser.taskLimitInvalid" });
    const pending = repository.browserTasksForOrganization(user.organizationId).filter((task) => task.status === "queued");
    const scopes = new Map<string, ScopeContext>();
    for (const task of pending) {
      const scope = repository.runtimeScope(task.userId, task.installationId, "browser-task", "browser-task");
      if (scope !== undefined) scopes.set(`${task.userId}\0${task.installationId}`, scope);
    }
    const completed = [] as Array<Awaited<ReturnType<BrowserTaskExecutor["runOnce"]>>>;
    for (const scope of scopes.values()) {
      if (completed.length >= limit) break;
      while (completed.length < limit) {
        const task = await browserTaskExecutor.runOnce(scope);
        if (task === undefined) break;
        completed.push(task);
      }
    }
    repository.audit(user.id, "browser.tasks.run", String(completed.length));
    return { tasks: completed.filter((task): task is NonNullable<typeof task> => task !== undefined).map(({ input: _input, ...task }) => task) };
  });

  app.post("/api/browser/tasks/:id/cancel", async (request, reply) => {
    const user = await requireAdmin(request, reply);
    if (user === undefined) return undefined;
    const taskId = (request.params as { id?: unknown }).id;
    const task = typeof taskId === "string" ? repository.cancelBrowserTaskForOrganization(user.organizationId, taskId) : undefined;
    if (task === undefined) return reply.code(404).send({ code: "CMH.BROWSER.TASK_NOT_FOUND", messageKey: "errors.browser.taskNotFound" });
    repository.audit(user.id, "browser.task.cancelled", task.id);
    return { task: { id: task.id, sessionId: task.sessionId, kind: task.kind, status: task.status, createdAt: task.createdAt, updatedAt: task.updatedAt } };
  });

  app.post("/api/jobs/run", async (request, reply) => {
    const user = await requireAdmin(request, reply);
    if (user === undefined) return undefined;
    const limitValue = (body<{ limit?: unknown }>(request) ?? {}).limit;
    const limit = limitValue === undefined ? 10 : Number(limitValue);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return reply.code(400).send({ code: "CMH.JOBS.LIMIT_INVALID", messageKey: "errors.jobs.limitInvalid" });
    const pending = jobs.listOrganization(user.organizationId, 500).filter((job) => job.status === "queued");
    const scopes = new Map<string, ScopeContext>();
    for (const job of pending) {
      const scope = repository.runtimeScope(job.userId, job.installationId, "admin-job", "admin-job");
      if (scope !== undefined) scopes.set(`${job.userId}\0${job.installationId}`, scope);
    }
    const completed: PluginJob[] = [];
    for (const scope of scopes.values()) {
      if (completed.length >= limit) break;
      completed.push(...await jobExecutor.runUntilIdle(scope, Math.min(limit - completed.length, 100)));
    }
    repository.audit(user.id, "jobs.run", String(completed.length));
    return { jobs: completed.map(({ payload: _payload, result: _result, ...metadata }) => metadata) };
  });

  app.post("/api/jobs/:id/cancel", async (request, reply) => {
    const user = await requireAdmin(request, reply);
    if (user === undefined) return undefined;
    const job = jobExecutor.cancelOrganization(user.organizationId, (request.params as { id: string }).id);
    return job === undefined ? reply.code(404).send({ code: "CMH.JOB.NOT_FOUND", messageKey: "errors.job.notFound" }) : { job: { id: job.id, status: job.status, updatedAt: job.updatedAt, completedAt: job.completedAt } };
  });

  app.get("/api/plugins/:id/jobs", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (user === undefined) return undefined;
    const sessionToken = request.cookies.cmh_session;
    const session = sessionToken === undefined ? undefined : repository.sessionContext(sessionToken);
    const installationId = (request.params as { id: string }).id;
    const scope = session === undefined ? undefined : repository.runtimeScope(user.id, installationId, session.sessionId, session.deviceLabel);
    if (scope === undefined) return reply.code(404).send({ code: "CMH.PLUGIN.NOT_FOUND", messageKey: "errors.plugin.notFound" });
    const query = request.query as { limit?: string };
    return { jobs: jobs.list(scope, query.limit === undefined ? 100 : Number(query.limit)) };
  });

  app.post("/api/plugins/:id/jobs/:jobId/cancel", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (user === undefined) return undefined;
    const sessionToken = request.cookies.cmh_session;
    const session = sessionToken === undefined ? undefined : repository.sessionContext(sessionToken);
    const params = request.params as { id: string; jobId: string };
    const scope = session === undefined ? undefined : repository.runtimeScope(user.id, params.id, session.sessionId, session.deviceLabel);
    if (scope === undefined) return reply.code(404).send({ code: "CMH.PLUGIN.NOT_FOUND", messageKey: "errors.plugin.notFound" });
    const job = jobExecutor.cancel(scope, params.jobId);
    if (job === undefined) return reply.code(404).send({ code: "CMH.JOB.NOT_FOUND", messageKey: "errors.job.notFound" });
    repository.audit(user.id, "job.cancelled", job.id);
    return { job };
  });

  app.get("/api/plugins/:id/data/export", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (user === undefined) return undefined;
    const sessionToken = request.cookies.cmh_session;
    const session = sessionToken === undefined ? undefined : repository.sessionContext(sessionToken);
    const installationId = (request.params as { id: string }).id;
    const scope = session === undefined ? undefined : repository.runtimeScope(user.id, installationId, session.sessionId, session.deviceLabel);
    if (scope === undefined) return reply.code(404).send({ code: "CMH.PLUGIN.NOT_FOUND", messageKey: "errors.plugin.notFound" });
    try {
      const result = exportPluginData(database.db, scope);
      repository.audit(user.id, "plugin.data.exported", installationId);
      return reply.header("cache-control", "no-store").send(result);
    } catch {
      return reply.code(413).send({ code: "CMH.PLUGIN.DATA_EXPORT_TOO_LARGE", messageKey: "errors.plugin.dataExportTooLarge" });
    }
  });

  app.delete("/api/plugins/:id/data", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (user === undefined) return undefined;
    const input = body<{ confirm?: unknown }>(request) ?? {};
    if (input.confirm !== true) return reply.code(400).send({ code: "CMH.PLUGIN.DATA_DELETE_CONFIRMATION_REQUIRED", messageKey: "errors.plugin.dataDeleteConfirmationRequired" });
    const sessionToken = request.cookies.cmh_session;
    const session = sessionToken === undefined ? undefined : repository.sessionContext(sessionToken);
    const installationId = (request.params as { id: string }).id;
    const scope = session === undefined ? undefined : repository.runtimeScope(user.id, installationId, session.sessionId, session.deviceLabel);
    if (scope === undefined) return reply.code(404).send({ code: "CMH.PLUGIN.NOT_FOUND", messageKey: "errors.plugin.notFound" });
    const deleted = deletePluginData(database.db, scope);
    repository.audit(user.id, "plugin.data.deleted", `${installationId}:${deleted}`);
    return { deleted };
  });

  app.post("/api/plugins", async (request, reply) => {
    const user = await requireAdmin(request, reply);
    if (user === undefined) return undefined;
    try {
      if (options.pluginTrustKeys === undefined || options.pluginTrustKeys.length === 0) throw new Error("No plugin release trust keys configured");
      const manifest = verifyPluginRelease(body<SignedPluginRelease>(request), options.pluginTrustKeys);
      const installation = repository.installPlugin(manifest);
      repository.audit(user.id, "plugin.installed", installation.id);
      return reply.code(201).send({ installation });
    } catch {
      return reply.code(400).send({ code: "CMH.PLUGIN.INVALID_MANIFEST", messageKey: "errors.plugin.invalidManifest" });
    }
  });

  app.post("/api/plugins/packages/install", async (request, reply) => {
    const user = await requireAdmin(request, reply);
    if (user === undefined) return undefined;
    try {
      if (options.pluginTrustKeys === undefined || options.pluginTrustKeys.length === 0) throw new Error("No plugin release trust keys configured");
      const release = verifyPluginPackageRelease(body<SignedPluginPackageRelease>(request), options.pluginTrustKeys);
      if (repository.pluginInstallationByPackage(release.manifest.id, release.manifest.version) !== undefined) return reply.code(409).send({ code: "CMH.PLUGIN.ALREADY_INSTALLED", messageKey: "errors.plugin.alreadyInstalled" });
      const verified = repository.verifiedPluginPackage(release.manifest.id, release.manifest.version);
      if (verified !== undefined) {
        registerVerifiedPluginRuntime(verified);
        const installation = repository.installPlugin(release.manifest);
        repository.audit(user.id, "plugin.package.recovered", `${verified.packageId}@${verified.packageVersion}`);
        return reply.code(201).send({ package: { packageId: verified.packageId, version: verified.packageVersion, digest: verified.digest, location: verified.location }, installation });
      }
      const workerEntry = release.manifest.worker?.entry;
      const runtimeEntry = release.manifest.runtimeEntry?.entry;
      if (release.manifest.runtime === "isolated-worker" && workerEntry === undefined) throw new Error("Isolated plugin package has no worker entry");
      const installed = installStagedPluginPackage(options.dataDir, { packageId: release.manifest.id, version: release.manifest.version, artifactId: release.artifact.id, digest: release.artifact.digest, ...(workerEntry === undefined ? {} : { workerEntry }), ...(runtimeEntry === undefined ? {} : { runtimeEntry }) });
      if (release.manifest.runtime === "isolated-worker" && workerEntry !== undefined) {
        repository.registerVerifiedPluginPackage({ packageId: installed.packageId, packageVersion: installed.version, digest: installed.digest, location: installed.location, workerEntry });
        supervisor.register(createTrustedNodeWorkerFactory({ packageId: installed.packageId, packageRoot: path.resolve(options.dataDir, installed.location), workerEntry }));
      } else if (release.manifest.runtime === "shared-adapter-host" && runtimeEntry !== undefined) {
        repository.registerVerifiedPluginPackage({ packageId: installed.packageId, packageVersion: installed.version, digest: installed.digest, location: installed.location, runtimeEntry });
        supervisor.register(createTrustedSharedAdapterFactory({ packageId: installed.packageId, packageRoot: path.resolve(options.dataDir, installed.location), runtimeEntry }));
      }
      const installation = repository.installPlugin(release.manifest);
      repository.audit(user.id, "plugin.package.installed", `${installed.packageId}@${installed.version}`);
      return reply.code(201).send({ package: installed, installation });
    } catch (error) {
      if (error instanceof Error && error.message === "Plugin package already installed") return reply.code(409).send({ code: "CMH.PLUGIN.ALREADY_INSTALLED", messageKey: "errors.plugin.alreadyInstalled" });
      return reply.code(400).send({ code: "CMH.PLUGIN.PACKAGE_INVALID", messageKey: "errors.plugin.packageInvalid" });
    }
  });

  app.post("/api/plugins/:id/disable", async (request, reply) => {
    const user = await requireAdmin(request, reply);
    if (user === undefined) return undefined;
    const installationId = (request.params as { id: string }).id;
    if (!repository.disablePlugin(installationId)) return reply.code(404).send({ code: "CMH.PLUGIN.NOT_FOUND", messageKey: "errors.plugin.notFound" });
    mediaLibrary.revokePlaybackForInstallation(installationId);
    revokeHlsForInstallation(database.db, installationId);
    runtimeBroker.revokeInstallationCredentials(installationId);
    credentialVault.revokeInstallation(user.organizationId, installationId);
    jobExecutor.cancelInstallation(user.organizationId, installationId);
    browserTaskExecutor.cancelInstallation(user.organizationId, installationId);
    await browserWorkerManager.stopInstallation(user.organizationId, installationId);
    await supervisor.disable(installationId);
    repository.audit(user.id, "plugin.disabled", installationId);
    return reply.code(204).send();
  });

  app.post("/api/plugins/:id/enable", async (request, reply) => {
    const user = await requireAdmin(request, reply);
    if (user === undefined) return undefined;
    const installationId = (request.params as { id: string }).id;
    if (!repository.enablePlugin(installationId)) return reply.code(404).send({ code: "CMH.PLUGIN.NOT_FOUND", messageKey: "errors.plugin.notFound" });
    repository.audit(user.id, "plugin.enabled", installationId);
    return reply.code(204).send();
  });

  app.post("/api/plugins/:id/uninstall", async (request, reply) => {
    const user = await requireAdmin(request, reply);
    if (user === undefined) return undefined;
    const installationId = (request.params as { id: string }).id;
    if (!repository.uninstallPlugin(installationId)) return reply.code(409).send({ code: "CMH.PLUGIN.UNINSTALL_REQUIRES_DISABLED", messageKey: "errors.plugin.uninstallRequiresDisabled" });
    mediaLibrary.revokePlaybackForInstallation(installationId);
    mediaLibrary.revokeForInstallation(installationId);
    revokeHlsForInstallation(database.db, installationId);
    runtimeBroker.revokeInstallationCredentials(installationId);
    credentialVault.revokeInstallation(user.organizationId, installationId);
    jobExecutor.cancelInstallation(user.organizationId, installationId);
    browserTaskExecutor.cancelInstallation(user.organizationId, installationId);
    await browserWorkerManager.stopInstallation(user.organizationId, installationId);
    await supervisor.stop(installationId);
    repository.audit(user.id, "plugin.uninstalled", installationId);
    return reply.code(204).send();
  });

  app.post("/api/apps", async (request, reply) => {
    const user = await requireAdmin(request, reply);
    if (user === undefined) return undefined;
    try {
      const input = body<{ name: string; category: string; route: string; installationId: string; vehicleSupported?: boolean }>(request);
      const application = repository.addApplication({ ...input, vehicleSupported: input.vehicleSupported ?? false });
      repository.audit(user.id, "application.registered", application.id);
      return reply.code(201).send({ application });
    } catch {
      return reply.code(400).send({ code: "CMH.GATEWAY.ROUTE_CONFLICT", messageKey: "errors.gateway.routeConflict" });
    }
  });

  app.post("/api/keys", async (request, reply) => {
    const user = await requireAdmin(request, reply);
    if (user === undefined) return undefined;
    try {
      const input = body<{ applicationId: string; expiresAt?: string }>(request);
      const entry = repository.createEntryKey(input.applicationId, user.id, input.expiresAt);
      repository.audit(user.id, "entryKey.created", entry.id);
      return reply.code(201).send({ id: entry.id, key: entry.key });
    } catch {
      return reply.code(400).send({ code: "CMH.ENTRY_KEY.INVALID", messageKey: "errors.entryKey.invalid" });
    }
  });

  app.get("/api/keys", async (request, reply) => {
    const user = await requireAdmin(request, reply);
    return user === undefined ? undefined : { keys: repository.entryKeys(user.id) };
  });

  app.post("/api/keys/:id/revoke", async (request, reply) => {
    const user = await requireAdmin(request, reply);
    if (user === undefined) return undefined;
    repository.revokeEntryKey((request.params as { id: string }).id);
    repository.audit(user.id, "entryKey.revoked", (request.params as { id: string }).id);
    return reply.code(204).send();
  });

  app.get("/k/:key", async (request, reply) => {
    const subject = entrySubject(request);
    if (repository.rateLimited(subject)) return reply.code(429).send({ code: "CMH.ENTRY_KEY.RATE_LIMITED", messageKey: "errors.entryKey.rateLimited" });
    const resolution = repository.resolveEntryKey((request.params as { key: string }).key);
    if (resolution === undefined) {
      repository.recordFailedAttempt(subject, 20, 600_000, 600_000);
      repository.audit(undefined, "entryKey.failed", "redacted");
      return reply.code(404).send({ code: "CMH.ENTRY_KEY.NOT_FOUND", messageKey: "errors.entryKey.notFound" });
    }
    repository.clearFailedAttempts(subject);
    repository.audit(resolution.userId, "entryKey.used", resolution.application.id);
    reply.setCookie("cmh_entry", resolution.application.id, { httpOnly: true, sameSite: "strict", path: resolution.application.route, secure: options.cookieSecure ?? false, maxAge: 60 * 60 });
    return reply.redirect(resolution.application.route, 302);
  });

  app.post("/api/components", async (request, reply) => {
    const user = await requireAdmin(request, reply);
    if (user === undefined) return undefined;
    try {
      const input = body<{ id: string; version: string; executable: string; checksum: string }>(request);
      repository.registerComponent(input);
      repository.audit(user.id, "component.registered", input.id);
      return reply.code(201).send({ component: { id: input.id, version: input.version, health: "unknown" } });
    } catch {
      return reply.code(400).send({ code: "CMH.COMPONENT.INVALID", messageKey: "errors.component.invalid" });
    }
  });

  app.post("/api/components/install", async (request, reply) => {
    const user = await requireAdmin(request, reply);
    if (user === undefined) return undefined;
    try {
      if (options.componentTrustKeys === undefined || options.componentTrustKeys.length === 0) throw new Error("No component release trust keys configured");
      const input = body<SignedComponentRelease>(request);
      const installed = installSignedComponentRelease(options.dataDir, catalog, input, options.componentTrustKeys, currentPlatformKey());
      repository.registerComponent({ id: installed.id, version: installed.version, executable: installed.executable, checksum: installed.checksum });
      repository.audit(user.id, "component.installed", `${installed.id}@${installed.version}`);
      return reply.code(201).send({ component: installed });
    } catch {
      return reply.code(400).send({ code: "CMH.COMPONENT.INSTALL_INVALID", messageKey: "errors.component.installInvalid" });
    }
  });

  app.post("/api/components/:id/health", async (request, reply) => {
    const user = await requireAdmin(request, reply);
    if (user === undefined) return undefined;
    const componentId = (request.params as { id: string }).id;
    const component = repository.componentById(componentId);
    if (component === undefined) return reply.code(404).send({ code: "CMH.COMPONENT.NOT_FOUND", messageKey: "errors.component.notFound" });
    let health: "healthy" | "unhealthy" = "unhealthy";
    try {
      const executable = resolveInstalledExecutable(options.dataDir, component);
      const actual = await sha256File(executable);
      const expected = component.checksum.startsWith("sha256:") ? component.checksum.slice("sha256:".length) : component.checksum;
      if (/^[a-f0-9]{64}$/u.test(expected) && actual === expected) health = "healthy";
    } catch { health = "unhealthy"; }
    repository.updateComponentHealth(componentId, health);
    repository.audit(user.id, health === "healthy" ? "component.healthChecked" : "component.healthFailed", componentId);
    return { component: { id: componentId, health } };
  });

  app.all("/apps/*", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (user === undefined) return undefined;
    const sessionToken = request.cookies.cmh_session;
    const session = sessionToken === undefined ? undefined : repository.sessionContext(sessionToken);
    if (session === undefined) return reply.code(401).send({ code: "CMH.AUTH.REQUIRED", messageKey: "errors.auth.required" });
    const requestPath = request.url.split("?", 1)[0] ?? request.url;
    const application = repository.applicationForPath(requestPath);
    if (application === undefined) return reply.code(404).send({ code: "CMH.GATEWAY.ROUTE_NOT_FOUND", messageKey: "errors.gateway.routeNotFound" });
    const scope = repository.runtimeScope(user.id, application.installationId, session.sessionId, session.deviceLabel, presentationContext(request, application.id));
    if (scope === undefined) return reply.code(404).send({ code: "CMH.GATEWAY.PLUGIN_DISABLED", messageKey: "errors.gateway.pluginDisabled" });
    const streamLease = gatewayStreamQuota.tryAcquire(session.sessionId);
    if (streamLease === undefined) return reply.code(429).header("retry-after", "1").send({ code: "CMH.GATEWAY.STREAM_LIMIT", messageKey: "errors.gateway.streamLimit", retryable: true });
    const relativePath = requestPath.slice(application.route.length) || "/";
    const routeMethods = repository.pluginRouteMethods(application.installationId, relativePath);
    if (routeMethods === undefined) {
      streamLease.release();
      return reply.code(404).send({ code: "CMH.GATEWAY.ROUTE_NOT_FOUND", messageKey: "errors.gateway.routeNotFound" });
    }
    if (!routeMethods.includes(request.method)) {
      streamLease.release();
      return reply.code(405).header("allow", routeMethods.join(", ")).send({ code: "CMH.GATEWAY.METHOD_NOT_ALLOWED", messageKey: "errors.gateway.methodNotAllowed" });
    }
    try {
      const workerStatus = await supervisor.start(application.installationId, scope);
      if (workerStatus.state !== "running") return reply.code(503).send({ code: "CMH.GATEWAY.WORKER_UNAVAILABLE", messageKey: "errors.gateway.workerUnavailable", retryable: true });
      await runtimeBroker.waitForWorker(application.installationId, scope.userId);
      const stream = runtimeBroker.invokeStream(application.installationId, scope, {
        method: request.method as "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE",
        path: relativePath,
        query: request.query as Record<string, string | string[]>,
        headers: pluginRequestHeaders(request),
        body: request.body
      });
      const start = await stream.start;
      const allowedHeaders = new Set(["content-type", "content-length", "content-range", "accept-ranges", "cache-control", "etag", "last-modified"]);
      reply.code(start.status);
      for (const [name, value] of Object.entries(start.headers ?? {})) {
        if (allowedHeaders.has(name.toLowerCase()) && !name.includes("\r") && !name.includes("\n")) reply.header(name, value);
      }
      const abort = () => stream.cancel("Client disconnected");
      // IncomingMessage close also fires after a normally completed request body;
      // only `aborted` means the client actually cancelled the request.
      request.raw.once("aborted", abort);
      if (request.method === "HEAD") {
        request.raw.off("aborted", abort);
        stream.cancel("HEAD request");
        streamLease.release();
        return reply.send();
      }
      const body = Readable.from((async function* () {
        try {
          for await (const chunk of stream) {
            if (!streamLease.consume(chunk.length)) { stream.cancel("Gateway stream byte quota exceeded"); throw new Error("Gateway stream byte quota exceeded"); }
            yield chunk;
          }
        } finally {
          request.raw.off("aborted", abort);
          streamLease.release();
        }
      })());
      return reply.send(body);
    } catch {
      streamLease.release();
      return reply.code(503).send({ code: "CMH.GATEWAY.WORKER_UNAVAILABLE", messageKey: "errors.gateway.workerUnavailable", retryable: true });
    }
  });

  app.post("/api/service-bindings", async (request, reply) => {
    const user = await requireAdmin(request, reply);
    if (user === undefined) return undefined;
    try {
      const input = body<{ componentId: string; name: string; endpoint: string; installationId?: string }>(request);
      repository.bindService(input);
      repository.audit(user.id, "serviceBinding.created", input.name);
      return reply.code(201).send({ binding: { name: input.name, componentId: input.componentId } });
    } catch {
      return reply.code(400).send({ code: "CMH.SERVICE_BINDING.INVALID", messageKey: "errors.serviceBinding.invalid" });
    }
  });

  app.delete("/api/service-bindings/:id", async (request, reply) => {
    const user = await requireAdmin(request, reply);
    if (user === undefined) return undefined;
    try {
      const bindingId = (request.params as { id: string }).id;
      if (!repository.revokeServiceBinding(bindingId)) return reply.code(404).send({ code: "CMH.SERVICE_BINDING.NOT_FOUND", messageKey: "errors.serviceBinding.notFound" });
      repository.audit(user.id, "serviceBinding.revoked", bindingId);
      return reply.code(204).send();
    } catch {
      return reply.code(400).send({ code: "CMH.SERVICE_BINDING.INVALID", messageKey: "errors.serviceBinding.invalid" });
    }
  });

  app.post("/api/service-bindings/:id/health", async (request, reply) => {
    const user = await requireAdmin(request, reply);
    if (user === undefined) return undefined;
    const bindingId = (request.params as { id: string }).id;
    const binding = repository.serviceBindingById(bindingId);
    if (binding === undefined) return reply.code(404).send({ code: "CMH.SERVICE_BINDING.NOT_FOUND", messageKey: "errors.serviceBinding.notFound" });
    const startedAt = Date.now();
    try {
      const response = await fetch(binding.endpoint, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(5_000) });
      repository.audit(user.id, "serviceBinding.healthChecked", bindingId);
      return { reachable: true, status: response.status, latencyMs: Date.now() - startedAt };
    } catch {
      repository.audit(user.id, "serviceBinding.healthFailed", bindingId);
      return reply.code(503).send({ reachable: false, latencyMs: Date.now() - startedAt, code: "CMH.SERVICE_BINDING.UNREACHABLE", messageKey: "errors.serviceBinding.unreachable" });
    }
  });

  app.get("/", async (_request, reply) => {
    const page = path.join(import.meta.dirname, "..", "public", "index.html");
    return reply.type("text/html; charset=utf-8").send(fs.readFileSync(page, "utf8"));
  });

  app.get("/admin", async (_request, reply) => reply.redirect("/admin/", 302));
  app.get("/admin/", async (_request, reply) => {
    const page = path.join(import.meta.dirname, "..", "public", "admin", "index.html");
    if (!fs.existsSync(page)) return reply.code(503).send({ code: "CMH.ADMIN.BUILD_REQUIRED", messageKey: "errors.admin.buildRequired" });
    return reply.type("text/html; charset=utf-8").send(fs.readFileSync(page, "utf8"));
  });
  app.get("/admin/*", async (request, reply) => {
    const relative = (request.params as { "*": string })["*"];
    const root = path.resolve(import.meta.dirname, "..", "public", "admin");
    const asset = path.resolve(root, relative);
    if (!asset.startsWith(root + path.sep) || !fs.existsSync(asset) || !fs.statSync(asset).isFile()) return reply.code(404).send({ code: "CMH.ADMIN.ASSET_NOT_FOUND", messageKey: "errors.admin.assetNotFound" });
    const extension = path.extname(asset).toLowerCase();
    const contentType = extension === ".js" ? "application/javascript" : extension === ".css" ? "text/css" : extension === ".json" ? "application/json" : "application/octet-stream";
    return reply.type(contentType).send(fs.readFileSync(asset));
  });

  return app;
}

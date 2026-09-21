import fs from "node:fs";
import path from "node:path";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import { openDatabase } from "./database.js";
import { Repository, type UserRecord } from "./repository.js";
import { ensureServerKey } from "./security.js";
import { loadComponentCatalog, resolveManagedExecutable } from "./components.js";
import { installSignedComponentRelease, type SignedComponentRelease } from "./component-release.js";
import { currentPlatformKey } from "./components.js";
import { RuntimeBroker } from "./runtime-broker.js";
import { PluginJobService } from "./job-service.js";
import { verifyPluginRelease, type SignedPluginRelease } from "./plugin-release.js";
import { WorkerSupervisor } from "./worker-supervisor.js";
import { createTrustedNodeWorkerFactory, type TrustedWorkerPackage } from "./trusted-worker-factory.js";
import { installStagedPluginPackage } from "./plugin-package-installer.js";
import { verifyPluginPackageRelease, type SignedPluginPackageRelease } from "./plugin-package-release.js";
import { MediaLibraryService } from "./media-library-service.js";
import { GatewayStreamQuota } from "./gateway-stream-quota.js";

export interface AppOptions { dataDir: string; cookieSecure?: boolean; componentTrustKeys?: readonly string[]; pluginTrustKeys?: readonly string[]; trustedWorkerPackages?: readonly TrustedWorkerPackage[]; gatewayStreamQuota?: GatewayStreamQuota; }

function body<T>(request: FastifyRequest): T { return request.body as T; }

function validCredential(value: string, field: string): void {
  if (value.trim().length < 3 || value.length > 128) throw new Error(`${field} must contain 3 to 128 characters`);
}

export async function createApp(options: AppOptions): Promise<FastifyInstance> {
  const database = openDatabase(options.dataDir);
  const serverKey = ensureServerKey(options.dataDir);
  const repository = new Repository(database.db, serverKey);
  const mediaLibrary = new MediaLibraryService(database.db, serverKey);
  const jobs = new PluginJobService(database.db);
  const gatewayStreamQuota = options.gatewayStreamQuota ?? new GatewayStreamQuota();
  const runtimeBroker = new RuntimeBroker({
    dataDir: options.dataDir,
    installationEnabled: (installationId) => repository.pluginInstallation(installationId)?.status === "installed",
    onWorkerRequest: (request, scope) => {
      if (request.method === "media.list") {
        if (!repository.pluginHasCapability(scope.installationId, "media")) throw new Error("Plugin media capability is not granted");
        return { media: mediaLibrary.roots(scope.organizationId).flatMap((root) => mediaLibrary.list(scope.organizationId, root.id)) };
      }
      if (request.method === "media.read") {
        if (!repository.pluginHasCapability(scope.installationId, "media")) throw new Error("Plugin media capability is not granted");
        const input = request.params as { mediaId?: unknown; start?: unknown; end?: unknown } | undefined;
        if (typeof input?.mediaId !== "string" || typeof input.start !== "number" || typeof input.end !== "number") throw new Error("Invalid media read request");
        return mediaLibrary.read(scope.organizationId, input.mediaId, input.start, input.end);
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
  for (const verified of repository.verifiedPluginPackages()) {
    supervisor.register(createTrustedNodeWorkerFactory({ packageId: verified.packageId, packageRoot: path.resolve(options.dataDir, verified.location), workerEntry: verified.workerEntry }));
  }
  for (const workerPackage of options.trustedWorkerPackages ?? []) supervisor.register(createTrustedNodeWorkerFactory(workerPackage));
  const catalog = loadComponentCatalog(path.resolve(import.meta.dirname, ".."));
  const app = Fastify({ logger: false });
  await app.register(cookie);
  const loginSubject = (request: FastifyRequest, username: string) => `login:${request.ip}:${username.trim().toLowerCase()}`;
  const entrySubject = (request: FastifyRequest) => `entry:${request.ip}`;

  await runtimeBroker.start();
  app.addHook("onClose", async () => {
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

  app.get("/api/health", async () => ({ status: "ok", initialized: repository.initialized() }));
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
    if (request.cookies.cmh_session !== undefined) repository.revokeSession(request.cookies.cmh_session);
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
    repository.audit(user.id, "user.revoked", (request.params as { id: string }).id);
    return reply.code(204).send();
  });

  app.get("/api/components/catalog", async (request, reply) => {
    const user = await requireAdmin(request, reply);
    return user === undefined ? undefined : { components: catalog.map((component) => ({ ...component, executablePath: resolveManagedExecutable(options.dataDir, component) })) };
  });

  app.get("/api/media-roots", async (request, reply) => {
    const user = await requireAdmin(request, reply);
    return user === undefined ? undefined : { roots: mediaLibrary.roots(user.organizationId) };
  });

  app.post("/api/media-roots", async (request, reply) => {
    const user = await requireAdmin(request, reply);
    if (user === undefined) return undefined;
    try {
      const input = body<{ name: string; path: string }>(request);
      const root = mediaLibrary.addRoot(user.organizationId, input.name, input.path);
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
      return { items: mediaLibrary.list(user.organizationId, (request.params as { id: string }).id, limit) };
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

  app.get("/api/components", async (request, reply) => {
    const user = await requireAdmin(request, reply);
    return user === undefined ? undefined : { components: repository.components(), bindings: repository.serviceBindings() };
  });

  app.get("/api/plugins", async (request, reply) => {
    const user = await requireAdmin(request, reply);
    return user === undefined ? undefined : { installations: repository.pluginInstallations() };
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
    const job = jobs.transition(scope, params.jobId, "cancelled");
    if (job === undefined) return reply.code(404).send({ code: "CMH.JOB.NOT_FOUND", messageKey: "errors.job.notFound" });
    repository.audit(user.id, "job.cancelled", job.id);
    return { job };
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
      const workerEntry = release.manifest.worker?.entry;
      if (release.manifest.runtime === "isolated-worker" && workerEntry === undefined) throw new Error("Isolated plugin package has no worker entry");
      const installed = installStagedPluginPackage(options.dataDir, { packageId: release.manifest.id, version: release.manifest.version, artifactId: release.artifact.id, digest: release.artifact.digest, ...(workerEntry === undefined ? {} : { workerEntry }) });
      if (release.manifest.runtime === "isolated-worker" && workerEntry !== undefined) {
        repository.registerVerifiedPluginPackage({ packageId: installed.packageId, packageVersion: installed.version, digest: installed.digest, location: installed.location, workerEntry });
        supervisor.register(createTrustedNodeWorkerFactory({ packageId: installed.packageId, packageRoot: path.resolve(options.dataDir, installed.location), workerEntry }));
      }
      repository.audit(user.id, "plugin.package.installed", `${installed.packageId}@${installed.version}`);
      return reply.code(201).send({ package: installed });
    } catch {
      return reply.code(400).send({ code: "CMH.PLUGIN.PACKAGE_INVALID", messageKey: "errors.plugin.packageInvalid" });
    }
  });

  app.post("/api/plugins/:id/disable", async (request, reply) => {
    const user = await requireAdmin(request, reply);
    if (user === undefined) return undefined;
    const installationId = (request.params as { id: string }).id;
    if (!repository.disablePlugin(installationId)) return reply.code(404).send({ code: "CMH.PLUGIN.NOT_FOUND", messageKey: "errors.plugin.notFound" });
    await supervisor.disable(installationId);
    repository.audit(user.id, "plugin.disabled", installationId);
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

  app.all("/apps/*", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (user === undefined) return undefined;
    const sessionToken = request.cookies.cmh_session;
    const session = sessionToken === undefined ? undefined : repository.sessionContext(sessionToken);
    if (session === undefined) return reply.code(401).send({ code: "CMH.AUTH.REQUIRED", messageKey: "errors.auth.required" });
    const requestPath = request.url.split("?", 1)[0] ?? request.url;
    const application = repository.applicationForPath(requestPath);
    if (application === undefined) return reply.code(404).send({ code: "CMH.GATEWAY.ROUTE_NOT_FOUND", messageKey: "errors.gateway.routeNotFound" });
    const scope = repository.runtimeScope(user.id, application.installationId, session.sessionId, session.deviceLabel);
    if (scope === undefined) return reply.code(404).send({ code: "CMH.GATEWAY.PLUGIN_DISABLED", messageKey: "errors.gateway.pluginDisabled" });
    const streamLease = gatewayStreamQuota.tryAcquire(session.sessionId);
    if (streamLease === undefined) return reply.code(429).header("retry-after", "1").send({ code: "CMH.GATEWAY.STREAM_LIMIT", messageKey: "errors.gateway.streamLimit", retryable: true });
    const relativePath = requestPath.slice(application.route.length) || "/";
    try {
      const workerStatus = await supervisor.start(application.installationId, scope);
      if (workerStatus.state !== "running") return reply.code(503).send({ code: "CMH.GATEWAY.WORKER_UNAVAILABLE", messageKey: "errors.gateway.workerUnavailable", retryable: true });
      await runtimeBroker.waitForWorker(application.installationId, scope.userId);
      const stream = runtimeBroker.invokeStream(application.installationId, scope, {
        method: request.method as "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
        path: relativePath,
        query: request.query as Record<string, string | string[]>,
        headers: Object.fromEntries(Object.entries(request.headers).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
        body: request.body
      });
      const start = await stream.start;
      const allowedHeaders = new Set(["content-type", "content-length", "content-range", "accept-ranges", "cache-control", "etag", "last-modified"]);
      reply.hijack();
      reply.raw.statusCode = start.status;
      for (const [name, value] of Object.entries(start.headers ?? {})) {
        if (allowedHeaders.has(name.toLowerCase()) && !name.includes("\r") && !name.includes("\n")) reply.raw.setHeader(name, value);
      }
      const abort = () => stream.cancel("Client disconnected");
      request.raw.once("close", abort);
      try {
        for await (const chunk of stream) {
          if (!reply.raw.destroyed) reply.raw.write(chunk);
        }
        if (!reply.raw.destroyed) reply.raw.end();
      } catch {
        if (!reply.raw.destroyed) reply.raw.destroy();
      } finally {
        request.raw.off("close", abort);
        streamLease.release();
      }
      return reply;
    } catch {
      streamLease.release();
      return reply.code(503).send({ code: "CMH.GATEWAY.WORKER_UNAVAILABLE", messageKey: "errors.gateway.workerUnavailable", retryable: true });
    }
  });

  app.post("/api/service-bindings", async (request, reply) => {
    const user = await requireAdmin(request, reply);
    if (user === undefined) return undefined;
    try {
      const input = body<{ componentId: string; name: string; endpoint: string }>(request);
      repository.bindService(input);
      repository.audit(user.id, "serviceBinding.created", input.name);
      return reply.code(201).send({ binding: { name: input.name, componentId: input.componentId } });
    } catch {
      return reply.code(400).send({ code: "CMH.SERVICE_BINDING.INVALID", messageKey: "errors.serviceBinding.invalid" });
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

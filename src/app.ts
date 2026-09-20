import fs from "node:fs";
import path from "node:path";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import { openDatabase } from "./database.js";
import { Repository, type UserRecord } from "./repository.js";
import { ensureServerKey } from "./security.js";

export interface AppOptions { dataDir: string; }

function body<T>(request: FastifyRequest): T { return request.body as T; }

function validCredential(value: string, field: string): void {
  if (value.trim().length < 3 || value.length > 128) throw new Error(`${field} must contain 3 to 128 characters`);
}

export async function createApp(options: AppOptions): Promise<FastifyInstance> {
  const database = openDatabase(options.dataDir);
  const repository = new Repository(database.db, ensureServerKey(options.dataDir));
  const app = Fastify({ logger: false });
  await app.register(cookie);

  app.addHook("onClose", async () => database.close());

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
    const input = body<{ username: string; password: string; deviceLabel?: string }>(request);
    const result = repository.login(input.username ?? "", input.password ?? "", input.deviceLabel ?? "Browser");
    if (result === undefined) return reply.code(401).send({ code: "CMH.AUTH.INVALID_CREDENTIALS", messageKey: "errors.auth.invalidCredentials" });
    repository.audit(result.user.id, "auth.login", "session");
    reply.setCookie("cmh_session", result.token, { httpOnly: true, sameSite: "strict", path: "/", secure: false, maxAge: 60 * 60 * 24 * 30 });
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

  app.get("/api/apps", async (request, reply) => {
    const user = await requireUser(request, reply);
    return user === undefined ? undefined : { applications: repository.applications() };
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

  app.post("/api/keys/:id/revoke", async (request, reply) => {
    const user = await requireAdmin(request, reply);
    if (user === undefined) return undefined;
    repository.revokeEntryKey((request.params as { id: string }).id);
    repository.audit(user.id, "entryKey.revoked", (request.params as { id: string }).id);
    return reply.code(204).send();
  });

  app.get("/k/:key", async (request, reply) => {
    const resolution = repository.resolveEntryKey((request.params as { key: string }).key);
    if (resolution === undefined) return reply.code(404).send({ code: "CMH.ENTRY_KEY.NOT_FOUND", messageKey: "errors.entryKey.notFound" });
    repository.audit(resolution.userId, "entryKey.used", resolution.application.id);
    reply.setCookie("cmh_entry", resolution.application.id, { httpOnly: true, sameSite: "strict", path: resolution.application.route, secure: false, maxAge: 60 * 60 });
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

  return app;
}

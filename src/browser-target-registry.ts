const targetId = /^[a-z][a-z0-9._-]{0,127}$/u;

export interface BrowserTargetDefinition {
  id: string;
  origins: readonly string[];
}

export interface BrowserTarget {
  readonly id: string;
  readonly origins: readonly string[];
}

/** Core-owned logical browser targets. Plugins receive only the target id. */
export class BrowserTargetRegistry {
  private readonly targets = new Map<string, BrowserTarget>();

  register(definition: BrowserTargetDefinition): void {
    if (!targetId.test(definition.id) || this.targets.has(definition.id)) throw new Error("Browser target id is invalid or already registered");
    if (!Array.isArray(definition.origins) || definition.origins.length === 0 || definition.origins.length > 16) throw new Error("Browser target origins are invalid");
    const origins = [...new Set(definition.origins.map(normalizeOrigin))];
    if (origins.length !== definition.origins.length) throw new Error("Browser target origins must be unique");
    this.targets.set(definition.id, Object.freeze({ id: definition.id, origins: Object.freeze(origins) }));
  }

  get(id: string): BrowserTarget | undefined {
    const target = this.targets.get(id);
    return target === undefined ? undefined : { id: target.id, origins: [...target.origins] };
  }

  /** Returns logical identifiers only; origins remain Core-owned. */
  ids(): string[] { return [...this.targets.keys()].sort(); }

  /** Returns a defensive snapshot for the administrator diagnostics surface. */
  list(): BrowserTarget[] { return this.ids().map((id) => this.get(id)!); }

  allowsOrigin(id: string, origin: string): boolean {
    const target = this.targets.get(id);
    if (target === undefined) return false;
    let normalized: string;
    try { normalized = normalizeOrigin(origin); } catch { return false; }
    return target.origins.includes(normalized);
  }

  resolveUrl(id: string, relativePath = "/"): string {
    const target = this.targets.get(id);
    if (target === undefined) throw new Error("Browser target is not registered");
    if (typeof relativePath !== "string" || !relativePath.startsWith("/") || relativePath.startsWith("//") || relativePath.includes("\\") || relativePath.split("/").includes("..") || relativePath.length > 2048) throw new Error("Browser target path is invalid");
    const url = new URL(relativePath, target.origins[0]);
    if (url.origin !== target.origins[0]) throw new Error("Browser target path escaped origin");
    return url.toString();
  }
}

function normalizeOrigin(value: string): string {
  if (typeof value !== "string" || value.length > 256) throw new Error("Browser target origin is invalid");
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error("Browser target origin is invalid"); }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" || parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") throw new Error("Browser target origin is invalid");
  return parsed.origin;
}

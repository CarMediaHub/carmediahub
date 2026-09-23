export interface NetworkExecutionRequest { binding: string; method: string; path: string; headers?: unknown; body?: unknown; credentialRef?: string; }
export interface NetworkExecutionResponse { status: number; headers: Record<string, string>; bodyBase64?: string; }
export type BindingResolver = (name: string) => { endpoint: string } | undefined;
export type CredentialResolver = (credentialRef: string) => { name: "cookie" | "authorization"; value: string } | undefined;

const methods = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
const headers = new Set(["accept", "accept-language", "content-type", "if-none-match", "range"]);
const maxRedirects = 3;
const maxConcurrentPerBinding = 10;
const activeRequests = new Map<string, number>();

export async function executeNetworkRequest(input: NetworkExecutionRequest, resolve: BindingResolver, resolveCredential?: CredentialResolver): Promise<NetworkExecutionResponse> {
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(input.binding) || !methods.has(input.method) || !input.path.startsWith("/") || input.path.includes("\\") || input.path.split("/").includes("..")) throw new Error("Invalid network request");
  if (input.body !== undefined && (typeof input.body !== "string" || Buffer.byteLength(input.body, "utf8") > 64 * 1024)) throw new Error("Network request body is too large");
  const binding = resolve(input.binding);
  if (binding === undefined) throw new Error("Network target is not bound");
  const base = new URL(binding.endpoint);
  let target = new URL(input.path, base);
  if (target.origin !== base.origin || target.username !== "" || target.password !== "" || target.hash !== "") throw new Error("Network target is invalid");
  const rawHeaders = typeof input.headers === "object" && input.headers !== null ? input.headers as Record<string, unknown> : {};
  if (input.credentialRef !== undefined && Object.keys(rawHeaders).some((key) => key.toLowerCase() === "cookie" || key.toLowerCase() === "authorization")) throw new Error("Credential header cannot be overridden");
  const requestHeaders: Record<string, string> = Object.fromEntries(Object.entries(rawHeaders).filter(([key, value]) => headers.has(key.toLowerCase()) && typeof value === "string" && value.length <= 2048) as Array<[string, string]>);
  if (input.credentialRef !== undefined) {
    if (resolveCredential === undefined || !/^cred_[A-Za-z0-9-]+$/u.test(input.credentialRef)) throw new Error("Credential reference is unavailable");
    const credential = resolveCredential(input.credentialRef);
    if (credential === undefined) throw new Error("Credential reference is unavailable");
    const header = credential.name === "cookie" ? "cookie" : "authorization";
    if (requestHeaders[header] !== undefined) throw new Error("Credential header cannot be overridden");
    requestHeaders[header] = credential.value;
  }
  const active = activeRequests.get(input.binding) ?? 0;
  if (active >= maxConcurrentPerBinding) throw new Error("Network concurrency limit exceeded");
  activeRequests.set(input.binding, active + 1);
  try {
    let response: Response;
    for (let redirect = 0; ; redirect += 1) {
      response = await fetch(target, { method: input.method, headers: requestHeaders, redirect: "manual", signal: AbortSignal.timeout(30_000), ...(input.body === undefined ? {} : { body: input.body }) });
      if (response.status < 300 || response.status >= 400) break;
      const location = response.headers.get("location");
      if (location === null || redirect >= maxRedirects || input.method !== "GET" && input.method !== "HEAD") throw new Error("Network redirect is not allowed");
      const next = new URL(location, target);
      if (next.origin !== base.origin || next.username !== "" || next.password !== "" || next.hash !== "" || !next.pathname.startsWith("/")) throw new Error("Network redirect target is invalid");
      target = next;
    }
    const contentLength = response.headers.get("content-length");
    if (contentLength !== null && /^\d+$/u.test(contentLength) && Number(contentLength) > 1024 * 1024) throw new Error("Network response is too large");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 1024 * 1024) throw new Error("Network response is too large");
    const responseHeaders = Object.fromEntries(["content-type", "content-length", "content-range", "etag", "last-modified", "accept-ranges"].flatMap((name) => { const value = response.headers.get(name); return value === null ? [] : [[name, value]]; }));
    return { status: response.status, headers: responseHeaders, ...(input.method === "HEAD" ? {} : { bodyBase64: bytes.toString("base64") }) };
  } finally {
    if (active === 0) activeRequests.delete(input.binding);
    else activeRequests.set(input.binding, active);
  }
}

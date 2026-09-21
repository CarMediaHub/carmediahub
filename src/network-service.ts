export interface NetworkExecutionRequest { binding: string; method: string; path: string; headers?: unknown; body?: unknown; }
export interface NetworkExecutionResponse { status: number; headers: Record<string, string>; bodyBase64?: string; }
export type BindingResolver = (name: string) => { endpoint: string } | undefined;

const methods = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
const headers = new Set(["accept", "accept-language", "content-type", "if-none-match", "range"]);

export async function executeNetworkRequest(input: NetworkExecutionRequest, resolve: BindingResolver): Promise<NetworkExecutionResponse> {
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(input.binding) || !methods.has(input.method) || !input.path.startsWith("/") || input.path.includes("\\") || input.path.split("/").includes("..")) throw new Error("Invalid network request");
  if (input.body !== undefined && (typeof input.body !== "string" || Buffer.byteLength(input.body, "utf8") > 64 * 1024)) throw new Error("Network request body is too large");
  const binding = resolve(input.binding);
  if (binding === undefined) throw new Error("Network target is not bound");
  const base = new URL(binding.endpoint);
  const target = new URL(input.path, base);
  if (target.origin !== base.origin || target.username !== "" || target.password !== "" || target.hash !== "") throw new Error("Network target is invalid");
  const requestHeaders: Record<string, string> = typeof input.headers === "object" && input.headers !== null ? Object.fromEntries(Object.entries(input.headers as Record<string, unknown>).filter(([key, value]) => headers.has(key.toLowerCase()) && typeof value === "string" && value.length <= 2048) as Array<[string, string]>) : {};
  const response = await fetch(target, { method: input.method, headers: requestHeaders, signal: AbortSignal.timeout(30_000), ...(input.body === undefined ? {} : { body: input.body }) });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 1024 * 1024) throw new Error("Network response is too large");
  const responseHeaders = Object.fromEntries(["content-type", "content-length", "content-range", "etag", "last-modified", "accept-ranges"].flatMap((name) => { const value = response.headers.get(name); return value === null ? [] : [[name, value]]; }));
  return { status: response.status, headers: responseHeaders, ...(input.method === "HEAD" ? {} : { bodyBase64: bytes.toString("base64") }) };
}

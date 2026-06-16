// Lattice API client.
//
// Auth model: cookie session (`lattice_session`, sent automatically with
// credentials:"include"). The server returns a `csrf_token` from /api/login
// and /api/me which must be echoed as `X-Lattice-CSRF` on every unsafe method.
// All errors share the shape {error:{code, message, request_id}} with a stable
// machine code; we surface that as a typed ApiError carrying the request id.

export interface ApiErrorBody {
  error?: { code?: string; message?: string; request_id?: string };
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId?: string;

  constructor(status: number, code: string, message: string, requestId?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }

  /** True for auth failures that should bounce the operator to login. */
  get isAuth(): boolean {
    return this.status === 401 || this.code === "unauthorized";
  }

  /** True when the current principal simply lacks scope for this resource. */
  get isForbidden(): boolean {
    return this.status === 403 || this.code === "forbidden" || this.code === "capability_denied";
  }
}

let csrfToken = "";
export function setCsrfToken(token: string | undefined | null): void {
  csrfToken = token || "";
}
export function getCsrfToken(): string {
  return csrfToken;
}

type Method = "GET" | "POST";

export interface RequestOptions {
  signal?: AbortSignal;
}

async function request<T>(
  method: Method,
  path: string,
  body?: unknown,
  opts?: RequestOptions,
): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  let payload: string | undefined;

  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  if (method !== "GET") {
    headers["X-Lattice-CSRF"] = csrfToken;
  }

  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: payload,
      credentials: "include",
      signal: opts?.signal,
    });
  } catch (err) {
    if ((err as Error)?.name === "AbortError") throw err;
    throw new ApiError(0, "network_error", "Cannot reach the control plane. Check your connection.");
  }

  const raw = await res.text();
  let data: unknown = undefined;
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = raw;
    }
  }

  if (!res.ok) {
    const errBody = data as ApiErrorBody;
    const requestId =
      res.headers.get("X-Lattice-Request-ID") || errBody?.error?.request_id || undefined;
    const code = errBody?.error?.code || String(res.status);
    const message =
      errBody?.error?.message ||
      (typeof data === "string" && data ? data : res.statusText || "Request failed");
    throw new ApiError(res.status, code, message, requestId);
  }

  return data as T;
}

function withQuery(path: string, query?: Record<string, unknown>): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === "") continue;
    params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

export const http = {
  get: <T>(path: string, query?: Record<string, unknown>, opts?: RequestOptions) =>
    request<T>("GET", withQuery(path, query), undefined, opts),
  post: <T>(path: string, body?: unknown, opts?: RequestOptions) =>
    request<T>("POST", path, body, opts),
};

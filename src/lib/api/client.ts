// Lattice API client.
//
// Auth model: cookie session (`lattice_session`, sent automatically with
// credentials:"include"). The server returns a `csrf_token` from /api/login
// and /api/me which must be echoed as `X-Lattice-CSRF` on every unsafe method.
// All errors share the shape {error:{code, message, request_id}} with a stable
// machine code; we surface that as a typed ApiError carrying the request id.
// ApiError.message is display-ready for toast-style call sites; serverMessage
// keeps the raw text for views that render request_id separately.

export interface ApiErrorBody {
  error?: { code?: string; message?: string; request_id?: string };
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly serverMessage: string;
  readonly requestId?: string;
  /**
   * The parsed error response, when there was one.
   *
   * Some refusals carry the reason as structured data rather than prose: the
   * SSH Guard pre-check returns the findings that blocked the plan, and those
   * findings are the operator's next move. Keeping only the message threw that
   * away and left the screen with nothing to show but "conflict".
   */
  readonly body?: unknown;

  constructor(status: number, code: string, message: string, requestId?: string, body?: unknown) {
    super(messageWithRequestId(message, requestId));
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.serverMessage = message;
    this.requestId = requestId;
    this.body = body;
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

function messageWithRequestId(message: string, requestId?: string): string {
  const trimmed = message.trim();
  const req = requestId?.trim();
  if (!req) return trimmed;
  if (!trimmed) return `request_id: ${req}`;
  if (trimmed.includes(req)) return trimmed;
  return `${trimmed} (request_id: ${req})`;
}

let csrfToken = "";
export function setCsrfToken(token: string | undefined | null): void {
  csrfToken = token || "";
}
export function getCsrfToken(): string {
  return csrfToken;
}

type Method = "GET" | "POST" | "PATCH" | "DELETE";

export interface RequestOptions {
  signal?: AbortSignal;
}

/* ------------------------------------------------------------------ */
/* Lightweight request timing. Surfaces perceived slowness in the     */
/* browser console without a build flag. Every call logs at `debug`    */
/* (filter via the devtools log-level menu); anything slower than      */
/* SLOW_MS (or a 0/5xx) is promoted to `warn` and kept in a small ring */
/* on `window.__latticePerf` for ad-hoc inspection.                    */
/* ------------------------------------------------------------------ */
const SLOW_MS = 1200;
const PERF_RING = 50;
const GET_CACHE_MS = 750;

interface PerfEntry {
  method: Method;
  path: string;
  status: number;
  ms: number;
  requestId?: string;
}

interface GETCacheEntry {
  expiresAt: number;
  promise: Promise<unknown>;
}

const getCache = new Map<string, GETCacheEntry>();
const getInflight = new Map<string, Promise<unknown>>();

function nowMs(): number {
  return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
}

function logTiming(e: PerfEntry): void {
  const line = `[lattice/api] ${e.method} ${e.path} -> ${e.status} ${e.ms.toFixed(0)}ms${
    e.requestId ? ` (req ${e.requestId})` : ""
  }`;
  if (e.ms >= SLOW_MS || e.status === 0 || e.status >= 500) {
    console.warn(line);
    try {
      const g = globalThis as unknown as { __latticePerf?: PerfEntry[] };
      const ring = (g.__latticePerf ||= []);
      ring.push(e);
      if (ring.length > PERF_RING) ring.splice(0, ring.length - PERF_RING);
    } catch {
      /* locked-down global. Ignore */
    }
  } else {
    console.debug(line);
  }
}

async function performRequest<T>(
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

  const t0 = nowMs();
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
    logTiming({ method, path, status: 0, ms: nowMs() - t0 });
    throw new ApiError(0, "network_error", "Cannot reach the control plane. Check your connection.");
  }

  const raw = await res.text();
  const ms = nowMs() - t0;
  const requestId = res.headers.get("X-Lattice-Request-ID") || undefined;
  let data: unknown = undefined;
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = raw;
    }
  }

  logTiming({ method, path, status: res.status, ms, requestId });

  if (!res.ok) {
    const errBody = data as ApiErrorBody;
    const code = errBody?.error?.code || String(res.status);
    const message =
      errBody?.error?.message ||
      (typeof data === "string" && data ? data : res.statusText || "Request failed");
    throw new ApiError(res.status, code, message, requestId || errBody?.error?.request_id, data);
  }

  return data as T;
}

async function request<T>(
  method: Method,
  path: string,
  body?: unknown,
  opts?: RequestOptions,
): Promise<T> {
  if (method === "GET" && body === undefined && !opts?.signal) {
    const cached = getCache.get(path);
    const now = nowMs();
    if (cached && cached.expiresAt > now) return cached.promise as Promise<T>;
    const inflight = getInflight.get(path);
    if (inflight) return inflight as Promise<T>;
    const promise = performRequest<T>(method, path, body, opts);
    getInflight.set(path, promise);
    try {
      const result = await promise;
      getCache.set(path, { promise: Promise.resolve(result), expiresAt: nowMs() + GET_CACHE_MS });
      return result;
    } catch (error) {
      throw error;
    } finally {
      if (getInflight.get(path) === promise) getInflight.delete(path);
    }
  }

  const result = await performRequest<T>(method, path, body, opts);
  if (method !== "GET") {
    getCache.clear();
    getInflight.clear();
  }
  return result;
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
  // PATCH rather than PUT because the share update endpoint distinguishes "not
  // supplied" from "cleared": it takes pointers, so omitting expires_at leaves
  // the expiry alone while clear_expiry removes it. A PUT would invite callers
  // to send the whole record and silently drop whatever they forgot.
  patch: <T>(path: string, body?: unknown, opts?: RequestOptions) =>
    request<T>("PATCH", path, body, opts),
  // First DELETE the dashboard has needed. It goes through the same `request`
  // as the others, so it inherits the CSRF header that every unsafe method
  // requires. Which is the reason this belongs here rather than as a one-off
  // fetch at the call site.
  del: <T>(path: string, opts?: RequestOptions) => request<T>("DELETE", path, undefined, opts),
};

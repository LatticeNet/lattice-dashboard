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

  constructor(status: number, code: string, message: string, requestId?: string) {
    super(messageWithRequestId(message, requestId));
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.serverMessage = message;
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

type Method = "GET" | "POST";

export interface RequestOptions {
  signal?: AbortSignal;
}

/* ------------------------------------------------------------------ */
/* Lightweight request timing — surfaces perceived slowness in the     */
/* browser console without a build flag. Every call logs at `debug`    */
/* (filter via the devtools log-level menu); anything slower than      */
/* SLOW_MS (or a 0/5xx) is promoted to `warn` and kept in a small ring */
/* on `window.__latticePerf` for ad-hoc inspection.                    */
/* ------------------------------------------------------------------ */
const SLOW_MS = 1200;
const PERF_RING = 50;

interface PerfEntry {
  method: Method;
  path: string;
  status: number;
  ms: number;
  requestId?: string;
}

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
      /* locked-down global — ignore */
    }
  } else {
    console.debug(line);
  }
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
    throw new ApiError(res.status, code, message, requestId || errBody?.error?.request_id);
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

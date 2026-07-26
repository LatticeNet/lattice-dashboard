export interface BridgeInterfaceMethod {
  name: string;
  effect: "read" | "write" | "plan" | string;
  scopes?: string[];
}

export interface BridgeInterfaceContract {
  service: string;
  methods: Array<string | BridgeInterfaceMethod>;
  scopes?: string[];
}

export type BridgeHostMessage =
  | {
      type: "lattice.host.init";
      nonce: string;
      version: string;
      pluginId: string;
      pluginVersion: string;
      pluginRoute: string;
      locale: string;
      colorScheme: string;
      designTokens: Record<string, string>;
      interfaces: Array<{ service: string; methods: string[] }>;
    }
  | { type: "lattice.host.result"; nonce: string; id: string; result: unknown }
  | { type: "lattice.host.error"; nonce: string; id?: string; code: string; message: string }
  | { type: "lattice.host.theme"; nonce: string; colorScheme: string; designTokens: Record<string, string> }
  | { type: "lattice.host.dispose"; nonce: string };

export interface BridgeMessageEvent {
  source: unknown;
  data: unknown;
}

interface PluginBridgeOptions {
  pluginId: string;
  pluginVersion: string;
  pluginRoute: string;
  bridgeVersion: string;
  nonce: string;
  sourceWindow: unknown;
  interfaces: BridgeInterfaceContract[];
  call: (service: string, method: string, payload: unknown, signal: AbortSignal) => Promise<unknown>;
  post: (message: BridgeHostMessage) => void;
  locale: string;
  colorScheme: string;
  designTokens: Record<string, string>;
  resize?: (height: number) => void;
  ready?: () => void;
  maxPayloadBytes?: number;
  maxResultBytes?: number;
  maxInflight?: number;
  maxCallsPerMinute?: number;
  maxResizesPerMinute?: number;
  timeoutMs?: number;
  now?: () => number;
}

interface PendingCall {
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
  terminate: (error: Error) => void;
  cancelled: boolean;
  timedOut: boolean;
}

const encoder = new TextEncoder();

export function resolvePluginFrameURL(
  entryURL: string,
  origin: string,
  pluginId: string,
  assetDigest: string,
  nonce: string,
): string | undefined {
  if (!/^[0-9a-f]{64}$/i.test(assetDigest)) return undefined;
  let url: URL;
  try {
    url = new URL(entryURL, origin);
  } catch {
    return undefined;
  }
  const normalizedDigest = assetDigest.toLowerCase();
  const expectedPrefix = `/api/plugins/assets/${encodeURIComponent(pluginId)}/${normalizedDigest}/ui/`;
  if (
    url.origin !== origin ||
    !url.pathname.startsWith(expectedPrefix) ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    return undefined;
  }
  url.hash = `lattice_nonce=${encodeURIComponent(nonce)}&host_origin=${encodeURIComponent(origin)}`;
  return url.toString();
}

export function bridgeInterfaceFingerprint(interfaces: BridgeInterfaceContract[]): string {
  return JSON.stringify(interfaces.map((contract) => ({
    service: contract.service,
    methods: contract.methods.map((method) => typeof method === "string" ? method : method.name),
  })));
}

export function interfaceMethodScopes(contract: BridgeInterfaceContract | undefined, methodName: string): string[] {
  if (!contract) return [];
  const method = contract.methods.find((candidate) =>
    typeof candidate === "string" ? candidate === methodName : candidate.name === methodName,
  );
  if (method && typeof method !== "string") {
    return method.scopes?.length ? [...method.scopes] : [...(contract.scopes ?? [])];
  }
  return [...(contract.scopes ?? [])];
}

export class PluginBridgeSession {
  private readonly options: Required<Pick<PluginBridgeOptions,
    "maxPayloadBytes" | "maxResultBytes" | "maxInflight" | "maxCallsPerMinute" | "maxResizesPerMinute" | "timeoutMs" | "now"
  >> & PluginBridgeOptions;

  private readonly pending = new Map<string, PendingCall>();
  private callTimes: number[] = [];
  private resizeTimes: number[] = [];
  private disposed = false;

  constructor(options: PluginBridgeOptions) {
    this.options = {
      maxPayloadBytes: 256 * 1024,
      maxResultBytes: 1024 * 1024,
      maxInflight: 8,
      maxCallsPerMinute: 120,
      maxResizesPerMinute: 120,
      timeoutMs: 15_000,
      now: () => Date.now(),
      ...options,
    };
  }

  async handle(event: BridgeMessageEvent): Promise<void> {
    if (this.disposed || event.source !== this.options.sourceWindow || !isRecord(event.data)) return;
    const message = event.data;
    if (message.nonce !== this.options.nonce || typeof message.type !== "string") return;

    switch (message.type) {
      case "lattice.plugin.ready":
        this.options.post({
          type: "lattice.host.init",
          nonce: this.options.nonce,
          version: this.options.bridgeVersion,
          pluginId: this.options.pluginId,
          pluginVersion: this.options.pluginVersion,
          pluginRoute: this.options.pluginRoute,
          locale: this.options.locale,
          colorScheme: this.options.colorScheme,
          designTokens: { ...this.options.designTokens },
          interfaces: this.options.interfaces.map((contract) => ({
            service: contract.service,
            methods: contract.methods.map((method) => typeof method === "string" ? method : method.name),
          })),
        });
        this.options.ready?.();
        return;
      case "lattice.plugin.call":
        await this.handleCall(message);
        return;
      case "lattice.plugin.cancel":
        this.cancel(message.id);
        return;
      case "lattice.plugin.resize":
        if (!this.consumeResizeBudget()) return;
        if (typeof message.height === "number" && Number.isFinite(message.height)) {
          this.options.resize?.(Math.max(320, Math.min(2400, Math.round(message.height))));
        }
        return;
      default:
        return;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.options.post({ type: "lattice.host.dispose", nonce: this.options.nonce });
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.cancelled = true;
      pending.controller.abort();
      pending.terminate(new Error("disposed"));
    }
    this.pending.clear();
  }

  updateTheme(colorScheme: string, designTokens: Record<string, string>): void {
    if (this.disposed) return;
    this.options.post({
      type: "lattice.host.theme",
      nonce: this.options.nonce,
      colorScheme,
      designTokens: { ...designTokens },
    });
  }

  private async handleCall(message: Record<string, unknown>): Promise<void> {
    // Budget is charged by every call-shaped message, not just the well-formed ones:
    // charging only valid calls would let a frame spam rejects — each of which still
    // costs a host `error` post — without ever reaching the ceiling. The specific
    // rejection still wins the response, so error semantics are unchanged.
    const withinBudget = this.consumeRateBudget();
    const id = typeof message.id === "string" ? message.id : "";
    const service = typeof message.service === "string" ? message.service : "";
    const method = typeof message.method === "string" ? message.method : "";
    if (!id || id.length > 128 || !service || !method) {
      this.error(id, "invalid_request", "id, service and method are required");
      return;
    }
    if (!this.methodDeclared(service, method)) {
      this.error(id, "method_not_declared", "service or method is not declared for this plugin");
      return;
    }
    if (this.pending.has(id)) {
      this.error(id, "duplicate_request", "request id is already in flight");
      return;
    }
    if (this.pending.size >= this.options.maxInflight) {
      this.error(id, "too_many_requests", "too many plugin requests are in flight");
      return;
    }
    const payloadSize = jsonSize(message.payload ?? null);
    if (payloadSize === undefined) {
      this.error(id, "invalid_payload", "payload is not serializable");
      return;
    }
    if (payloadSize > this.options.maxPayloadBytes) {
      this.error(id, "payload_too_large", "plugin request payload exceeds the bridge limit");
      return;
    }
    if (!withinBudget) {
      this.error(id, "rate_limited", "plugin request rate exceeds the bridge limit");
      return;
    }

    const controller = new AbortController();
    let terminate = (_error: Error) => {};
    const terminal = new Promise<never>((_resolve, reject) => {
      terminate = reject;
    });
    const pending: PendingCall = {
      controller,
      terminate,
      cancelled: false,
      timedOut: false,
      timer: setTimeout(() => {
        pending.timedOut = true;
        if (this.pending.get(id) === pending) this.pending.delete(id);
        controller.abort();
        this.error(id, "timeout", "plugin request timed out");
        pending.terminate(new Error("timed out"));
      }, this.options.timeoutMs),
    };
    this.pending.set(id, pending);
    try {
      const result = await Promise.race([
        this.options.call(service, method, message.payload ?? null, controller.signal),
        terminal,
      ]);
      if (this.disposed || pending.cancelled || pending.timedOut) return;
      const resultSize = jsonSize(result ?? null);
      if (resultSize === undefined) {
        this.error(id, "invalid_result", "plugin result is not serializable");
      } else if (resultSize > this.options.maxResultBytes) {
        this.error(id, "result_too_large", "plugin result exceeds the bridge limit");
      } else {
        this.options.post({ type: "lattice.host.result", nonce: this.options.nonce, id, result: result ?? null });
      }
    } catch (error) {
      if (this.disposed) return;
      if (!pending.timedOut && !pending.cancelled && !isAbortError(error)) {
        this.error(id, "call_failed", error instanceof Error ? error.message : "plugin request failed");
      }
    } finally {
      clearTimeout(pending.timer);
      if (this.pending.get(id) === pending) this.pending.delete(id);
    }
  }

  private methodDeclared(service: string, method: string): boolean {
    const contract = this.options.interfaces.find((candidate) => candidate.service === service);
    return contract?.methods.some((candidate) =>
      typeof candidate === "string" ? candidate === method : candidate?.name === method,
    ) === true;
  }

  private consumeRateBudget(): boolean {
    const now = this.options.now();
    this.callTimes = this.callTimes.filter((time) => now - time < 60_000);
    if (this.callTimes.length >= this.options.maxCallsPerMinute) return false;
    this.callTimes.push(now);
    return true;
  }

  // Height is already magnitude-clamped, but an unbounded resize stream can still
  // thrash layout. Silently drop past the ceiling: resize is advisory, and a frame
  // that floods it gets no error post to amplify against.
  private consumeResizeBudget(): boolean {
    const now = this.options.now();
    this.resizeTimes = this.resizeTimes.filter((time) => now - time < 60_000);
    if (this.resizeTimes.length >= this.options.maxResizesPerMinute) return false;
    this.resizeTimes.push(now);
    return true;
  }

  private cancel(value: unknown): void {
    if (typeof value !== "string") return;
    const pending = this.pending.get(value);
    if (!pending) return;
    pending.cancelled = true;
    clearTimeout(pending.timer);
    this.pending.delete(value);
    pending.controller.abort();
    this.error(value, "cancelled", "plugin request was cancelled");
    pending.terminate(new Error("cancelled"));
  }

  private error(id: string, code: string, message: string): void {
    this.options.post({ type: "lattice.host.error", nonce: this.options.nonce, ...(id ? { id } : {}), code, message });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonSize(value: unknown): number | undefined {
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? undefined : encoder.encode(encoded).byteLength;
  } catch {
    return undefined;
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

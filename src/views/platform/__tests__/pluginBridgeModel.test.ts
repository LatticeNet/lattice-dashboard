import assert from "node:assert/strict";
import test from "node:test";

import {
  PluginBridgeSession,
  bridgeInterfaceFingerprint,
  interfaceMethodScopes,
  resolvePluginFrameURL,
  type BridgeHostMessage,
} from "../pluginBridgeModel.ts";

function makeSession(overrides: Partial<ConstructorParameters<typeof PluginBridgeSession>[0]> = {}) {
  const source = {};
  const posted: BridgeHostMessage[] = [];
  const calls: Array<{ service: string; method: string; payload: unknown; signal: AbortSignal }> = [];
  const session = new PluginBridgeSession({
    pluginId: "test.plugin",
    pluginVersion: "0.1.0-alpha.1",
    pluginRoute: "items",
    bridgeVersion: "1",
    nonce: "nonce-123",
    sourceWindow: source,
    interfaces: [{
      service: "test.plugin/items",
      methods: [
        { name: "list", effect: "read", scopes: ["proxy:read"] },
        { name: "save", effect: "write", scopes: ["proxy:admin"] },
      ],
    }],
    call: async (service, method, payload, signal) => {
      calls.push({ service, method, payload, signal });
      return { ok: true };
    },
    post: (message) => posted.push(message),
    locale: "en-US",
    colorScheme: "dark",
    designTokens: { "--background": "#000" },
    ...overrides,
  });
  return { session, source, posted, calls };
}

test("frame URL stays on the exact server-derived plugin digest path", () => {
  const digest = "a".repeat(64);
  assert.equal(
    resolvePluginFrameURL(
      `/api/plugins/assets/test.plugin/${digest}/ui/index.html`,
      "https://lattice.example",
      "test.plugin",
      digest,
      "nonce-123",
    ),
    `https://lattice.example/api/plugins/assets/test.plugin/${digest}/ui/index.html#lattice_nonce=nonce-123`,
  );
  assert.equal(resolvePluginFrameURL("https://evil.example/ui", "https://lattice.example", "test.plugin", digest, "n"), undefined);
  assert.equal(resolvePluginFrameURL(`/api/plugins/assets/other/${digest}/ui/index.html`, "https://lattice.example", "test.plugin", digest, "n"), undefined);
  assert.equal(resolvePluginFrameURL(`/api/plugins/assets/test.plugin/${"b".repeat(64)}/ui/index.html`, "https://lattice.example", "test.plugin", digest, "n"), undefined);
  assert.equal(resolvePluginFrameURL("http://[", "https://lattice.example", "test.plugin", digest, "n"), undefined);
  assert.equal(resolvePluginFrameURL(`/api/plugins/assets/test.plugin/${digest}/bin/plugin`, "https://lattice.example", "test.plugin", digest, "n"), undefined);
  assert.equal(resolvePluginFrameURL(`/api/plugins/assets/test.plugin/${digest}/ui/index.html?next=x`, "https://lattice.example", "test.plugin", digest, "n"), undefined);
  assert.equal(resolvePluginFrameURL(`/api/plugins/assets/test.plugin/${digest}/ui/index.html#old`, "https://lattice.example", "test.plugin", digest, "n"), undefined);
});

test("bridge keeps legacy v1 string method contracts callable", async () => {
  const { session, source, posted, calls } = makeSession({
    interfaces: [{ service: "test.plugin/legacy", methods: ["list"] }],
  });
  await session.handle({ source, data: {
    type: "lattice.plugin.call", nonce: "nonce-123", id: "legacy",
    service: "test.plugin/legacy", method: "list", payload: {},
  } });
  assert.equal(calls.length, 1);
  assert.equal(posted.at(-1)?.type, "lattice.host.result");
});

test("typed methods use exact scopes while legacy methods inherit service scopes", () => {
  const typed = {
    service: "test.plugin/items",
    scopes: ["proxy:read"],
    methods: [
      { name: "list", effect: "read", scopes: ["proxy:read"] },
      { name: "save", effect: "write", scopes: ["proxy:admin"] },
    ],
  };
  assert.deepEqual(interfaceMethodScopes(typed, "list"), ["proxy:read"]);
  assert.deepEqual(interfaceMethodScopes(typed, "save"), ["proxy:admin"]);
  assert.deepEqual(interfaceMethodScopes({ service: "legacy/items", methods: ["list"], scopes: ["proxy:read"] }, "list"), ["proxy:read"]);
});

test("bridge interface fingerprint changes when RBAC-filtered methods change", () => {
  const readOnly = [{ service: "test.plugin/items", methods: [{ name: "list", effect: "read" }] }];
  const admin = [{ service: "test.plugin/items", methods: [{ name: "list", effect: "read" }, { name: "save", effect: "write" }] }];
  assert.notEqual(bridgeInterfaceFingerprint(readOnly), bridgeInterfaceFingerprint(admin));
  assert.equal(bridgeInterfaceFingerprint(readOnly), bridgeInterfaceFingerprint(structuredClone(readOnly)));
});

test("bridge ignores wrong windows and nonces, then sends a minimal init envelope", async () => {
  let ready = 0;
  const { session, source, posted } = makeSession({ ready: () => { ready += 1; } });
  await session.handle({ source: {}, data: { type: "lattice.plugin.ready", nonce: "nonce-123" } });
  await session.handle({ source, data: { type: "lattice.plugin.ready", nonce: "wrong" } });
  assert.equal(posted.length, 0);

  await session.handle({ source, data: { type: "lattice.plugin.ready", nonce: "nonce-123" } });
  assert.equal(posted.length, 1);
  assert.equal(posted[0]?.type, "lattice.host.init");
  assert.deepEqual(Object.keys(posted[0] ?? {}).sort(), ["colorScheme", "designTokens", "interfaces", "locale", "nonce", "pluginId", "pluginRoute", "pluginVersion", "type", "version"].sort());
  assert.deepEqual((posted[0] as { interfaces?: unknown }).interfaces, [{
    service: "test.plugin/items",
    methods: ["list", "save"],
  }]);
  assert.equal(ready, 1);
});

test("bridge calls only manifest-declared services and methods", async () => {
  const { session, source, posted, calls } = makeSession();
  await session.handle({ source, data: {
    type: "lattice.plugin.call", nonce: "nonce-123", id: "r1",
    service: "test.plugin/items", method: "list", payload: { page: 1 },
  } });
  assert.equal(calls.length, 1);
  assert.equal(posted.at(-1)?.type, "lattice.host.result");

  await session.handle({ source, data: {
    type: "lattice.plugin.call", nonce: "nonce-123", id: "r2",
    service: "test.plugin/items", method: "delete", payload: {},
  } });
  assert.equal(calls.length, 1);
  assert.equal(posted.at(-1)?.type, "lattice.host.error");
  assert.equal((posted.at(-1) as { code?: string }).code, "method_not_declared");
});

test("bridge rejects duplicate ids and oversized request/result bodies", async () => {
  let release: ((value: unknown) => void) | undefined;
  const pending = new Promise((resolve) => { release = resolve; });
  const { session, source, posted } = makeSession({ call: async () => pending });
  const first = session.handle({ source, data: {
    type: "lattice.plugin.call", nonce: "nonce-123", id: "same",
    service: "test.plugin/items", method: "list", payload: {},
  } });
  await session.handle({ source, data: {
    type: "lattice.plugin.call", nonce: "nonce-123", id: "same",
    service: "test.plugin/items", method: "list", payload: {},
  } });
  assert.equal((posted.at(-1) as { code?: string }).code, "duplicate_request");
  release?.({ ok: true });
  await first;

  const huge = "x".repeat(300_000);
  await session.handle({ source, data: {
    type: "lattice.plugin.call", nonce: "nonce-123", id: "huge",
    service: "test.plugin/items", method: "list", payload: huge,
  } });
  assert.equal((posted.at(-1) as { code?: string }).code, "payload_too_large");

  const resultSession = makeSession({ call: async () => "x".repeat(1_100_000) });
  await resultSession.session.handle({ source: resultSession.source, data: {
    type: "lattice.plugin.call", nonce: "nonce-123", id: "large-result",
    service: "test.plugin/items", method: "list", payload: {},
  } });
  assert.equal((resultSession.posted.at(-1) as { code?: string }).code, "result_too_large");
});

test("bridge caps inflight/rate, supports cancellation, and disposes all work", async () => {
  const pending = new Map<string, AbortSignal>();
  const { session, source, posted } = makeSession({
    maxInflight: 2,
    maxCallsPerMinute: 2,
    call: async (_service, _method, payload, signal) => {
      pending.set((payload as { id: string }).id, signal);
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    },
  });
  const invoke = (id: string) => session.handle({ source, data: {
    type: "lattice.plugin.call", nonce: "nonce-123", id,
    service: "test.plugin/items", method: "list", payload: { id },
  } });
  const first = invoke("one");
  const second = invoke("two");
  await invoke("three");
  assert.equal((posted.at(-1) as { code?: string }).code, "too_many_requests");

  await session.handle({ source, data: { type: "lattice.plugin.cancel", nonce: "nonce-123", id: "one" } });
  assert.equal(pending.get("one")?.aborted, true);
  await first;

  await invoke("rate");
  assert.equal((posted.at(-1) as { code?: string }).code, "rate_limited");
  session.dispose();
  assert.equal(pending.get("two")?.aborted, true);
  assert.equal(posted.at(-1)?.type, "lattice.host.dispose");
  await second;
});

test("cancellation releases one slot exactly once even when the call ignores abort", async () => {
  const never = new Promise<unknown>(() => {});
  const { session, source, posted, calls } = makeSession({
    maxInflight: 1,
    call: async (service, method, payload, signal) => {
      calls.push({ service, method, payload, signal });
      if ((payload as { id: string }).id === "stuck") return never;
      return { ok: true };
    },
  });
  const first = session.handle({ source, data: {
    type: "lattice.plugin.call", nonce: "nonce-123", id: "stuck",
    service: "test.plugin/items", method: "list", payload: { id: "stuck" },
  } });
  await session.handle({ source, data: {
    type: "lattice.plugin.cancel", nonce: "nonce-123", id: "stuck",
  } });
  await first;
  await session.handle({ source, data: {
    type: "lattice.plugin.call", nonce: "nonce-123", id: "next",
    service: "test.plugin/items", method: "list", payload: { id: "next" },
  } });
  assert.equal(calls.length, 2);
  assert.equal(posted.filter((message) => message.type === "lattice.host.error" && message.id === "stuck").length, 1);
  assert.equal(posted.at(-1)?.type, "lattice.host.result");
});

test("bridge times out calls even when they ignore abort", async () => {
  const { session, source, posted } = makeSession({
    timeoutMs: 5,
    call: async () => new Promise(() => {}),
  });
  await session.handle({ source, data: {
    type: "lattice.plugin.call", nonce: "nonce-123", id: "slow",
    service: "test.plugin/items", method: "list", payload: {},
  } });
  assert.equal((posted.at(-1) as { code?: string }).code, "timeout");
});

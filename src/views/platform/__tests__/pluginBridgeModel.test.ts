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
    `https://lattice.example/api/plugins/assets/test.plugin/${digest}/ui/index.html#lattice_nonce=nonce-123&host_origin=${encodeURIComponent("https://lattice.example")}`,
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

// Regression: the rate budget used to be consumed only by well-formed calls, so a frame
// could spam undeclared/duplicate/oversized calls. Each still costing a host error post
// without ever reaching the ceiling.
test("rejected calls still consume the rate budget", async () => {
  const { session, source, posted } = makeSession({ maxCallsPerMinute: 3 });

  for (let i = 0; i < 3; i += 1) {
    await session.handle({
      source,
      data: { type: "lattice.plugin.call", nonce: "nonce-123", id: `bad-${i}`, service: "test.plugin/items", method: "nope" },
    });
  }
  assert.deepEqual(posted.map((m) => m.code), ["method_not_declared", "method_not_declared", "method_not_declared"]);

  // Budget is now spent. Even a perfectly valid call must be refused.
  await session.handle({
    source,
    data: { type: "lattice.plugin.call", nonce: "nonce-123", id: "good", service: "test.plugin/items", method: "list" },
  });
  assert.equal(posted.at(-1)?.code, "rate_limited");
});

test("resize is rate limited so a frame cannot thrash layout", async () => {
  const heights: number[] = [];
  const { session, source } = makeSession({
    maxResizesPerMinute: 2,
    resize: (height) => heights.push(height),
  });

  for (let i = 0; i < 5; i += 1) {
    await session.handle({
      source,
      data: { type: "lattice.plugin.resize", nonce: "nonce-123", height: 500 + i },
    });
  }

  assert.deepEqual(heights, [500, 501], "resizes past the ceiling are dropped");
});

// ── clipboard (the host copies on the frame's behalf) ───────────────────────
//
// The frame is sandboxed into an opaque origin and Permissions Policy denies it
// the async Clipboard API, which is the bug these tests exist for: a Sub-Store
// share link could not be copied at all. The host holds the permission and does
// the copy, so what has to hold is that the host stays in charge of it and that
// the frame always learns the outcome. The plugin's manual-copy fallback is only
// reachable from a "no", so a dropped answer is a silently broken feature.

test("a clipboard request reaches the host handler and is acknowledged", async () => {
  const copied: string[] = [];
  const { session, source, posted } = makeSession({
    clipboard: async (text) => { copied.push(text); return true; },
  });

  await session.handle({
    source,
    data: { type: "lattice.plugin.clipboard", nonce: "nonce-123", id: "c1", text: "https://example.test/sub" },
  });

  assert.deepEqual(copied, ["https://example.test/sub"]);
  assert.deepEqual(posted.at(-1), {
    type: "lattice.host.clipboard", nonce: "nonce-123", id: "c1", ok: true,
  });
});

test("a host that grants no clipboard still answers, so the plugin can fall back", async () => {
  const { session, source, posted } = makeSession();

  await session.handle({
    source,
    data: { type: "lattice.plugin.clipboard", nonce: "nonce-123", id: "c1", text: "value" },
  });

  assert.deepEqual(posted.at(-1), {
    type: "lattice.host.clipboard", nonce: "nonce-123", id: "c1", ok: false, code: "clipboard_refused",
  });
});

test("a copy the browser refuses is reported as a refusal, not a success", async () => {
  const { session, source, posted } = makeSession({ clipboard: async () => false });

  await session.handle({
    source,
    data: { type: "lattice.plugin.clipboard", nonce: "nonce-123", id: "c1", text: "value" },
  });

  assert.equal(posted.at(-1)?.ok, false);
  assert.equal(posted.at(-1)?.code, "clipboard_refused");
});

test("a clipboard handler that throws is a refusal, not an unhandled rejection", async () => {
  const { session, source, posted } = makeSession({
    clipboard: async () => { throw new Error("boom"); },
  });

  await session.handle({
    source,
    data: { type: "lattice.plugin.clipboard", nonce: "nonce-123", id: "c1", text: "value" },
  });

  assert.equal(posted.at(-1)?.ok, false);
  assert.equal(posted.at(-1)?.code, "clipboard_refused");
});

test("clipboard text is bounded, and the frame is told which limit it hit", async () => {
  const calls: string[] = [];
  const { session, source, posted } = makeSession({
    maxClipboardBytes: 16,
    clipboard: async (text) => { calls.push(text); return true; },
  });

  await session.handle({
    source,
    data: { type: "lattice.plugin.clipboard", nonce: "nonce-123", id: "c1", text: "x".repeat(17) },
  });

  assert.deepEqual(calls, [], "an oversized copy never reaches the host clipboard");
  assert.equal(posted.at(-1)?.code, "text_too_large");
});

test("clipboard size is measured in bytes, not code units", async () => {
  const calls: string[] = [];
  const { session, source, posted } = makeSession({
    maxClipboardBytes: 8,
    clipboard: async (text) => { calls.push(text); return true; },
  });

  // Nine bytes of UTF-8, three characters. A length check would have let it through.
  await session.handle({
    source,
    data: { type: "lattice.plugin.clipboard", nonce: "nonce-123", id: "c1", text: "字字字" },
  });

  assert.deepEqual(calls, []);
  assert.equal(posted.at(-1)?.code, "text_too_large");
});

test("a malformed clipboard request is refused without touching the clipboard", async () => {
  const calls: string[] = [];
  const { session, source, posted } = makeSession({
    clipboard: async (text) => { calls.push(text); return true; },
  });

  // No text.
  await session.handle({
    source,
    data: { type: "lattice.plugin.clipboard", nonce: "nonce-123", id: "c1" },
  });
  assert.equal(posted.at(-1)?.code, "invalid_request");

  // Text that is not a string. A frame must not be able to hand the host an object.
  await session.handle({
    source,
    data: { type: "lattice.plugin.clipboard", nonce: "nonce-123", id: "c2", text: { toString: () => "x" } },
  });
  assert.equal(posted.at(-1)?.code, "invalid_request");

  assert.deepEqual(calls, []);
});

test("a clipboard request with no id is dropped silently, having nobody to answer", async () => {
  const { session, source, posted } = makeSession({ clipboard: async () => true });

  await session.handle({
    source,
    data: { type: "lattice.plugin.clipboard", nonce: "nonce-123", text: "value" },
  });

  assert.deepEqual(posted, []);
});

test("clipboard requests are rate limited, and the refusal is still answered", async () => {
  const copied: string[] = [];
  const { session, source, posted } = makeSession({
    maxClipboardPerMinute: 2,
    clipboard: async (text) => { copied.push(text); return true; },
  });

  for (let i = 0; i < 4; i += 1) {
    await session.handle({
      source,
      data: { type: "lattice.plugin.clipboard", nonce: "nonce-123", id: `c${i}`, text: `v${i}` },
    });
  }

  assert.deepEqual(copied, ["v0", "v1"], "copies past the ceiling never reach the clipboard");
  // Unlike resize, the frame is told: it needs the "no" to offer a manual copy.
  assert.equal(posted.at(-1)?.code, "rate_limited");
  assert.equal(posted.length, 4, "every request got exactly one answer");
});

test("a clipboard request from another window or another nonce is ignored", async () => {
  const copied: string[] = [];
  const { session, posted } = makeSession({
    clipboard: async (text) => { copied.push(text); return true; },
  });

  await session.handle({
    source: {},
    data: { type: "lattice.plugin.clipboard", nonce: "nonce-123", id: "c1", text: "value" },
  });
  await session.handle({
    source: {},
    data: { type: "lattice.plugin.clipboard", nonce: "wrong", id: "c2", text: "value" },
  });

  assert.deepEqual(copied, []);
  assert.deepEqual(posted, []);
});

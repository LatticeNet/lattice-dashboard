import assert from "node:assert/strict";
import test from "node:test";

import {
  PAGE_STATE_MAX_KEYS,
  PAGE_STATE_RESERVED_KEYS,
  PluginBridgeSession,
  bridgeInterfaceFingerprint,
  heldPluginStateStillApplies,
  interfaceMethodScopes,
  planPluginStateWrite,
  pluginPageStateFromQuery,
  pluginStateLocation,
  resolvePluginFrameURL,
  validatePluginPageState,
  type BridgeHostMessage,
  type PluginPageState,
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
  assert.deepEqual(Object.keys(posted[0] ?? {}).sort(), ["colorScheme", "designTokens", "interfaces", "locale", "nonce", "pageState", "pluginId", "pluginRoute", "pluginVersion", "type", "version"].sort());
  // No page state in the address is an empty object, never an absent field.
  assert.deepEqual((posted[0] as { pageState?: unknown }).pageState, {});
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

// ── page state in the console address ───────────────────────────────────────
//
// The plugin frame URL carries no query (resolvePluginFrameURL refuses one), so
// a plugin page's own state lives in the console route's query and the bridge
// moves it both ways. The rules are identical on the host and plugin sides.

function range(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `k${i}`);
}

test("a valid page state passes whole, and any broken rule drops the whole message", () => {
  assert.deepEqual(validatePluginPageState({ view: "files", published: "no" }), { view: "files", published: "no" });
  assert.deepEqual(validatePluginPageState({}), {}, "an empty state is valid: it clears the query");
  assert.deepEqual(validatePluginPageState({ a: "x".repeat(256) }), { a: "x".repeat(256) });
  assert.deepEqual(validatePluginPageState({ a23456789012345678901234: "v" }), { a23456789012345678901234: "v" }, "24 characters is the longest key");
  assert.equal(Object.keys(validatePluginPageState(Object.fromEntries(range(PAGE_STATE_MAX_KEYS).map((k) => [k, "v"]))) ?? {}).length, 16);

  const rejected: unknown[] = [
    Object.fromEntries(range(PAGE_STATE_MAX_KEYS + 1).map((k) => [k, "v"])),
    { view: "ok", View: "caps" },
    { "1view": "digit first" },
    { "a-b": "dash" },
    { "a.b": "dot" },
    { _x: "underscore first" },
    { a234567890123456789012345: "25 characters" },
    { "": "empty key" },
    { view: 1 },
    { view: null },
    { view: ["a"] },
    { view: { nested: "no" } },
    { view: "x".repeat(257) },
    null,
    "view=files",
    ["view"],
    42,
  ];
  for (const state of rejected) assert.equal(validatePluginPageState(state), null, JSON.stringify(state));
});

test("init hands the plugin the route query, filtered entry by entry", () => {
  const query = {
    view: "lines",
    open: "line_aa1d5f",
    group: "node",
    "conn.sort": "started_at",
    View: "caps",
    repeated: ["a", "b"],
    long: "x".repeat(257),
    empty: "",
  };
  assert.deepEqual(pluginPageStateFromQuery(query), { view: "lines", open: "line_aa1d5f", group: "node", empty: "" });
  const many = Object.fromEntries(range(20).map((k) => [k, "v"]));
  assert.deepEqual(Object.keys(pluginPageStateFromQuery(many)), range(16), "at most 16 are kept, in query order");
});

test("init carries the page state read when the plugin says ready", async () => {
  let query: Record<string, unknown> = { view: "old" };
  const { session, source, posted } = makeSession({ pageState: () => query });
  query = { view: "lines", open: "line_aa1d5f", bad_: ["x"] };
  await session.handle({ source, data: { type: "lattice.plugin.ready", nonce: "nonce-123" } });
  assert.deepEqual((posted[0] as { pageState?: PluginPageState }).pageState, { view: "lines", open: "line_aa1d5f" });
});

test("page state reaches the host only after the handshake, and nothing is posted back", async () => {
  const states: PluginPageState[] = [];
  const { session, source, posted } = makeSession({ state: (state) => states.push(state) });
  const state = (value: unknown) => session.handle({ source, data: { type: "lattice.plugin.state", nonce: "nonce-123", state: value } });

  // A plugin that speaks before init has not seen the address; its defaults
  // must not overwrite a pasted link.
  await state({ view: "defaults" });
  assert.deepEqual(states, []);

  await session.handle({ source, data: { type: "lattice.plugin.ready", nonce: "nonce-123" } });
  await state({ view: "files", published: "no" });
  await state({ view: "files", Bad: "x" });
  await state({});
  await session.handle({ source: {}, data: { type: "lattice.plugin.state", nonce: "nonce-123", state: { view: "other window" } } });
  await session.handle({ source, data: { type: "lattice.plugin.state", nonce: "wrong", state: { view: "wrong nonce" } } });

  assert.deepEqual(states, [{ view: "files", published: "no" }, {}]);
  assert.equal(posted.length, 1, "a state write sends nothing to the frame, and init is not repeated");
  assert.equal(posted[0]?.type, "lattice.host.init");
});

test("page state is limited to 60 a minute, invalid ones included, and the window rolls", async () => {
  let now = 1_000_000;
  const states: PluginPageState[] = [];
  const { session, source } = makeSession({ now: () => now, state: (state) => states.push(state) });
  await session.handle({ source, data: { type: "lattice.plugin.ready", nonce: "nonce-123" } });
  const send = (value: unknown) => session.handle({ source, data: { type: "lattice.plugin.state", nonce: "nonce-123", state: value } });

  for (let i = 0; i < 10; i += 1) await send({ Bad: "x" });
  for (let i = 0; i < 60; i += 1) await send({ step: String(i) });
  assert.equal(states.length, 50, "malformed states spend the budget too");

  now += 60_000;
  await send({ step: "after" });
  assert.deepEqual(states.at(-1), { step: "after" });
});

test("a state write keeps the path and hash, replaces the whole query, and skips a no-op", () => {
  const current = { path: "/plugins/latticenet.vpn-core/lines", query: { view: "lines", open: "a" }, hash: "#top" };
  assert.deepEqual(pluginStateLocation(current, { view: "topology" }), {
    path: "/plugins/latticenet.vpn-core/lines",
    query: { view: "topology" },
    hash: "#top",
  });
  assert.equal(pluginStateLocation(current, { open: "a", view: "lines" }), null, "key order does not matter");
  assert.deepEqual(pluginStateLocation(current, {}), { path: current.path, query: {}, hash: "#top" }, "an empty state clears the query");
  assert.deepEqual(
    pluginStateLocation({ path: "/p", query: { view: ["a", "b"] } }, { view: "a" }),
    { path: "/p", query: { view: "a" }, hash: "" },
    "a repeated key is not the same as one value",
  );
});

test("reserved console keys never cross the bridge, in either direction", () => {
  assert.deepEqual(
    [...PAGE_STATE_RESERVED_KEYS],
    ["redirect", "next", "code", "state", "token", "sso_error", "totp_challenge", "mfa"],
  );
  // Plugin to host: a state naming one is dropped whole, like any broken rule.
  for (const key of PAGE_STATE_RESERVED_KEYS) {
    assert.equal(validatePluginPageState({ view: "lines", [key]: "x" }), null, key);
  }
  // Host to plugin: left out one by one, and they do not use up the 16.
  const query: Record<string, unknown> = Object.fromEntries(PAGE_STATE_RESERVED_KEYS.map((key) => [key, "secret"]));
  for (const key of range(16)) query[key] = "v";
  query.view = "lines";
  const state = pluginPageStateFromQuery(query);
  for (const key of PAGE_STATE_RESERVED_KEYS) assert.equal(key in state, false, key);
  assert.deepEqual(Object.keys(state), range(16));
  assert.deepEqual(pluginPageStateFromQuery({ code: "oauth-code", token: "t", view: "lines" }), { view: "lines" });
});

test("only a plain object is a page state: a cloned Map, Set or Date is refused, not read as empty", () => {
  // What structured clone delivers from the frame, prototypes and all.
  for (const value of [new Map([["view", "lines"]]), new Set(["view"]), new Date(0)]) {
    assert.equal(validatePluginPageState(structuredClone(value)), null, Object.prototype.toString.call(value));
  }
  assert.equal(validatePluginPageState(new Map()), null, "an empty Map would otherwise clear the query");
  // A class instance does not survive the clone as one, but the rule holds.
  assert.equal(validatePluginPageState(new (class State { view = "lines"; })()), null);
  assert.deepEqual(validatePluginPageState(structuredClone({ view: "lines" })), { view: "lines" });
  const bare = Object.assign(Object.create(null) as Record<string, unknown>, { view: "lines" });
  assert.deepEqual(validatePluginPageState(bare), { view: "lines" }, "a null-prototype object is plain");
});

test("an oversized state is refused at the 17th key, without reading the rest", () => {
  let reads = 0;
  const huge: Record<string, unknown> = {};
  for (let i = 0; i < 5_000; i += 1) {
    Object.defineProperty(huge, `k${i}`, { enumerable: true, get: () => { reads += 1; return "v"; } });
  }
  assert.equal(validatePluginPageState(huge), null);
  assert.equal(reads, PAGE_STATE_MAX_KEYS, "sixteen values read, then the count stops it");
});

test("a state write is held while a navigation is pending, and applies only on its own plugin page", () => {
  const framePath = "/plugins/latticenet.vpn-core/lines";
  const current = { name: "plugin-view", path: framePath, query: { view: "lines" }, hash: "" };
  const plan = (over: Partial<Parameters<typeof planPluginStateWrite>[0]>) =>
    planPluginStateWrite({ current, framePath, navigationPending: false, state: { view: "users" }, ...over });

  assert.deepEqual(plan({}), { kind: "replace", location: { path: framePath, query: { view: "users" }, hash: "" } });
  // The route still reads as this page while the operator's click is in flight.
  assert.deepEqual(plan({ navigationPending: true }), { kind: "hold" });
  assert.deepEqual(plan({ current: { ...current, name: "overview" } }), { kind: "skip" }, "not the plugin route");
  assert.deepEqual(plan({ current: { ...current, path: "/plugins/latticenet.vpn-core/users" } }), { kind: "skip" }, "another plugin page");
  assert.deepEqual(plan({ state: { view: "lines" } }), { kind: "skip" }, "nothing to change");
});

test("a held state is dropped when the operator changed the query while it waited", () => {
  const queryWhenHeld = { view: "lines" };
  const applies = (currentQuery: Record<string, unknown>, ownWrite: PluginPageState | null = null) =>
    heldPluginStateStillApplies({ currentQuery, queryWhenHeld, ownWrite });

  assert.equal(applies({ view: "lines" }), true, "the navigation was aborted or went elsewhere");
  assert.equal(applies({ view: "users" }), false, "the operator's change on this page wins");
  assert.equal(applies({ view: "users" }, { view: "users" }), true, "the pending navigation was the plugin's own write");
  assert.equal(applies({ view: "users" }, { view: "lines", open: "a" }), false, "an older write of its own does not count");
  assert.equal(applies({}), false, "a cleared query is a change");
  assert.equal(applies({ view: ["lines", "users"] }), false, "a repeated key is not the single value");
  assert.equal(
    heldPluginStateStillApplies({ currentQuery: { b: "2", a: "1" }, queryWhenHeld: { a: "1", b: "2" }, ownWrite: null }),
    true,
    "key order does not matter",
  );
});

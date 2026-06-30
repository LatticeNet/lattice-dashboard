<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useDocumentVisibility } from "@vueuse/core";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useI18n } from "vue-i18n";
import { api, type TerminalSession } from "@/lib/api";

const POLL_MS = 120;
const POLL_ERROR_MS = 1000; // back off after a failed poll so a bad link isn't hammered
const INPUT_FLUSH_MS = 20;
const RESIZE_DEBOUNCE_MS = 160;
const WS_BACKOFF_START_MS = 500;
const WS_BACKOFF_MAX_MS = 8000;
const WS_CLOSE_NORMAL = 1000;
const WS_CLOSE_TRY_AGAIN = 1013; // server: agent never dialed (node offline)
// Auto-reconnect is for brief blips only: a few quick tries recover a transient
// drop (the server keeps the session alive within its detach window), then we
// stop and surface a manual "Reconnect" instead of retrying forever.
const MAX_RECONNECT_ATTEMPTS = 4;

// In-band opcode prefix on browser->agent frames (agent->browser is raw bytes).
const OPCODE_STDIN = 0x00;
const OPCODE_RESIZE = 0x01;
const OPCODE_RESUME = 0x04; // payload = decimal ASCII count of output bytes already rendered

type ConnState = "idle" | "connecting" | "open" | "reconnecting" | "disconnected" | "closed" | "failed";

const props = withDefaults(
  defineProps<{
    session: TerminalSession;
    disabled?: boolean;
    // "poll" (default) is the HTTP store-and-forward relay; "stream" attaches a
    // WebSocket and is only usable when the node's agent runs in stream mode.
    transport?: "poll" | "stream";
  }>(),
  { transport: "poll" },
);

const emit = defineEmits<{
  "update:session": [session: TerminalSession];
  error: [message: string];
  closed: [session: TerminalSession];
  state: [state: ConnState];
}>();

const { t } = useI18n();
const visibility = useDocumentVisibility();

const container = ref<HTMLElement | null>(null);
const terminalError = ref<string | undefined>();
const connState = ref<ConnState>("idle");
const retryIn = ref(0); // seconds until the next reconnect attempt (stream)
const findOpen = ref(false);
const findQuery = ref("");
const findInput = ref<HTMLInputElement | null>(null);

let terminal: Terminal | undefined;
let fitAddon: FitAddon | undefined;
let searchAddon: SearchAddon | undefined;
let webglAddon: WebglAddon | undefined;
let resizeObserver: ResizeObserver | undefined;
let pasteListener: ((event: ClipboardEvent) => void) | undefined;
let pollTimer: ReturnType<typeof setTimeout> | undefined;
let polling = false; // single-flight guard: at most one events request in flight
let pollGen = 0; // bumped on (re)start so a superseded in-flight poll won't reschedule
let inputTimer: ReturnType<typeof setTimeout> | undefined;
let resizeTimer: ReturnType<typeof setTimeout> | undefined;
let cursor = 0;
let inputBuffer = "";
let sendingInput = false;
let lastCols = 0;
let lastRows = 0;
let disposed = false;
let closedPollsRemaining = 0;
let closedEmittedFor = "";
let lastPastedText = "";
let lastPastedAt = 0;
let outputQueue: Array<string | Uint8Array> = [];
let outputRaf: number | undefined;

// --- WebSocket (stream) transport state ---
let ws: WebSocket | undefined;
let wsGen = 0; // bumped to invalidate handlers of a superseded socket
let wsBackoff = WS_BACKOFF_START_MS;
let wsReconnectTimer: ReturnType<typeof setTimeout> | undefined;
let retryTicker: ReturnType<typeof setInterval> | undefined;
let hasConnectedOnce = false;
let reconnectAttempts = 0;
// bytesRendered is the absolute count of output bytes this browser has received.
// It is sent on every (re)connect so the agent replays only the missing tail —
// no double-render, scrollback preserved. Reset only on a new session.
let bytesRendered = 0;
const encoder = new TextEncoder();

const isStream = computed(() => props.transport === "stream");
const isClosed = computed(() => props.session.status === "closed" || props.session.status === "failed");

function setConnState(next: ConnState) {
  if (connState.value === next) return;
  connState.value = next;
  emit("state", next);
}

function initTerminal() {
  if (!container.value || terminal) return;

  fitAddon = new FitAddon();
  terminal = new Terminal({
    // allowProposedApi enables the unicode11 width provider (correct CJK/emoji
    // cell widths, so full-screen TUIs line up on CJK hosts).
    allowProposedApi: true,
    convertEol: false,
    cursorBlink: true,
    cursorStyle: "block",
    fontFamily:
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    fontSize: 13,
    lineHeight: 1.28,
    macOptionIsMeta: true,
    rightClickSelectsWord: true,
    scrollback: 10000,
    tabStopWidth: 8,
    theme: {
      background: "#070a12",
      foreground: "#d6deef",
      cursor: "#c7d2fe",
      cursorAccent: "#111827",
      selectionBackground: "#334155",
      black: "#0f172a",
      red: "#f87171",
      green: "#34d399",
      yellow: "#fbbf24",
      blue: "#60a5fa",
      magenta: "#c084fc",
      cyan: "#22d3ee",
      white: "#e5e7eb",
      brightBlack: "#475569",
      brightRed: "#fb7185",
      brightGreen: "#4ade80",
      brightYellow: "#fde047",
      brightBlue: "#93c5fd",
      brightMagenta: "#d8b4fe",
      brightCyan: "#67e8f9",
      brightWhite: "#f8fafc",
    },
  });

  terminal.loadAddon(fitAddon);

  // Unicode 11 width tables: correct CJK/emoji column widths so TUI layouts and
  // CJK output align. Must be loaded and activated before open for first paint.
  const unicode11 = new Unicode11Addon();
  terminal.loadAddon(unicode11);
  terminal.unicode.activeVersion = "11";

  searchAddon = new SearchAddon();
  terminal.loadAddon(searchAddon);

  // Clickable links, opened safely in a new tab; only http(s) is honored.
  terminal.loadAddon(
    new WebLinksAddon((_event, uri) => {
      if (/^https?:\/\//i.test(uri)) window.open(uri, "_blank", "noopener,noreferrer");
    }),
  );

  terminal.open(container.value);
  pasteListener = handlePasteEvent;
  container.value.addEventListener("paste", pasteListener, true);

  // Renderer chain: WebGL primary (GPU-accelerated, smooth under heavy output
  // like journalctl -f / build logs), with the built-in DOM renderer as the
  // universal fallback. (addon-canvas is not xterm-6 compatible, so it is
  // omitted; DOM is the last resort.) On a GPU context loss we drop WebGL and
  // let the DOM renderer take over rather than freezing.
  loadWebglRenderer();

  terminal.onData((data) => sendInput(data));
  terminal.attachCustomKeyEventHandler(handleKeyEvent);

  resizeObserver = new ResizeObserver(() => scheduleResize());
  resizeObserver.observe(container.value);
}

function loadWebglRenderer() {
  if (!terminal) return;
  try {
    const addon = new WebglAddon();
    addon.onContextLoss(() => {
      try {
        addon.dispose();
      } catch {
        /* ignore */
      }
      webglAddon = undefined; // DOM renderer resumes automatically
    });
    terminal.loadAddon(addon);
    webglAddon = addon;
  } catch {
    // No WebGL2 (headless, blocklisted GPU): the DOM renderer stays active.
  }
}

// handleKeyEvent implements copy/paste and find. Plain Ctrl+C is left alone so
// it still sends SIGINT to the remote shell; copy only fires on an active
// selection. Returns false to consume the event.
function handleKeyEvent(e: KeyboardEvent): boolean {
  if (e.type !== "keydown") return true;
  const key = e.key.toLowerCase();
  const combo = e.metaKey || (e.ctrlKey && e.shiftKey);
  if (combo && key === "f") {
    openFind();
    return false;
  }
  if (combo && key === "c" && terminal?.hasSelection()) {
    const selection = terminal.getSelection();
    if (selection) {
      void navigator.clipboard?.writeText(selection).catch(() => surfaceClipboardError());
    }
    return false;
  }
  if (combo && key === "v") {
    e.preventDefault();
    e.stopPropagation();
    void pasteFromClipboard();
    return false;
  }
  if (combo && key === "a") {
    terminal?.selectAll();
    return false;
  }
  return true;
}

async function pasteFromClipboard() {
  try {
    const text = await navigator.clipboard?.readText();
    if (text) doPaste(text);
  } catch {
    surfaceClipboardError();
  }
}

function handlePasteEvent(event: ClipboardEvent) {
  if (!terminal || props.disabled) return;
  const text = event.clipboardData?.getData("text/plain") ?? "";
  if (!text) return;
  event.preventDefault();
  event.stopPropagation();
  doPaste(text);
}

// doPaste routes through xterm's paste pipeline so bracketed-paste (DECSET 2004)
// is honored when the remote app supports it: a multiline paste is then
// delivered atomically and does NOT auto-execute. When the app does NOT enable
// bracketed paste, a multiline paste is guarded behind a confirm so a stray
// trailing newline cannot silently run commands.
function doPaste(text: string) {
  if (!terminal) return;
  const now = Date.now();
  if (text === lastPastedText && now - lastPastedAt < 800) return;
  const multiline = /\n/.test(text.replace(/\n+$/, ""));
  const bracketed = terminal.modes?.bracketedPasteMode === true;
  if (multiline && !bracketed) {
    if (!window.confirm(t("operations.terminal.multilinePasteConfirm"))) return;
  }
  lastPastedText = text;
  lastPastedAt = now;
  terminal.paste(text);
}

function surfaceClipboardError() {
  const message = t("operations.terminal.clipboardError");
  if (terminalError.value !== message) {
    terminalError.value = message;
    emit("error", message);
  }
}

// --- find bar ---
function openFind() {
  findOpen.value = true;
  void nextTick(() => findInput.value?.focus());
}
function closeFind() {
  findOpen.value = false;
  searchAddon?.clearDecorations();
  terminal?.focus();
}
function findNext() {
  if (findQuery.value) searchAddon?.findNext(findQuery.value);
}
function findPrevious() {
  if (findQuery.value) searchAddon?.findPrevious(findQuery.value);
}
function onFindKeydown(e: KeyboardEvent) {
  if (e.key === "Enter") {
    e.preventDefault();
    if (e.shiftKey) findPrevious();
    else findNext();
  } else if (e.key === "Escape") {
    e.preventDefault();
    closeFind();
  }
}

function disposeTerminal() {
  disposed = true;
  stopPolling();
  closeWs();
  if (inputTimer) clearTimeout(inputTimer);
  if (resizeTimer) clearTimeout(resizeTimer);
  if (outputRaf !== undefined) cancelAnimationFrame(outputRaf);
  if (pasteListener && container.value) {
    container.value.removeEventListener("paste", pasteListener, true);
  }
  resizeObserver?.disconnect();
  webglAddon?.dispose();
  terminal?.dispose();
  pollTimer = undefined;
  inputTimer = undefined;
  resizeTimer = undefined;
  outputQueue = [];
  outputRaf = undefined;
  pasteListener = undefined;
  resizeObserver = undefined;
  terminal = undefined;
  fitAddon = undefined;
  searchAddon = undefined;
  webglAddon = undefined;
}

function clearTerminalForSession() {
  cursor = 0;
  inputBuffer = "";
  lastCols = 0;
  lastRows = 0;
  bytesRendered = 0;
  closedPollsRemaining = 0;
  closedEmittedFor = "";
  reconnectAttempts = 0;
  wsBackoff = WS_BACKOFF_START_MS;
  terminalError.value = undefined;
  setConnState("idle");
  terminal?.reset();
  terminal?.clear();
}

// startTransport (re)connects whichever transport is active for the current
// session. Called on mount, on session change, and on status transitions.
function startTransport() {
  if (isStream.value) connectWs();
  else startPolling();
}

// --- input dispatch ---
function sendInput(data: string) {
  if (props.disabled || !data) return;
  if (isStream.value) wsSendInput(data);
  else queueInput(data);
}

function writeTerminalOutput(data: string | Uint8Array) {
  if (!terminal) return;
  outputQueue.push(data);
  if (outputRaf !== undefined) return;
  outputRaf = requestAnimationFrame(() => {
    outputRaf = undefined;
    if (!terminal || outputQueue.length === 0) return;
    const queue = outputQueue;
    outputQueue = [];
    for (const chunk of queue) terminal.write(chunk);
  });
}

// ============================ WebSocket transport ============================

function streamUrl(id: string): string {
  return api.terminal.streamURL(id);
}

function connectWs() {
  if (disposed || !isStream.value) return;
  closeWs();
  stopRetryCountdown();
  wsGen += 1;
  const myGen = wsGen;
  const sessionId = props.session.id;
  setConnState(hasConnectedOnce ? "reconnecting" : "connecting");
  let sock: WebSocket;
  try {
    sock = new WebSocket(streamUrl(sessionId));
  } catch {
    scheduleWsReconnect();
    return;
  }
  sock.binaryType = "arraybuffer";
  ws = sock;

  sock.onopen = () => {
    if (myGen !== wsGen) return;
    hasConnectedOnce = true;
    wsBackoff = WS_BACKOFF_START_MS;
    reconnectAttempts = 0;
    setConnState("open");
    terminalError.value = undefined;
    // Tell the agent how much output we have already rendered so it replays only
    // the missing tail (resume), then push our current size so a TUI redraws.
    wsSendResume();
    sendResizeWs(true);
    terminal?.focus();
  };
  sock.onmessage = (ev) => {
    if (myGen !== wsGen) return;
    if (typeof ev.data === "string") return; // reserved control frames — ignore
    const bytes = new Uint8Array(ev.data as ArrayBuffer);
    bytesRendered += bytes.byteLength;
    writeTerminalOutput(bytes);
  };
  sock.onerror = () => {
    // onclose always follows; reconnect/teardown is handled there.
  };
  sock.onclose = (ev) => {
    if (myGen !== wsGen) return;
    ws = undefined;
    if (disposed) return;
    if (ev.code === WS_CLOSE_TRY_AGAIN) {
      const message = t("operations.terminal.nodeOffline");
      terminalError.value = message;
      setConnState("failed");
      emit("error", message);
      emit("closed", { ...props.session, status: "failed" });
      return;
    }
    if (ev.code === WS_CLOSE_NORMAL) {
      setConnState("closed");
      emit("closed", { ...props.session, status: "closed" });
      return;
    }
    // Unexpected drop (network blip, nginx reload, agent redial): keep the
    // terminal intact and reconnect with backoff. The server holds the session
    // alive within its detach window and the agent keeps the shell running, so
    // the reconnect resumes seamlessly via the rendered-offset replay.
    scheduleWsReconnect();
  };
}

function scheduleWsReconnect() {
  if (disposed || !isStream.value) return;
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    // Auto-retry budget spent: a brief blip would have recovered by now, so this
    // is a real outage. Stop looping and let the user reconnect on demand — the
    // session stays resumable server-side for its detach window.
    stopRetryCountdown();
    setConnState("disconnected");
    return;
  }
  reconnectAttempts += 1;
  setConnState("reconnecting");
  if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
  const delay = wsBackoff;
  wsReconnectTimer = setTimeout(() => {
    if (!disposed && isStream.value) connectWs();
  }, delay);
  wsBackoff = Math.min(wsBackoff * 2, WS_BACKOFF_MAX_MS);
  startRetryCountdown(delay);
}

function reconnectNow() {
  if (disposed || !isStream.value) return;
  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = undefined;
  }
  wsBackoff = WS_BACKOFF_START_MS;
  reconnectAttempts = 0; // manual reconnect restarts the auto-retry budget
  connectWs();
}

function startRetryCountdown(delay: number) {
  stopRetryCountdown();
  const until = Date.now() + delay;
  const tick = () => {
    retryIn.value = Math.max(0, Math.ceil((until - Date.now()) / 1000));
  };
  tick();
  retryTicker = setInterval(tick, 250);
}

function stopRetryCountdown() {
  if (retryTicker) {
    clearInterval(retryTicker);
    retryTicker = undefined;
  }
  retryIn.value = 0;
}

function closeWs() {
  wsGen += 1; // invalidate any in-flight handlers
  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = undefined;
  }
  stopRetryCountdown();
  if (ws) {
    try {
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      ws.close(WS_CLOSE_NORMAL);
    } catch {
      /* ignore */
    }
    ws = undefined;
  }
}

function wsSendResume() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const payload = encoder.encode(String(bytesRendered));
  const frame = new Uint8Array(payload.length + 1);
  frame[0] = OPCODE_RESUME;
  frame.set(payload, 1);
  ws.send(frame);
}

function wsSendInput(data: string) {
  if (!ws || ws.readyState !== WebSocket.OPEN || !data) return;
  const payload = encoder.encode(data);
  const frame = new Uint8Array(payload.length + 1);
  frame[0] = OPCODE_STDIN;
  frame.set(payload, 1);
  ws.send(frame);
}

function sendResizeWs(force = false) {
  if (!ws || ws.readyState !== WebSocket.OPEN || !terminal) return;
  const cols = terminal.cols;
  const rows = terminal.rows;
  if (!cols || !rows) return;
  if (!force && cols === lastCols && rows === lastRows) return;
  lastCols = cols;
  lastRows = rows;
  const json = encoder.encode(JSON.stringify({ cols, rows }));
  const frame = new Uint8Array(json.length + 1);
  frame[0] = OPCODE_RESIZE;
  frame.set(json, 1);
  ws.send(frame);
}

// ============================== Poll transport ===============================

function stopPolling() {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = undefined;
}

/** Arm the next poll. Single timer; clearing first prevents a stray double. */
function scheduleNextPoll(delay: number) {
  if (disposed) return;
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(() => void pollEvents(), delay);
}

function startPolling() {
  pollGen += 1; // invalidate any in-flight poll from a previous (re)start
  stopPolling();
  scheduleNextPoll(0); // first poll runs on the next tick, never overlapping a live one
}

/**
 * Single-flight, self-scheduling events poll. At most one events request is
 * ever in flight, and an event whose seq is already applied is never repainted
 * — the two guards that fixed the runaway-repeat bug. (Default transport.)
 */
async function pollEvents(): Promise<void> {
  if (disposed) return;
  const myGen = pollGen;
  if (polling) {
    scheduleNextPoll(POLL_MS);
    return;
  }
  if (visibility.value === "hidden") {
    scheduleNextPoll(POLL_MS);
    return;
  }

  polling = true;
  let delay = POLL_MS;
  let keepPolling = true;
  const session = props.session;
  try {
    const res = await api.terminal.events(session.id, cursor);
    if (myGen !== pollGen) {
      keepPolling = false;
      return;
    }
    emit("update:session", res.session);
    for (const event of res.events) {
      if (event.seq <= cursor) continue; // already applied — never repaint
      cursor = event.seq;
      if (event.kind === "output" && event.data) writeTerminalOutput(event.data);
    }
    terminalError.value = undefined;

    const ended = res.session.status === "closed" || res.session.status === "failed";
    if (ended && closedEmittedFor !== res.session.id) {
      closedEmittedFor = res.session.id;
      emit("closed", res.session);
    }
    if (ended) {
      if (closedPollsRemaining > 0) closedPollsRemaining -= 1;
      if (closedPollsRemaining <= 0) keepPolling = false; // session fully drained — stop
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : t("operations.terminal.eventsFailed");
    const changed = terminalError.value !== message;
    terminalError.value = message;
    if (changed) emit("error", message);
    delay = POLL_ERROR_MS;
  } finally {
    polling = false;
    if (keepPolling && !disposed && myGen === pollGen) scheduleNextPoll(delay);
  }
}

function queueInput(data: string) {
  if (props.session.status !== "open" || !data) return;
  inputBuffer += data;
  if (inputTimer) return;
  inputTimer = setTimeout(() => void flushInput(), INPUT_FLUSH_MS);
}

async function flushInput() {
  inputTimer = undefined;
  if (sendingInput || props.disabled || props.session.status !== "open") return;
  const data = inputBuffer;
  inputBuffer = "";
  if (!data) return;

  sendingInput = true;
  const sessionID = props.session.id;
  try {
    const session = await api.terminal.input(sessionID, data);
    if (props.session.id !== sessionID) return;
    emit("update:session", session);
  } catch (error) {
    const message = error instanceof Error ? error.message : t("operations.terminal.toastSendFailed");
    const changed = terminalError.value !== message;
    terminalError.value = message;
    if (changed) emit("error", message);
  } finally {
    sendingInput = false;
    if (inputBuffer) void flushInput();
  }
}

// ============================ Resize (both modes) ============================

function scheduleResize() {
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => void fitAndSendResize(), RESIZE_DEBOUNCE_MS);
}

async function fitAndSendResize() {
  resizeTimer = undefined;
  if (!terminal || !fitAddon || isClosed.value) return;
  try {
    fitAddon.fit();
  } catch {
    return;
  }
  if (isStream.value) {
    sendResizeWs();
    return;
  }
  const cols = terminal.cols;
  const rows = terminal.rows;
  if (!cols || !rows || (cols === lastCols && rows === lastRows)) return;
  lastCols = cols;
  lastRows = rows;
  const sessionID = props.session.id;
  try {
    const session = await api.terminal.resize(sessionID, cols, rows);
    if (props.session.id !== sessionID) return;
    emit("update:session", session);
  } catch (error) {
    const message = error instanceof Error ? error.message : t("operations.terminal.resizeFailed");
    const changed = terminalError.value !== message;
    terminalError.value = message;
    if (changed) emit("error", message);
  }
}

function focusTerminal() {
  terminal?.focus();
}

// refit fits now and again on the next frame. The second pass is what fixes the
// "bottom row clipped until I resize the window" symptom: after a container size
// change (mount, fullscreen toggle, height recompute) the WebGL renderer's canvas
// can need one frame to settle, so a single fit leaves the last row clipped.
function refit() {
  void fitAndSendResize();
  requestAnimationFrame(() => void fitAndSendResize());
}

defineExpose({ focusTerminal, fitAndSendResize, refit });

onMounted(async () => {
  initTerminal();
  await nextTick();
  refit();
  startTransport();
  terminal?.focus();
});

watch(
  () => props.session.id,
  async () => {
    hasConnectedOnce = false;
    clearTerminalForSession();
    await nextTick();
    scheduleResize();
    startTransport();
    terminal?.focus();
  },
);

watch(
  () => props.session.status,
  (status) => {
    if (isStream.value) return; // stream lifecycle is driven by the socket, not poll status
    if (status === "closed" || status === "failed") {
      closedPollsRemaining = 12; // drain a few more polls, then the loop self-stops
      startPolling();
    } else if (!pollTimer && !polling) {
      startPolling();
    }
  },
);

watch(visibility, (value) => {
  // Poll: nudge an immediate poll on return. Stream: keep the socket live on a
  // backgrounded tab (a real terminal keeps receiving), just refocus.
  if (value !== "visible" || disposed) return;
  if (isStream.value) terminal?.focus();
  else if (!polling) scheduleNextPoll(0);
});

onBeforeUnmount(() => {
  disposeTerminal();
});
</script>

<template>
  <div class="relative h-full min-h-0 overflow-hidden rounded-lg border border-slate-800 bg-[#070a12] shadow-sm">
    <div ref="container" class="h-full w-full p-3" />

    <!-- Find bar -->
    <div
      v-if="findOpen"
      class="absolute right-4 top-4 flex items-center gap-1 rounded-md border border-slate-700 bg-slate-900/95 px-2 py-1 shadow-lg"
    >
      <input
        ref="findInput"
        v-model="findQuery"
        class="w-44 bg-transparent px-1 text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none"
        :placeholder="$t('operations.terminal.findPlaceholder')"
        @keydown="onFindKeydown"
      />
      <button class="rounded px-1.5 py-0.5 text-xs text-slate-300 hover:bg-slate-700" @click="findPrevious">↑</button>
      <button class="rounded px-1.5 py-0.5 text-xs text-slate-300 hover:bg-slate-700" @click="findNext">↓</button>
      <button
        class="rounded px-1.5 py-0.5 text-xs text-slate-400 hover:bg-slate-700"
        :aria-label="$t('operations.terminal.findClose')"
        @click="closeFind"
      >
        ✕
      </button>
    </div>

    <!-- Stream: first connect -->
    <div
      v-if="isStream && connState === 'connecting'"
      class="pointer-events-none absolute inset-x-4 top-4 rounded-md border border-sky-400/20 bg-sky-400/10 px-3 py-2 text-xs text-sky-100"
    >
      {{ $t('operations.terminal.connecting') }}
    </div>

    <!-- Stream: reconnecting after a drop (session is kept alive server-side) -->
    <div
      v-else-if="isStream && connState === 'reconnecting'"
      class="absolute inset-x-4 top-4 flex items-center justify-between gap-3 rounded-md border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-100"
    >
      <span>
        {{ $t('operations.terminal.reconnecting') }}
        <span v-if="retryIn > 0" class="opacity-70">({{ retryIn }}s)</span>
      </span>
      <button
        class="rounded border border-amber-300/40 px-2 py-0.5 text-amber-50 hover:bg-amber-300/20"
        @click="reconnectNow"
      >
        {{ $t('operations.terminal.reconnectNow') }}
      </button>
    </div>

    <!-- Stream: auto-retry gave up — manual reconnect (session may still be resumable) -->
    <div
      v-else-if="isStream && connState === 'disconnected'"
      class="absolute inset-x-4 top-4 flex items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/15 px-3 py-2 text-xs text-destructive-foreground"
    >
      <span>{{ $t('operations.terminal.disconnected') }}</span>
      <button
        class="rounded border border-destructive/40 px-2 py-0.5 hover:bg-destructive/20"
        @click="reconnectNow"
      >
        {{ $t('operations.terminal.reconnectNow') }}
      </button>
    </div>

    <!-- Poll: pending agent pickup -->
    <div
      v-else-if="!isStream && props.session.status === 'pending'"
      class="pointer-events-none absolute inset-x-4 top-4 rounded-md border border-amber-400/20 bg-amber-400/10 px-3 py-2 text-xs text-amber-100"
    >
      {{ $t('operations.terminal.pendingHint') }}
    </div>

    <div
      v-if="terminalError"
      class="absolute inset-x-4 bottom-4 rounded-md border border-destructive/40 bg-destructive/15 px-3 py-2 text-xs text-destructive-foreground"
    >
      {{ terminalError }}
    </div>
  </div>
</template>

<style scoped>
:deep(.xterm) {
  height: 100%;
}

:deep(.xterm-viewport) {
  scrollbar-color: rgb(71 85 105) transparent;
}

:deep(.xterm-screen) {
  min-height: 100%;
}
</style>

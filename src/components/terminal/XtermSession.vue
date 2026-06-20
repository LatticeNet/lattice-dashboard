<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useDocumentVisibility } from "@vueuse/core";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useI18n } from "vue-i18n";
import { api, type TerminalSession } from "@/lib/api";

const POLL_MS = 220;
const POLL_ERROR_MS = 1500; // back off after a failed poll so a bad link isn't hammered
const INPUT_FLUSH_MS = 35;
const RESIZE_DEBOUNCE_MS = 160;
const WS_BACKOFF_START_MS = 500;
const WS_BACKOFF_MAX_MS = 8000;
const WS_CLOSE_NORMAL = 1000;
const WS_CLOSE_TRY_AGAIN = 1013; // server: agent never dialed (node offline)

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
}>();

const { t } = useI18n();
const visibility = useDocumentVisibility();

const container = ref<HTMLElement | null>(null);
const terminalError = ref<string | undefined>();
const streamConnecting = ref(false);

let terminal: Terminal | undefined;
let fitAddon: FitAddon | undefined;
let resizeObserver: ResizeObserver | undefined;
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

// --- WebSocket (stream) transport state ---
let ws: WebSocket | undefined;
let wsGen = 0; // bumped to invalidate handlers of a superseded socket
let wsBackoff = WS_BACKOFF_START_MS;
let wsReconnectTimer: ReturnType<typeof setTimeout> | undefined;
const encoder = new TextEncoder();

const isStream = computed(() => props.transport === "stream");
const isClosed = computed(() => props.session.status === "closed" || props.session.status === "failed");

function initTerminal() {
  if (!container.value || terminal) return;

  fitAddon = new FitAddon();
  terminal = new Terminal({
    allowProposedApi: false,
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
  terminal.open(container.value);
  terminal.onData((data) => sendInput(data));

  // Copy/paste: Cmd+C/V (macOS) or Ctrl+Shift+C/V. Plain Ctrl+C is left alone
  // so it still sends SIGINT to the remote shell. Copy only fires when there is
  // an active selection.
  terminal.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown") return true;
    const key = e.key.toLowerCase();
    const combo = e.metaKey || (e.ctrlKey && e.shiftKey);
    if (combo && key === "c" && terminal?.hasSelection()) {
      const selection = terminal.getSelection();
      if (selection) void navigator.clipboard?.writeText(selection);
      return false;
    }
    if (combo && key === "v") {
      void navigator.clipboard?.readText().then((text) => {
        if (text) sendInput(text);
      });
      return false;
    }
    if (combo && key === "a") {
      terminal?.selectAll();
      return false;
    }
    return true;
  });

  resizeObserver = new ResizeObserver(() => scheduleResize());
  resizeObserver.observe(container.value);
}

function disposeTerminal() {
  disposed = true;
  stopPolling();
  closeWs();
  if (inputTimer) clearTimeout(inputTimer);
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeObserver?.disconnect();
  terminal?.dispose();
  pollTimer = undefined;
  inputTimer = undefined;
  resizeTimer = undefined;
  resizeObserver = undefined;
  terminal = undefined;
  fitAddon = undefined;
}

function clearTerminalForSession() {
  cursor = 0;
  inputBuffer = "";
  lastCols = 0;
  lastRows = 0;
  closedPollsRemaining = 0;
  closedEmittedFor = "";
  terminalError.value = undefined;
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

// ============================ WebSocket transport ============================

function streamUrl(id: string): string {
  return api.terminal.streamURL(id);
}

function connectWs() {
  if (disposed || !isStream.value) return;
  closeWs();
  wsGen += 1;
  const myGen = wsGen;
  const sessionId = props.session.id;
  streamConnecting.value = true;
  let sock: WebSocket;
  try {
    sock = new WebSocket(streamUrl(sessionId));
  } catch {
    streamConnecting.value = false;
    scheduleWsReconnect();
    return;
  }
  sock.binaryType = "arraybuffer";
  ws = sock;

  sock.onopen = () => {
    if (myGen !== wsGen) return;
    wsBackoff = WS_BACKOFF_START_MS;
    streamConnecting.value = false;
    terminalError.value = undefined;
    sendResizeWs(true);
    terminal?.focus();
  };
  sock.onmessage = (ev) => {
    if (myGen !== wsGen) return;
    if (typeof ev.data === "string") return; // control echoes (unused) — ignore
    terminal?.write(new Uint8Array(ev.data as ArrayBuffer));
  };
  sock.onerror = () => {
    // onclose always follows; reconnect/teardown is handled there.
  };
  sock.onclose = (ev) => {
    if (myGen !== wsGen) return;
    ws = undefined;
    streamConnecting.value = false;
    if (disposed) return;
    if (ev.code === WS_CLOSE_TRY_AGAIN) {
      const message = t("operations.terminal.nodeOffline");
      terminalError.value = message;
      emit("error", message);
      emit("closed", { ...props.session, status: "failed" });
      return;
    }
    if (ev.code === WS_CLOSE_NORMAL) {
      emit("closed", { ...props.session, status: "closed" });
      return;
    }
    // Unexpected drop (network blip, nginx reload): reconnect with backoff.
    scheduleWsReconnect();
  };
}

function scheduleWsReconnect() {
  if (disposed || !isStream.value) return;
  if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
  wsReconnectTimer = setTimeout(() => {
    if (!disposed && isStream.value) connectWs();
  }, wsBackoff);
  wsBackoff = Math.min(wsBackoff * 2, WS_BACKOFF_MAX_MS);
}

function closeWs() {
  wsGen += 1; // invalidate any in-flight handlers
  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = undefined;
  }
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

function wsSendInput(data: string) {
  if (!ws || ws.readyState !== WebSocket.OPEN || !data) return;
  const payload = encoder.encode(data);
  const frame = new Uint8Array(payload.length + 1);
  frame[0] = 0x00; // stdin opcode
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
  frame[0] = 0x01; // resize opcode
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
      if (event.kind === "output" && event.data) terminal?.write(event.data);
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

defineExpose({ focusTerminal, fitAndSendResize });

onMounted(async () => {
  initTerminal();
  await nextTick();
  scheduleResize();
  startTransport();
  terminal?.focus();
});

watch(
  () => props.session.id,
  async () => {
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
  <div class="relative h-full min-h-[520px] overflow-hidden rounded-lg border border-slate-800 bg-[#070a12] shadow-sm">
    <div ref="container" class="h-full w-full p-3" />
    <div
      v-if="isStream && streamConnecting"
      class="pointer-events-none absolute inset-x-4 top-4 rounded-md border border-sky-400/20 bg-sky-400/10 px-3 py-2 text-xs text-sky-100"
    >
      {{ $t('operations.terminal.connecting') }}
    </div>
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

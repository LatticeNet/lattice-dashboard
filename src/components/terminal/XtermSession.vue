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

const props = defineProps<{
  session: TerminalSession;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  "update:session": [session: TerminalSession];
  error: [message: string];
  closed: [session: TerminalSession];
}>();

const { t } = useI18n();
const visibility = useDocumentVisibility();

const container = ref<HTMLElement | null>(null);
const terminalError = ref<string | undefined>();

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
    scrollback: 4000,
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
  terminal.onData((data) => queueInput(data));

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
        if (text) queueInput(text);
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
 * Single-flight, self-scheduling events poll.
 *
 * The next request is armed only AFTER the current one settles (success or
 * failure), so at most one events request is ever in flight. A fixed
 * `setInterval` used to fire every POLL_MS regardless of whether the previous
 * request had returned — on a slow/lossy link those requests piled up, each
 * re-fetched the same events for the same cursor, and the un-deduped
 * `terminal.write` repainted already-seen output. That is what made a single
 * keystroke (and the `^C` echo) repeat endlessly. Two guards kill it:
 *   1) single-flight + self-scheduling (no overlap);
 *   2) skip any event whose seq we've already applied (`seq <= cursor`).
 */
async function pollEvents(): Promise<void> {
  if (disposed) return;
  const myGen = pollGen;
  if (polling) {
    // A request is still in flight; retry shortly instead of overlapping it.
    scheduleNextPoll(POLL_MS);
    return;
  }
  if (visibility.value === "hidden") {
    // Don't poll a backgrounded tab; re-arm so it resumes when visible again.
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
      // Superseded by a newer (re)start — the new generation owns the loop.
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
  if (props.disabled || props.session.status !== "open" || !data) return;
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
  startPolling(); // schedules the first (and only-ever-single) poll
  terminal?.focus();
});

watch(
  () => props.session.id,
  async () => {
    clearTerminalForSession();
    await nextTick();
    scheduleResize();
    startPolling(); // bumps generation so the prior session's in-flight poll won't repaint
    terminal?.focus();
  },
);

watch(
  () => props.session.status,
  (status) => {
    if (status === "closed" || status === "failed") {
      closedPollsRemaining = 12; // drain a few more polls, then the loop self-stops
      startPolling();
    } else if (!pollTimer && !polling) {
      startPolling();
    }
  },
);

watch(visibility, (value) => {
  // Returning to the tab: nudge an immediate poll (loop otherwise resumes within POLL_MS).
  if (value === "visible" && !disposed && !polling) scheduleNextPoll(0);
});

onBeforeUnmount(() => {
  disposeTerminal();
});
</script>

<template>
  <div class="relative h-full min-h-[520px] overflow-hidden rounded-lg border border-slate-800 bg-[#070a12] shadow-sm">
    <div ref="container" class="h-full w-full p-3" />
    <div
      v-if="props.session.status === 'pending'"
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

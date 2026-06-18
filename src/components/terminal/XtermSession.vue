<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useDocumentVisibility } from "@vueuse/core";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useI18n } from "vue-i18n";
import { api, type TerminalSession } from "@/lib/api";

const POLL_MS = 200;
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
let pollTimer: ReturnType<typeof setInterval> | undefined;
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
  if (pollTimer) clearInterval(pollTimer);
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

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => void pollEvents(), POLL_MS);
}

async function pollEvents() {
  if (disposed || visibility.value === "hidden") return;
  const session = props.session;
  try {
    const res = await api.terminal.events(session.id, cursor);
    if (props.session.id !== session.id) return;
    emit("update:session", res.session);
    for (const event of res.events) {
      if (event.seq > cursor) cursor = event.seq;
      if (event.kind === "output" && event.data) terminal?.write(event.data);
    }
    terminalError.value = undefined;
    if ((res.session.status === "closed" || res.session.status === "failed") && closedEmittedFor !== res.session.id) {
      closedEmittedFor = res.session.id;
      emit("closed", res.session);
    }
    if ((res.session.status === "closed" || res.session.status === "failed") && closedPollsRemaining > 0) {
      closedPollsRemaining -= 1;
      if (closedPollsRemaining === 0 && pollTimer) {
        clearInterval(pollTimer);
        pollTimer = undefined;
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : t("operations.terminal.eventsFailed");
    const changed = terminalError.value !== message;
    terminalError.value = message;
    if (changed) emit("error", message);
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
  startPolling();
  await pollEvents();
  terminal?.focus();
});

watch(
  () => props.session.id,
  async () => {
    clearTerminalForSession();
    await nextTick();
    scheduleResize();
    startPolling();
    await pollEvents();
    terminal?.focus();
  },
);

watch(
  () => props.session.status,
  (status) => {
    if (status === "closed" || status === "failed") {
      closedPollsRemaining = 12;
      if (!pollTimer) startPolling();
      void pollEvents();
    } else if (!pollTimer) {
      startPolling();
    }
  },
);

watch(visibility, (value) => {
  if (value === "visible") void pollEvents();
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

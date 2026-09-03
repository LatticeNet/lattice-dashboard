<script setup lang="ts">
/**
 * Terminal: the session pane first, the node as a command.
 *
 * The page claims the viewport pane, so the shell's main region stops
 * scrolling and this view fills it exactly: title and proof line, the node
 * combobox with Connect, the tab strip of live sessions, and the pane that
 * takes every remaining pixel. Nothing here adds document height, which is
 * what keeps one scroller per document and lets the pane track `100dvh` when
 * a phone keyboard resizes the viewport.
 *
 * Every decision that does not need the DOM lives in ./terminalModel.ts.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import {
  ComboboxAnchor,
  ComboboxContent,
  ComboboxInput,
  ComboboxItem,
  ComboboxPortal,
  ComboboxRoot,
  ComboboxTrigger,
  ComboboxViewport,
  FocusScope,
} from "reka-ui";
import { ChevronRight, ChevronsUpDown, Maximize2, Minimize2, Power, RefreshCw, Search, ShieldOff, SquareTerminal, X } from "lucide-vue-next";
import { api, unwrap, type Node, type TerminalSession } from "@/lib/api";
import { describeNodeStatus } from "@/lib/nodeStatus";
import { useAsyncData } from "@/composables/useAsyncData";
import { useAuthStore } from "@/stores/auth";
import { claimViewportPane } from "@/layout/viewportPane";
import { formatDateTime, shortId } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  TERMINAL_LIMITS,
  TERMINAL_SCOPE,
  buildSessionTabs,
  connectReadiness,
  createRequest,
  deniedState,
  filterNodes,
  isForbidden,
  latestEnded,
  nextActiveTab,
  proofLabels,
  queryFlag,
  queryString,
  resolveTransport,
  sessionCounts,
  type BlockedReason,
  type CloseReasonKind,
  type ProofLabel,
  type SessionTab,
  type TransportMode,
} from "./terminalModel";

import PageHeader from "@/components/common/PageHeader.vue";
import ConfirmDialog from "@/components/common/ConfirmDialog.vue";
import EmptyState from "@/components/common/EmptyState.vue";
import StatusDot from "@/components/common/StatusDot.vue";
import XtermSession from "@/components/terminal/XtermSession.vue";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 34;
const TRANSPORT_STORAGE_KEY = "lattice.terminal.transport";
const SHELLS = ["bash", "sh", "/bin/zsh"] as const;

const route = useRoute();
const { t } = useI18n();
const auth = useAuthStore();

// The pane is claimed for the view's lifetime; the shell's main region is the
// containing block for the `absolute inset-0` root below.
const releaseViewportPane = claimViewportPane();
onBeforeUnmount(() => releaseViewportPane());

const hasScope = computed(() => auth.can(TERMINAL_SCOPE));
const canListNodes = computed(() => auth.can("node:read"));

const nodesQuery = useAsyncData(
  (signal) => (canListNodes.value ? api.nodes.list({ signal }).then((r) => unwrap(r, "nodes")) : Promise.resolve([] as Node[])),
  { pollInterval: 5000, immediate: hasScope.value },
);
const sessionsQuery = useAsyncData((signal) => api.terminal.list({ signal }).then((r) => r.sessions), {
  pollInterval: 5000,
  immediate: hasScope.value,
});

const nodes = computed(() => nodesQuery.data.value ?? []);
const sessions = computed(() => sessionsQuery.data.value ?? []);

const denied = computed(() => deniedState({ hasScope: hasScope.value, listError: sessionsQuery.error.value }));
// A refused list is a scope problem, not a blip; polling it every five seconds
// would only fill the audit log with denies.
watch(denied, (state) => {
  if (state === "forbidden") sessionsQuery.stop();
});

// --- node choice ------------------------------------------------------------

const selectedNodeId = ref("");
const nodeSearch = ref("");
const nodeInput = ref<InstanceType<typeof ComboboxInput> | null>(null);

function nodeById(id: string): Node | undefined {
  return nodes.value.find((node) => node.id === id);
}
const selectedNode = computed(() => nodeById(selectedNodeId.value));
const filteredNodes = computed(() => filterNodes(nodes.value, nodeSearch.value));

function displayNode(id: unknown): string {
  if (typeof id !== "string" || !id) return "";
  return nodeById(id)?.name ?? id;
}

// A deep link (`?node_id=`) chooses the node the way a click would, once per
// route change. It is not a default: without the query nothing is chosen.
const routeNodeId = computed(() => queryString(route.query.node_id));
const routeConnect = computed(() => queryFlag(route.query.connect));
const routeSessionId = computed(() => queryString(route.query.session_id));
let appliedRouteNodeId = "";
let routeConnectAttempted = false;
watch(
  [nodes, routeNodeId],
  ([list, id]) => {
    if (!id || id === appliedRouteNodeId || !list.some((node) => node.id === id)) return;
    appliedRouteNodeId = id;
    selectedNodeId.value = id;
  },
  { immediate: true },
);
watch(routeNodeId, () => {
  routeConnectAttempted = false;
});
// A link naming a node this token cannot see, or that no longer exists, says
// so instead of leaving Connect off without a reason.
const routeNodeMissing = computed(() => {
  const id = routeNodeId.value;
  return id && nodesQuery.data.value !== undefined && !nodes.value.some((node) => node.id === id) ? id : "";
});

// --- shell and transport ----------------------------------------------------

const shell = ref<string>("bash");

function readStoredTransport(): TransportMode {
  try {
    const stored = localStorage.getItem(TRANSPORT_STORAGE_KEY);
    return stored === "stream" || stored === "poll" ? stored : "auto";
  } catch {
    return "auto";
  }
}
const transportMode = ref<TransportMode>(readStoredTransport());
watch(transportMode, (mode) => {
  try {
    localStorage.setItem(TRANSPORT_STORAGE_KEY, mode);
  } catch {
    /* the preference is not persisted; the session still works */
  }
});

const readiness = computed(() => connectReadiness(selectedNode.value, transportMode.value));
const counts = computed(() => sessionCounts(sessions.value, selectedNodeId.value));

// --- proof line -------------------------------------------------------------

const BLOCKED_KEY: Record<BlockedReason, string> = {
  "no-node": "operations.terminal.proof.blockedNoNode",
  disabled: "operations.terminal.proof.blockedDisabled",
  offline: "operations.terminal.proof.blockedOffline",
  "never-reported": "operations.terminal.proof.blockedNeverReported",
  "terminal-off": "operations.terminal.proof.blockedTerminalOff",
  "exec-off": "operations.terminal.proof.blockedExecOff",
};

function proofText(label: ProofLabel): string {
  switch (label.key) {
    case "transport":
      return label.transport;
    case "shell":
      return label.shell;
    case "agent":
      return t("operations.terminal.proof.agent", { version: label.version });
    case "agentUnknown":
      return t("operations.terminal.proof.agentUnknown");
    case "liveOnNode":
      return t("operations.terminal.proof.liveOnNode", { count: label.count });
    case "liveOwn":
      return t("operations.terminal.proof.liveOwn", { count: label.count });
    case "blocked":
      return t(BLOCKED_KEY[label.reason]);
    case "audited":
      return t("operations.terminal.proof.audited");
  }
}

const proofSegments = computed(() =>
  proofLabels({
    node: selectedNode.value,
    readiness: readiness.value,
    shell: shell.value,
    liveOwn: counts.value.liveOwn,
    liveOnNode: counts.value.liveOnNode,
  }).map((label) => ({ key: label.key, text: proofText(label), tone: label.key === "blocked" ? "warning" : "neutral" })),
);

const limitLines = computed(() => [
  t("operations.terminal.limits.sessions", { count: TERMINAL_LIMITS.maxSessions }),
  t("operations.terminal.limits.perNode", { count: TERMINAL_LIMITS.maxPerNode }),
  t("operations.terminal.limits.pending", { minutes: TERMINAL_LIMITS.pendingMinutes }),
  t("operations.terminal.limits.idle", { minutes: TERMINAL_LIMITS.idleMinutes }),
  t("operations.terminal.limits.absolute", { hours: TERMINAL_LIMITS.absoluteHours }),
]);
const limitsTitle = computed(() => limitLines.value.join(" · "));

const transportHint = computed(() => {
  if (transportMode.value === "stream") return t("operations.terminal.transportForcedStreamHint");
  if (transportMode.value === "poll") return t("operations.terminal.transportForcedPollHint");
  return resolveTransport(selectedNode.value, "auto") === "stream"
    ? t("operations.terminal.transportAutoStreamHint")
    : t("operations.terminal.transportAutoPollHint");
});

// --- sessions and tabs ------------------------------------------------------

// Every session this page has shown. The list poll drops a session the moment
// it ends; the pinned copy keeps its tab, with the server's reason, until the
// operator dismisses it.
const pinned = ref<TerminalSession[]>([]);
const dismissed = ref<ReadonlySet<string>>(new Set());
const activeTabId = ref("");
const starting = ref(false);
const connectError = ref("");
const closing = ref(false);
const closeTarget = ref<SessionTab | undefined>();
const deniedSessionId = ref("");
const xtermRef = ref<{ refit: () => void; requestClose?: () => void; focusTerminal?: () => void } | null>(null);
// The PTY takes focus only on the operator's own action (Connect, a tab
// click, fullscreen), never on load: a page that lands the caret in the shell
// traps a keyboard-only operator there before they reach a single control.
const wantTerminalFocus = ref(false);

const tabs = computed(() => buildSessionTabs(sessions.value, pinned.value, nodes.value, dismissed.value));
const activeTab = computed(() => tabs.value.find((tab) => tab.id === activeTabId.value));
const activeTransport = computed(() => resolveTransport(activeTab.value ? nodeById(activeTab.value.nodeId) : undefined, transportMode.value));
const recentEnded = computed(() => latestEnded(sessions.value));

function upsertPinned(session: TerminalSession) {
  const index = pinned.value.findIndex((candidate) => candidate.id === session.id);
  if (index === -1) {
    pinned.value = [...pinned.value, session];
    return;
  }
  const current = pinned.value[index];
  if (
    current &&
    current.status === session.status &&
    current.error === session.error &&
    current.last_seen === session.last_seen &&
    current.bytes_out === session.bytes_out
  ) {
    return;
  }
  const next = pinned.value.slice();
  next[index] = session;
  pinned.value = next;
}

// A live session the server lists becomes a tab; pin it so its end is shown
// here with the reason rather than the tab silently vanishing.
watch(sessions, (list) => {
  for (const session of list) {
    if (session.status !== "closed" && session.status !== "failed" && !dismissed.value.has(session.id)) upsertPinned(session);
  }
});

watch(tabs, (list) => {
  if (!list.some((tab) => tab.id === activeTabId.value)) activeTabId.value = list[list.length - 1]?.id ?? "";
});

// `?session_id=` attaches to one session by id (an audit link, a handoff). The
// placeholder is replaced by the server's copy on the first poll, or dropped
// with a notice when the server answers 403.
watch(
  routeSessionId,
  (id) => {
    if (!id || tabs.value.some((tab) => tab.id === id) || dismissed.value.has(id)) return;
    upsertPinned({ id, node_id: "", status: "open", created_at: new Date().toISOString() });
    activeTabId.value = id;
  },
  { immediate: true },
);

function dismissTab(id: string) {
  const next = new Set(dismissed.value);
  next.add(id);
  dismissed.value = next;
  pinned.value = pinned.value.filter((session) => session.id !== id);
  activeTabId.value = nextActiveTab(tabs.value, id, activeTabId.value);
}

function selectTab(id: string) {
  wantTerminalFocus.value = true;
  activeTabId.value = id;
  void nextTick(() => xtermRef.value?.focusTerminal?.());
}

/** Roving focus on the tab strip: arrows move and select, Home and End jump. */
function onTabKeydown(event: KeyboardEvent, index: number) {
  const keys: Record<string, number> = { ArrowLeft: index - 1, ArrowRight: index + 1, Home: 0, End: tabs.value.length - 1 };
  const target = keys[event.key];
  if (target === undefined) return;
  event.preventDefault();
  const tab = tabs.value[Math.max(0, Math.min(tabs.value.length - 1, target))];
  if (!tab) return;
  activeTabId.value = tab.id;
  void nextTick(() => {
    const el = document.querySelector<HTMLElement>(`[data-terminal-tab="${tab.id}"]`);
    el?.focus();
  });
}

function tabTitle(tab: SessionTab): string {
  const actor = tab.actorId ? t("operations.terminal.pane.actor", { actor: tab.actorId }) : t("operations.terminal.pane.actorUnknown");
  return `${tab.id} · ${tab.nodeName} · ${tab.shell} · ${actor}`;
}

const TAB_TONE: Record<string, "success" | "warning" | "destructive" | "neutral"> = {
  open: "success",
  pending: "warning",
  failed: "destructive",
  closed: "neutral",
};

function tabTone(tab: SessionTab) {
  return TAB_TONE[tab.status] ?? "neutral";
}

const REASON_KEY: Record<CloseReasonKind, string> = {
  "pending-expired": "operations.terminal.ended.pendingExpired",
  "max-duration": "operations.terminal.ended.maxDuration",
  idle: "operations.terminal.ended.idle",
  "node-offline": "operations.terminal.ended.nodeOffline",
  closed: "operations.terminal.ended.closed",
  failed: "operations.terminal.ended.failed",
};

function endedText(tab: SessionTab): string {
  if (!tab.reason) return "";
  const base = t(REASON_KEY[tab.reason.kind]);
  return tab.reason.detail ? `${base} (${tab.reason.detail})` : base;
}

// --- connect ----------------------------------------------------------------

async function connect() {
  // Bound at click time: the id the operator saw, not whatever the list holds
  // by the time the request leaves.
  const chosen = selectedNodeId.value;
  const request = createRequest(nodes.value, chosen, shell.value, { cols: DEFAULT_COLS, rows: DEFAULT_ROWS });
  if (!request || !readiness.value.ready || starting.value) return;
  starting.value = true;
  connectError.value = "";
  try {
    const created = await api.terminal.create(request);
    upsertPinned(created);
    wantTerminalFocus.value = true;
    activeTabId.value = created.id;
    toast.success(t("operations.terminal.toastStarted"));
    void sessionsQuery.refresh();
  } catch (error) {
    connectError.value = error instanceof Error ? error.message : t("operations.terminal.toastStartFailed");
  } finally {
    starting.value = false;
  }
}

// `?connect=1` opens once, and prefers a live session on that node if one
// already exists, the way the Nodes page link expects.
watch(
  [selectedNode, routeConnect, readiness],
  ([node, shouldConnect, ready]) => {
    if (!shouldConnect || routeConnectAttempted || !node || node.id !== routeNodeId.value || !ready.ready) return;
    routeConnectAttempted = true;
    const existing = tabs.value.find((tab) => tab.live && tab.nodeId === node.id);
    if (existing) activeTabId.value = existing.id;
    else void connect();
  },
  { immediate: true },
);

function reconnectOn(tab: SessionTab) {
  selectedNodeId.value = tab.nodeId;
  dismissTab(tab.id);
  void nextTick(() => void connect());
}

// --- close ------------------------------------------------------------------

function askClose(tab: SessionTab) {
  if (!tab.live) {
    dismissTab(tab.id);
    return;
  }
  if (closing.value) return;
  closeTarget.value = tab;
}

async function closeSession() {
  const tab = closeTarget.value;
  if (!tab || closing.value) return;
  closing.value = true;
  try {
    if (tab.id === activeTabId.value) xtermRef.value?.requestClose?.();
    const updated = await api.terminal.close(tab.id);
    upsertPinned(updated);
    toast.success(
      updated.status === "closed" || updated.status === "failed"
        ? t("operations.terminal.toastClosed")
        : t("operations.terminal.toastCloseRequested"),
    );
    void sessionsQuery.refresh();
  } catch (error) {
    if (isForbidden(error)) onDenied(tab.session as TerminalSession);
    else toast.error(error instanceof Error ? error.message : t("operations.terminal.toastCloseFailed"));
  } finally {
    closing.value = false;
    closeTarget.value = undefined;
  }
}

// --- terminal events --------------------------------------------------------

function onSessionUpdate(session: TerminalSession) {
  upsertPinned(session);
}

function onSessionClosed(session: TerminalSession) {
  upsertPinned(session);
  // The stream close carries no reason; the list copy does.
  void sessionsQuery.refresh();
}

function onTerminalError(message: string) {
  if (message) toast.error(message);
}

/** The server said this session is another operator's: drop the tab and say so. */
function onDenied(session: TerminalSession) {
  deniedSessionId.value = session.id;
  dismissTab(session.id);
}

const terminalDisabled = computed(() => closing.value || !activeTab.value?.live);

// --- fullscreen -------------------------------------------------------------

const fullscreen = ref(false);
const fullscreenTrigger = ref<InstanceType<typeof Button> | null>(null);
let returnFocusTo: HTMLElement | null = null;
const paneEl = ref<HTMLElement | null>(null);

// settlePane refits the terminal after a discrete layout change (fullscreen,
// tab switch) so it never renders against a stale size, and replays the
// 200ms fill on the pane. The fill is a transition from a primed state, so a
// toggle mid-way restarts it from the current frame rather than queueing.
function settlePane() {
  const el = paneEl.value;
  if (el) {
    el.classList.add("pane-prime");
    void el.offsetHeight; // commit the primed state before the transition starts
    el.classList.remove("pane-prime");
  }
  void nextTick(() => xtermRef.value?.refit?.());
}

function enterFullscreen() {
  returnFocusTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  wantTerminalFocus.value = true;
  fullscreen.value = true;
  settlePane();
  void nextTick(() => xtermRef.value?.focusTerminal?.());
}

function exitFullscreen() {
  if (!fullscreen.value) return;
  fullscreen.value = false;
  settlePane();
  const target = returnFocusTo;
  returnFocusTo = null;
  void nextTick(() => target?.focus());
}

function toggleFullscreen() {
  if (fullscreen.value) exitFullscreen();
  else enterFullscreen();
}

// Escape leaves fullscreen from the pane's chrome. Inside the shell itself
// Escape belongs to the program running there (vim, less), so from the
// terminal it takes Shift+Escape: in fullscreen that leaves fullscreen, in
// normal mode it moves focus to the pane chrome so Tab reaches every control
// again. Bound in the capture phase because xterm stops propagation of the
// keys it consumes.
function onPaneKeydown(event: KeyboardEvent) {
  if (event.key !== "Escape") return;
  const inTerminal = event.target instanceof HTMLElement && event.target.closest(".xterm") !== null;
  if (inTerminal) {
    if (!event.shiftKey) return;
    event.preventDefault();
    event.stopPropagation();
    if (fullscreen.value) exitFullscreen();
    else focusPaneChrome();
    return;
  }
  if (!fullscreen.value) return;
  event.preventDefault();
  event.stopPropagation();
  exitFullscreen();
}

function focusPaneChrome() {
  const el = fullscreenTrigger.value?.$el;
  if (el instanceof HTMLElement) el.focus();
}

watch(activeTabId, () => settlePane());

onMounted(() => {
  // The first job on this page is choosing a node; on a pointer device the
  // combobox takes focus so typing starts the search. On touch it would only
  // raise the keyboard over the page.
  if (window.matchMedia?.("(pointer: fine)").matches) {
    void nextTick(() => nodeInput.value?.$el?.focus?.());
  }
});
</script>

<template>
  <div class="absolute inset-0 flex min-h-0 flex-col gap-4 overflow-hidden bg-background py-4 sm:p-6">
    <PageHeader :title="$t('operations.terminal.title')" class="shrink-0 px-4 sm:px-0">
      <template #description>
        <!-- The proof line: what a session would run over, before anything opens. -->
        <p class="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-xs leading-5 tabular text-muted-foreground" :title="limitsTitle">
          <template v-for="(segment, index) in proofSegments" :key="segment.key">
            <span v-if="index > 0" aria-hidden="true" class="text-muted-foreground/50">·</span>
            <span :class="segment.tone === 'warning' ? 'text-warning' : segment.key === 'transport' || segment.key === 'shell' ? 'text-foreground' : undefined">
              {{ segment.text }}
            </span>
          </template>
        </p>
      </template>
    </PageHeader>

    <!-- Denied: the page says what is missing instead of showing an empty list. -->
    <section
      v-if="denied"
      class="mx-4 flex flex-1 items-center justify-center rounded-md border border-border bg-card sm:mx-0"
      role="status"
    >
      <EmptyState :icon="ShieldOff" :title="$t('operations.terminal.denied.title')" :description="denied === 'no-scope' ? $t('operations.terminal.denied.noScope') : $t('operations.terminal.denied.forbidden')">
        <p class="font-mono text-xs text-muted-foreground">{{ TERMINAL_SCOPE }}</p>
      </EmptyState>
    </section>

    <template v-else>
      <!-- Toolbar: the node is a command, Connect is the one primary action. -->
      <div class="flex shrink-0 flex-col gap-2 px-4 sm:flex-row sm:items-start sm:px-0">
        <ComboboxRoot
          v-model="selectedNodeId"
          :ignore-filter="true"
          :reset-search-term-on-blur="true"
          class="relative min-w-0 flex-1 sm:max-w-md"
        >
          <ComboboxAnchor
            class="flex h-9 w-full items-center gap-2 rounded-md border border-input bg-background px-3 text-sm transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/40"
          >
            <Search class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <ComboboxInput
              ref="nodeInput"
              v-model="nodeSearch"
              :display-value="displayNode"
              :placeholder="$t('operations.terminal.toolbar.nodePlaceholder')"
              :aria-label="$t('operations.terminal.toolbar.nodeLabel')"
              class="h-full min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
            />
            <ComboboxTrigger class="shrink-0 text-muted-foreground" :aria-label="$t('operations.terminal.toolbar.nodeOpen')">
              <ChevronsUpDown class="size-4" aria-hidden="true" />
            </ComboboxTrigger>
          </ComboboxAnchor>
          <ComboboxPortal>
            <ComboboxContent
              position="popper"
              :side-offset="4"
              class="z-50 max-h-80 min-w-(--reka-combobox-trigger-width) overflow-y-auto overscroll-contain rounded-md border border-border bg-popover text-popover-foreground shadow-md"
            >
              <ComboboxViewport class="p-1">
                <p v-if="!canListNodes" class="px-2 py-4 text-center text-sm text-muted-foreground">
                  {{ $t('operations.terminal.toolbar.nodeNeedsScope') }}
                </p>
                <p v-else-if="nodesQuery.loading.value" class="px-2 py-4 text-center text-sm text-muted-foreground">
                  {{ $t('operations.terminal.toolbar.nodesLoading') }}
                </p>
                <p v-else-if="filteredNodes.length === 0" class="px-2 py-4 text-center text-sm text-muted-foreground">
                  {{ $t('operations.terminal.toolbar.nodeEmpty') }}
                </p>
                <ComboboxItem
                  v-for="node in filteredNodes"
                  :key="node.id"
                  :value="node.id"
                  :text-value="node.name || node.id"
                  class="flex h-8 cursor-default items-center gap-2 rounded-sm px-2 text-sm outline-none transition-colors data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[state=checked]:text-primary"
                >
                  <StatusDot :status="describeNodeStatus(node).health" :pulse="false" />
                  <span class="truncate">{{ node.name || node.id }}</span>
                  <span class="ml-auto min-w-0 max-w-[45%] truncate font-mono text-[11px] tabular text-muted-foreground" :title="node.id">{{ node.id }}</span>
                  <span v-if="sessionCounts(sessions, node.id).liveOnNode" class="shrink-0 font-mono text-[11px] tabular text-primary">
                    {{ $t('operations.terminal.toolbar.liveShort', { count: sessionCounts(sessions, node.id).liveOnNode }) }}
                  </span>
                </ComboboxItem>
              </ComboboxViewport>
            </ComboboxContent>
          </ComboboxPortal>
        </ComboboxRoot>

        <div class="flex items-center gap-2">
          <Select v-model="shell">
            <SelectTrigger class="w-28 shrink-0" :aria-label="$t('operations.terminal.toolbar.shell')">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem v-for="option in SHELLS" :key="option" :value="option">{{ option }}</SelectItem>
            </SelectContent>
          </Select>
          <Button
            class="flex-1 sm:flex-none"
            :disabled="!readiness.ready || starting"
            :title="readiness.ready ? undefined : proofText({ key: 'blocked', reason: readiness.reason })"
            @click="connect"
          >
            <RefreshCw v-if="starting" class="size-4 animate-spin" aria-hidden="true" />
            <Power v-else class="size-4" aria-hidden="true" />
            {{ starting ? $t('operations.terminal.toolbar.connecting') : $t('operations.terminal.toolbar.connect') }}
          </Button>
        </div>
      </div>

      <p v-if="connectError" class="shrink-0 px-4 text-sm text-destructive sm:px-0" role="alert">{{ connectError }}</p>
      <p v-if="routeNodeMissing" class="shrink-0 px-4 font-mono text-xs text-warning sm:px-0" role="status">
        {{ $t('operations.terminal.toolbar.nodeMissing', { id: routeNodeMissing }) }}
      </p>

      <!-- Limits and transport: the caps the server enforces, as static facts. -->
      <details class="group shrink-0 px-4 text-xs text-muted-foreground sm:px-0">
        <summary class="inline-flex min-h-6 cursor-pointer list-none select-none items-center gap-1 font-mono transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
          <ChevronRight class="size-3.5 transition-transform group-open:rotate-90" aria-hidden="true" />
          {{ $t('operations.terminal.limits.summary') }}
        </summary>
        <div class="mt-2 grid gap-3 rounded-md border border-border bg-card p-3 sm:grid-cols-[1fr_auto]">
          <div class="space-y-1">
            <p class="font-mono text-foreground">{{ limitLines.join(' · ') }}</p>
            <p>{{ $t('operations.terminal.limits.source') }}</p>
            <a
              class="text-primary underline-offset-4 hover:underline"
              href="https://latticenet.github.io/guide/node-agent#browser-terminal"
              target="_blank"
              rel="noopener noreferrer"
            >{{ $t('operations.terminal.docs') }}</a>
          </div>
          <div class="grid gap-1">
            <label class="font-medium" for="terminal-transport">{{ $t('operations.terminal.transport') }}</label>
            <Select id="terminal-transport" v-model="transportMode">
              <SelectTrigger class="w-full sm:w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">{{ $t('operations.terminal.transportAuto') }}</SelectItem>
                <SelectItem value="stream">{{ $t('operations.terminal.transportStream') }}</SelectItem>
                <SelectItem value="poll">{{ $t('operations.terminal.transportPoll') }}</SelectItem>
              </SelectContent>
            </Select>
            <p class="max-w-xs">{{ transportHint }}</p>
          </div>
        </div>
      </details>

      <!-- Tab strip: one tab per live session, on any node. -->
      <div
        v-if="tabs.length"
        role="tablist"
        :aria-label="$t('operations.terminal.tabs.label')"
        class="-mb-4 flex shrink-0 items-end gap-1 overflow-x-auto px-4 sm:px-0"
      >
        <div
          v-for="(tab, index) in tabs"
          :key="tab.id"
          :class="
            cn(
              'group flex shrink-0 items-center rounded-t-md border border-b-0 border-border transition-colors',
              tab.id === activeTabId ? 'bg-card text-foreground' : 'bg-muted/40 text-muted-foreground hover:bg-muted hover:text-foreground',
              !tab.live && 'border-dashed',
            )
          "
        >
          <button
            type="button"
            role="tab"
            :data-terminal-tab="tab.id"
            :aria-selected="tab.id === activeTabId"
            :tabindex="tab.id === activeTabId ? 0 : -1"
            :title="tabTitle(tab)"
            class="flex h-8 max-w-64 items-center gap-2 pl-3 pr-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
            @click="selectTab(tab.id)"
            @keydown="onTabKeydown($event, index)"
          >
            <StatusDot :tone="tabTone(tab)" :pulse="tab.status === 'pending'" />
            <span class="truncate">{{ tab.nodeName }}</span>
            <span class="shrink-0 font-mono text-[11px] tabular">{{ shortId(tab.id, 10) }}</span>
            <span v-if="!tab.live" class="shrink-0 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{{ $t('operations.terminal.tabs.ended') }}</span>
          </button>
          <button
            type="button"
            class="mr-1 inline-flex size-6 items-center justify-center rounded-sm text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
            :tabindex="tab.id === activeTabId ? 0 : -1"
            :aria-label="tab.live ? $t('operations.terminal.tabs.closeTab', { node: tab.nodeName }) : $t('operations.terminal.tabs.dismissTab', { node: tab.nodeName })"
            :title="tab.live ? $t('operations.terminal.tabs.closeTab', { node: tab.nodeName }) : $t('operations.terminal.tabs.dismissTab', { node: tab.nodeName })"
            @click.stop="askClose(tab)"
          >
            <X class="size-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>

      <!-- The pane. In fullscreen it becomes a modal region with a focus trap. -->
      <!-- FocusScope would move focus into the pane on mount and on unmount;
           both are ours to do: fullscreen focuses the shell, leaving it
           returns focus to the trigger, and on load focus stays put. -->
      <FocusScope
        as-child
        :trapped="fullscreen"
        :loop="fullscreen"
        @mount-auto-focus="(event: Event) => event.preventDefault()"
        @unmount-auto-focus="(event: Event) => event.preventDefault()"
      >
        <section
          ref="paneEl"
          :role="fullscreen ? 'dialog' : undefined"
          :aria-modal="fullscreen ? 'true' : undefined"
          :aria-label="fullscreen ? $t('operations.terminal.fullscreenRegion') : undefined"
          :class="
            cn(
              'pane-card flex min-h-0 flex-col overflow-hidden border border-border bg-card',
              fullscreen ? 'fixed inset-0 z-50 rounded-none' : 'relative flex-1 rounded-none border-x-0 sm:rounded-md sm:border-x',
              tabs.length && !fullscreen && 'sm:rounded-tl-none',
            )
          "
          @keydown.capture="onPaneKeydown"
        >
          <header class="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-3 py-2">
            <!-- Identity on two wrapping rows: nothing is clipped at any width. -->
            <div v-if="activeTab" class="min-w-0 flex-1 font-mono text-xs leading-5 tabular text-muted-foreground">
              <p class="flex flex-wrap items-center gap-x-2 break-all">
                <span class="text-foreground">{{ activeTab.id }}</span>
                <span aria-hidden="true">·</span>
                <span>{{ activeTab.nodeName }}</span>
              </p>
              <p class="flex flex-wrap items-center gap-x-2">
                <span>{{ activeTab.shell }}</span>
                <span aria-hidden="true">·</span>
                <span>{{ activeTab.actorId ? $t('operations.terminal.pane.actor', { actor: activeTab.actorId }) : $t('operations.terminal.pane.actorUnknown') }}</span>
                <span aria-hidden="true">·</span>
                <span v-if="activeTab.openedAt">{{ $t('operations.terminal.pane.opened', { time: formatDateTime(activeTab.openedAt) }) }}</span>
                <span v-else-if="activeTab.live" class="text-warning">{{ $t('operations.terminal.pane.pending') }}</span>
                <span v-else>{{ $t('operations.terminal.tabs.ended') }}</span>
              </p>
            </div>
            <p v-else class="inline-flex min-w-0 flex-1 items-center gap-2 font-mono text-xs leading-5 text-muted-foreground">
              <SquareTerminal class="size-3.5" aria-hidden="true" />
              {{ $t('operations.terminal.consoleHint') }}
            </p>
            <div class="flex items-center gap-2">
              <Button
                ref="fullscreenTrigger"
                variant="outline"
                size="sm"
                :title="fullscreen ? $t('operations.terminal.exitFullscreenHint') : $t('operations.terminal.fullscreen')"
                :aria-pressed="fullscreen"
                @click="toggleFullscreen"
              >
                <Minimize2 v-if="fullscreen" class="size-4" aria-hidden="true" />
                <Maximize2 v-else class="size-4" aria-hidden="true" />
                <span class="sr-only sm:not-sr-only">{{ fullscreen ? $t('operations.terminal.exitFullscreen') : $t('operations.terminal.fullscreen') }}</span>
              </Button>
              <Button v-if="activeTab" variant="outline" size="sm" :disabled="closing" @click="askClose(activeTab)">
                <X class="size-4" aria-hidden="true" />
                {{ activeTab.live ? $t('operations.terminal.close') : $t('operations.terminal.ended.dismiss') }}
              </Button>
            </div>
          </header>

          <div class="relative min-h-0 flex-1 bg-background">
            <Transition name="pane-fill" mode="out-in">
              <XtermSession
                v-if="activeTab"
                ref="xtermRef"
                :key="activeTab.id + ':' + activeTransport"
                :session="activeTab.session as TerminalSession"
                :disabled="terminalDisabled"
                :transport="activeTransport"
                :autofocus="wantTerminalFocus"
                class="h-full"
                @update:session="onSessionUpdate"
                @closed="onSessionClosed"
                @denied="onDenied"
                @error="onTerminalError"
              />
              <div v-else class="flex h-full items-center justify-center p-8">
                <EmptyState
                  :icon="SquareTerminal"
                  :title="$t('operations.terminal.emptyConsoleTitle')"
                  :description="$t('operations.terminal.emptyConsoleDescription')"
                />
              </div>
            </Transition>

            <!-- The session ended: the server's reason, inside the pane. -->
            <div
              v-if="activeTab && !activeTab.live"
              class="absolute inset-x-4 bottom-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-card px-3 py-2 text-sm shadow-(--shadow-overlay)"
              role="status"
            >
              <span class="min-w-0">
                <span class="font-medium">{{ $t('operations.terminal.ended.title') }}</span>
                <span class="text-muted-foreground"> · {{ endedText(activeTab) }}</span>
                <span v-if="activeTab.closedAt" class="ml-1 font-mono text-xs tabular text-muted-foreground">{{ formatDateTime(activeTab.closedAt) }}</span>
              </span>
              <span class="flex shrink-0 items-center gap-2">
                <Button v-if="activeTab.nodeId" size="sm" variant="outline" @click="reconnectOn(activeTab)">
                  {{ $t('operations.terminal.ended.reconnect', { node: activeTab.nodeName }) }}
                </Button>
                <Button size="sm" variant="ghost" @click="dismissTab(activeTab.id)">{{ $t('operations.terminal.ended.dismiss') }}</Button>
              </span>
            </div>

            <!-- Another operator's session: the tab is gone, the reason stays until read. -->
            <div
              v-if="deniedSessionId"
              class="absolute inset-x-4 top-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/40 bg-card px-3 py-2 text-sm shadow-(--shadow-overlay)"
              role="alert"
            >
              <span class="min-w-0">
                <ShieldOff class="mr-1 inline size-4 text-destructive" aria-hidden="true" />
                {{ $t('operations.terminal.denied.session', { id: deniedSessionId }) }}
              </span>
              <Button size="sm" variant="ghost" @click="deniedSessionId = ''">{{ $t('operations.terminal.denied.dismiss') }}</Button>
            </div>
          </div>
        </section>
      </FocusScope>

      <!-- Recent line: where the operator's sessions are, in absolute time. -->
      <p class="flex shrink-0 flex-wrap items-center gap-x-2 px-4 font-mono text-xs leading-5 tabular text-muted-foreground sm:px-0">
        <template v-if="selectedNode">
          <span>{{ $t('operations.terminal.recent.onNode', { count: counts.liveOnNode }) }}</span>
          <span aria-hidden="true">·</span>
          <span>{{ $t('operations.terminal.recent.elsewhere', { count: counts.liveOwn - counts.liveOnNode }) }}</span>
        </template>
        <span v-else>{{ $t('operations.terminal.proof.liveOwn', { count: counts.liveOwn }) }}</span>
        <template v-if="activeTab?.live">
          <span aria-hidden="true">·</span>
          <span>{{ $t('operations.terminal.pane.releaseHint') }}</span>
        </template>
        <template v-if="recentEnded">
          <span aria-hidden="true">·</span>
          <span>{{ $t('operations.terminal.recent.lastEnded', { node: nodeById(recentEnded.node_id)?.name ?? shortId(recentEnded.node_id, 10), time: formatDateTime(recentEnded.closed_at || recentEnded.created_at) }) }}</span>
        </template>
      </p>
    </template>

    <ConfirmDialog
      :open="closeTarget !== undefined"
      :title="$t('operations.terminal.closeTitle')"
      :description="closeTarget ? $t('operations.terminal.closeDescription', { node: closeTarget.nodeName, id: closeTarget.id }) : ''"
      :confirm-label="$t('operations.terminal.closeSession')"
      :cancel-label="$t('common.actions.cancel')"
      :pending="closing"
      @update:open="(value: boolean) => { if (!value && !closing) closeTarget = undefined; }"
      @confirm="closeSession"
    />
  </div>
</template>

<style scoped>
/* The pane fills in over the base duration on a tab switch and on a
   fullscreen enter or leave; nothing else on this page moves on its own.
   Reduced motion zeroes the tokens at the root. */
.pane-card {
  transition:
    opacity var(--duration-base) var(--ease-out),
    transform var(--duration-base) var(--ease-out);
}
.pane-card.pane-prime {
  transition: none;
  opacity: 0.4;
  transform: translateY(4px);
}
.pane-fill-enter-active {
  transition: opacity var(--duration-base) var(--ease-out);
}
.pane-fill-leave-active {
  transition: opacity 0ms;
}
.pane-fill-enter-from,
.pane-fill-leave-to {
  opacity: 0;
}
</style>

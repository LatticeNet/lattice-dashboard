<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import {
  Activity,
  CircleStop,
  Clock,
  ExternalLink,
  Maximize2,
  Minimize2,
  Power,
  RefreshCw,
  Search,
  Server,
  SquareTerminal,
  Wifi,
  Zap,
} from "lucide-vue-next";
import { api, unwrap, type Node, type TerminalSession } from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { statusMeta, type BadgeVariant, type NodeHealth } from "@/lib/status";
import { formatBytes, formatDateTime, formatRelativeTime, shortId } from "@/lib/format";
import { cn } from "@/lib/utils";

import PageHeader from "@/components/common/PageHeader.vue";
import DataState from "@/components/common/DataState.vue";
import FreshnessLabel from "@/components/common/FreshnessLabel.vue";
import EmptyState from "@/components/common/EmptyState.vue";
import XtermSession from "@/components/terminal/XtermSession.vue";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 34;

const route = useRoute();
const { t } = useI18n();

const nodesQuery = useAsyncData(() => api.nodes.list().then((r) => unwrap(r, "nodes")), {
  pollInterval: 5000,
});
const sessionsQuery = useAsyncData(() => api.terminal.list().then((r) => r.sessions), {
  pollInterval: 5000,
});

const selectedNodeId = ref("");
const nodeSearch = ref("");
const shell = ref("sh");
const activeSession = ref<TerminalSession | undefined>();
const starting = ref(false);
const closing = ref(false);
const closeRequested = ref(false);
const autoConnectAttempted = ref(false);
// Opt-in WebSocket streaming transport (iter-063 Phase 3). Default off (poll):
// streaming only works when the node's agent runs in stream mode. Persisted so
// an operator can dogfood it per browser without changing the default.
const streamingEnabled = ref(localStorage.getItem("lattice.terminal.streaming") === "1");
function toggleStreaming() {
  streamingEnabled.value = !streamingEnabled.value;
  localStorage.setItem("lattice.terminal.streaming", streamingEnabled.value ? "1" : "0");
}

// --- Console sizing + fullscreen ---
// The console fits the viewport without forcing the page to scroll: its height is
// measured from where the box actually starts (getBoundingClientRect().top, which
// already includes the app header + page header + card header above it) down to
// the viewport bottom, minus a small reserve for the status row + page padding.
// It never shrinks below MIN_CONSOLE_H — below that the page scrolls instead of
// squashing the terminal into uselessness.
const MIN_CONSOLE_H = 360;
const CONSOLE_BOTTOM_RESERVE = 88;
const consoleEl = ref<HTMLElement | null>(null);
const consoleHeight = ref(560);
const fullscreen = ref(false);

function recomputeConsoleHeight() {
  if (fullscreen.value) return; // fullscreen fills the viewport via flex, not a fixed px height
  const el = consoleEl.value;
  if (!el) return;
  const top = el.getBoundingClientRect().top;
  const avail = window.innerHeight - top - CONSOLE_BOTTOM_RESERVE;
  consoleHeight.value = Math.max(MIN_CONSOLE_H, Math.floor(avail));
}

function toggleFullscreen() {
  fullscreen.value = !fullscreen.value;
  // Returning from fullscreen: the box is back in flow, so re-measure next tick.
  if (!fullscreen.value) void nextTick(recomputeConsoleHeight);
}

function onWindowKeydown(e: KeyboardEvent) {
  if (e.key === "Escape" && fullscreen.value) {
    fullscreen.value = false;
    void nextTick(recomputeConsoleHeight);
  }
}

onMounted(() => {
  void nextTick(recomputeConsoleHeight);
  window.addEventListener("resize", recomputeConsoleHeight);
  window.addEventListener("keydown", onWindowKeydown);
});
onBeforeUnmount(() => {
  window.removeEventListener("resize", recomputeConsoleHeight);
  window.removeEventListener("keydown", onWindowKeydown);
});
// A session appearing/disappearing shifts the layout (header description, status
// row), so re-measure after the DOM settles.
watch(activeSession, () => void nextTick(recomputeConsoleHeight));

const routeNodeId = computed(() => {
  const raw = route.query.node_id;
  if (Array.isArray(raw)) return raw[0] ?? "";
  return typeof raw === "string" ? raw : "";
});
const routeAutoConnect = computed(() => route.query.connect === "1" || route.query.connect === "true");

const nodes = computed(() => nodesQuery.data.value ?? []);
const sessions = computed(() => sessionsQuery.data.value ?? []);
const activeSessions = computed(() =>
  sessions.value.filter((session) => session.status !== "closed" && session.status !== "failed"),
);

const selectedNode = computed(() =>
  nodes.value.find((node) => node.id === selectedNodeId.value),
);

const filteredNodes = computed(() => {
  const needle = nodeSearch.value.trim().toLowerCase();
  const list = [...nodes.value].sort((a, b) => {
    if (isTerminalReady(a) !== isTerminalReady(b)) return isTerminalReady(a) ? -1 : 1;
    return (a.name || a.id).localeCompare(b.name || b.id);
  });
  if (!needle) return list;
  return list.filter((node) =>
    [
      node.name,
      node.id,
      node.role,
      node.public_ip,
      node.public_ipv6,
      node.agent_version,
      ...(node.tags ?? []),
    ]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(needle)),
  );
});

const isNodeNoMatch = computed(
  () => nodes.value.length > 0 && filteredNodes.value.length === 0,
);

const selectedSessionCount = computed(() =>
  selectedNodeId.value
    ? activeSessions.value.filter((session) => session.node_id === selectedNodeId.value).length
    : 0,
);

const terminalDisabled = computed(
  () =>
    closeRequested.value ||
    closing.value ||
    !activeSession.value ||
    activeSession.value.status === "closed" ||
    activeSession.value.status === "failed",
);

const selectedNodeSubtitle = computed(() => {
  const node = selectedNode.value;
  if (!node) return "";
  return [node.public_ip || node.public_ipv6, node.agent_version].filter(Boolean).join(" · ");
});

watch(
  [nodes, routeNodeId],
  ([list, queryNodeId]) => {
    if (queryNodeId && list.some((node) => node.id === queryNodeId)) {
      selectedNodeId.value = queryNodeId;
      return;
    }
    if (selectedNodeId.value && list.some((node) => node.id === selectedNodeId.value)) return;
    selectedNodeId.value = list[0]?.id ?? "";
  },
  { immediate: true },
);

watch(routeNodeId, () => {
  autoConnectAttempted.value = false;
});

watch(
  [selectedNode, routeAutoConnect, routeNodeId],
  async ([node, shouldConnect, queryNodeId]) => {
    if (!shouldConnect || autoConnectAttempted.value || !node || node.id !== queryNodeId) return;
    autoConnectAttempted.value = true;
    await connectSelected({ preferExisting: true });
  },
  { immediate: true },
);

function isTerminalReady(node: Node): boolean {
  return !!node.online && !node.disabled;
}

function nodeName(id: string): string {
  const node = nodes.value.find((candidate) => candidate.id === id);
  return node?.name || shortId(id, 14);
}

function latestNodeSession(nodeId: string): TerminalSession | undefined {
  return activeSessions.value
    .filter((session) => session.node_id === nodeId)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];
}

function activeCount(nodeId: string): number {
  return activeSessions.value.filter((session) => session.node_id === nodeId).length;
}

const SESSION_HEALTH: Record<string, NodeHealth> = {
  open: "online",
  pending: "pending",
  failed: "offline",
};

function statusVariant(status: string): BadgeVariant {
  return statusMeta(SESSION_HEALTH[status] ?? "unknown").badgeVariant;
}

function selectNode(node: Node) {
  selectedNodeId.value = node.id;
  closeRequested.value = false;
  const latest = latestNodeSession(node.id);
  activeSession.value = latest;
}

function refreshAll() {
  nodesQuery.refresh();
  sessionsQuery.refresh();
}

function attachLatestForSelected() {
  if (!selectedNodeId.value) return;
  const latest = latestNodeSession(selectedNodeId.value);
  if (latest) {
    activeSession.value = latest;
    closeRequested.value = false;
  }
}

let pendingHintTimer: ReturnType<typeof setTimeout> | undefined;

async function connectSelected(options?: { preferExisting?: boolean }) {
  const node = selectedNode.value;
  if (!node) return;
  if (!isTerminalReady(node)) {
    toast.error(t("operations.terminal.nodeUnavailable"));
    return;
  }
  if (options?.preferExisting) {
    const latest = latestNodeSession(node.id);
    if (latest) {
      activeSession.value = latest;
      closeRequested.value = false;
      return;
    }
  }
  await startSession(node);
}

async function startSession(node: Node) {
  if (starting.value) return;
  starting.value = true;
  closeRequested.value = false;
  try {
    const session = await api.terminal.create({
      node_id: node.id,
      shell: shell.value,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
    });
    activeSession.value = session;
    toast.success(t("operations.terminal.toastStarted"));
    sessionsQuery.refresh();
    // If the agent never attaches (e.g. the node was deployed without
    // -allow-terminal), the session stays pending forever. Surface a clear
    // hint instead of a silent hang.
    if (pendingHintTimer) clearTimeout(pendingHintTimer);
    pendingHintTimer = setTimeout(() => {
      const current = activeSession.value;
      if (current && current.status !== "open" && current.status !== "closed" && current.status !== "failed") {
        toast.info(t("operations.terminal.pendingHint"));
      }
    }, 12000);
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("operations.terminal.toastStartFailed"));
  } finally {
    starting.value = false;
  }
}

async function closeSession() {
  const session = activeSession.value;
  if (!session || closing.value) return;
  closing.value = true;
  closeRequested.value = true;
  try {
    const updated = await api.terminal.close(session.id);
    activeSession.value = updated;
    if (updated.status === "closed" || updated.status === "failed") {
      closeRequested.value = false;
      toast.success(t("operations.terminal.toastClosed"));
    } else {
      toast.success(t("operations.terminal.toastCloseRequested"));
    }
    sessionsQuery.refresh();
  } catch (error) {
    closeRequested.value = false;
    toast.error(error instanceof Error ? error.message : t("operations.terminal.toastCloseFailed"));
  } finally {
    closing.value = false;
  }
}

function onSessionUpdate(session: TerminalSession) {
  activeSession.value = session;
  if (session.status === "open" || session.status === "closed" || session.status === "failed") {
    if (pendingHintTimer) clearTimeout(pendingHintTimer);
  }
  if (session.status === "closed" || session.status === "failed") {
    closeRequested.value = false;
  }
}

function onSessionClosed(session: TerminalSession) {
  activeSession.value = session;
  closeRequested.value = false;
  sessionsQuery.refresh();
}

function onTerminalError(message: string) {
  if (message) toast.error(message);
}

function openSelectedInNewTab() {
  if (!selectedNodeId.value) return;
  const url = `/terminal?node_id=${encodeURIComponent(selectedNodeId.value)}&connect=1`;
  window.open(url, "_blank", "noopener");
}
</script>

<template>
  <div class="p-6 space-y-6">
    <PageHeader :title="$t('operations.terminal.title')" :description="$t('operations.terminal.description')">
      <template #status>
        <FreshnessLabel :last-updated="sessionsQuery.lastUpdated.value" />
      </template>
      <template #actions>
        <div class="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" :disabled="nodesQuery.refreshing.value || sessionsQuery.refreshing.value" @click="refreshAll">
            <RefreshCw :class="cn('size-4', (nodesQuery.refreshing.value || sessionsQuery.refreshing.value) && 'animate-spin')" aria-hidden="true" />
            {{ $t('common.actions.refresh') }}
          </Button>
          <Button v-if="selectedNode" variant="outline" size="sm" @click="openSelectedInNewTab">
            <ExternalLink class="size-4" aria-hidden="true" />
            {{ $t('operations.terminal.openNewTab') }}
          </Button>
          <Button
            :variant="streamingEnabled ? 'default' : 'outline'"
            size="sm"
            :title="$t('operations.terminal.streamingHint')"
            @click="toggleStreaming"
          >
            <Zap class="size-4" aria-hidden="true" />
            {{ $t('operations.terminal.streaming') }}
          </Button>
        </div>
      </template>
    </PageHeader>

    <div class="grid gap-5 xl:grid-cols-[320px_minmax(0,1fr)]">
      <aside class="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle class="flex items-center gap-2">
              <Server class="size-4 text-muted-foreground" aria-hidden="true" />
              {{ $t('operations.terminal.targets') }}
            </CardTitle>
            <CardDescription>{{ $t('operations.terminal.targetsHint') }}</CardDescription>
          </CardHeader>
          <CardContent class="space-y-3">
            <div class="relative">
              <Search class="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" aria-hidden="true" />
              <Input v-model="nodeSearch" class="pl-8" :placeholder="$t('operations.terminal.searchNodes')" />
            </div>

            <DataState
              :loading="nodesQuery.loading.value"
              :error="nodesQuery.error.value"
              :has-data="nodesQuery.data.value !== undefined"
              :is-empty="filteredNodes.length === 0"
              :empty-title="isNodeNoMatch ? $t('operations.terminal.noMatchTitle') : $t('operations.terminal.noNodesTitle')"
              :empty-description="isNodeNoMatch ? $t('operations.terminal.noMatchDescription') : $t('operations.terminal.noNodesDescription')"
              @retry="nodesQuery.refresh"
            >
              <div class="max-h-[58vh] space-y-2 overflow-auto pr-1">
                <button
                  v-for="node in filteredNodes"
                  :key="node.id"
                  type="button"
                  class="surface-interactive w-full rounded-md border border-border p-3 text-left text-sm"
                  :class="selectedNodeId === node.id && 'border-primary bg-primary/5'"
                  @click="selectNode(node)"
                >
                  <span class="flex items-start justify-between gap-2">
                    <span class="min-w-0">
                      <span class="block truncate font-medium">{{ node.name || node.id }}</span>
                      <span class="mt-1 block truncate font-mono text-xs text-muted-foreground">
                        {{ shortId(node.id, 14) }}
                      </span>
                    </span>
                    <Badge v-if="node.disabled" variant="secondary">{{ $t('common.status.disabled') }}</Badge>
                    <Badge v-else :variant="node.online ? 'success' : 'destructive'">
                      {{ node.online ? $t('common.status.online') : $t('common.status.offline') }}
                    </Badge>
                  </span>
                  <span class="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span v-if="node.public_ip || node.public_ipv6">{{ node.public_ip || node.public_ipv6 }}</span>
                    <span v-if="activeCount(node.id)" class="inline-flex items-center gap-1 text-primary">
                      <SquareTerminal class="size-3" aria-hidden="true" />
                      {{ $t('operations.terminal.activeSessions', { count: activeCount(node.id) }) }}
                    </span>
                  </span>
                </button>
              </div>
            </DataState>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{{ $t('operations.terminal.connection') }}</CardTitle>
            <CardDescription>{{ $t('operations.terminal.connectionHint') }}</CardDescription>
          </CardHeader>
          <CardContent class="space-y-4">
            <div class="grid gap-2">
              <label class="text-xs font-medium text-muted-foreground" for="terminal-shell">{{ $t('operations.terminal.shell') }}</label>
              <Select
                v-model="shell"
                :disabled="!!activeSession && activeSession.status !== 'closed' && activeSession.status !== 'failed'"
              >
                <SelectTrigger id="terminal-shell" class="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="sh">/bin/sh</SelectItem>
                  <SelectItem value="bash">bash</SelectItem>
                  <SelectItem value="/bin/zsh">zsh</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div class="grid gap-2 rounded-md border border-border p-3 text-sm">
              <div class="flex items-center justify-between gap-3">
                <span class="text-muted-foreground">{{ $t('operations.terminal.selectedNode') }}</span>
                <Badge v-if="selectedNode" :variant="isTerminalReady(selectedNode) ? 'success' : 'secondary'">
                  {{ isTerminalReady(selectedNode) ? $t('operations.terminal.ready') : $t('operations.terminal.unavailable') }}
                </Badge>
              </div>
              <div v-if="selectedNode" class="min-w-0">
                <p class="truncate font-medium">{{ selectedNode.name || selectedNode.id }}</p>
                <p class="truncate text-xs text-muted-foreground">{{ selectedNodeSubtitle || selectedNode.id }}</p>
              </div>
              <p v-else class="text-xs text-muted-foreground">{{ $t('operations.terminal.selectPrompt') }}</p>
            </div>

            <Button class="w-full" :disabled="starting || !selectedNode || !isTerminalReady(selectedNode)" @click="connectSelected({ preferExisting: false })">
              <RefreshCw v-if="starting" class="size-4 animate-spin" aria-hidden="true" />
              <Power v-else class="size-4" aria-hidden="true" />
              {{ $t('operations.terminal.connect') }}
            </Button>
            <Button
              v-if="selectedSessionCount > 0"
              class="w-full"
              variant="outline"
              :disabled="starting"
              @click="attachLatestForSelected"
            >
              <SquareTerminal class="size-4" aria-hidden="true" />
              {{ $t('operations.terminal.resumeLatest') }}
            </Button>
          </CardContent>
        </Card>
      </aside>

      <section class="min-w-0 space-y-4">
        <Card
          :class="cn(
            'overflow-hidden',
            fullscreen && 'fixed inset-0 z-50 flex flex-col rounded-none border-0 shadow-2xl',
          )"
        >
          <CardHeader class="border-b border-border" :class="fullscreen && 'shrink-0'">
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div class="min-w-0">
                <CardTitle class="flex min-w-0 items-center gap-2">
                  <SquareTerminal class="size-4 text-muted-foreground" aria-hidden="true" />
                  <span class="truncate">
                    {{ activeSession ? nodeName(activeSession.node_id) : (selectedNode?.name || $t('operations.terminal.console')) }}
                  </span>
                </CardTitle>
                <CardDescription class="mt-1">
                  <template v-if="activeSession">
                    {{ shortId(activeSession.id, 16) }} · {{ activeSession.shell || "/bin/sh" }}
                  </template>
                  <template v-else>{{ $t('operations.terminal.consoleHint') }}</template>
                </CardDescription>
              </div>
              <div class="flex flex-wrap items-center gap-2">
                <Badge :variant="statusVariant(activeSession?.status ?? 'idle')">
                  {{ closeRequested ? $t('operations.terminal.closing') : (activeSession?.status ?? 'idle') }}
                </Badge>
                <Badge v-if="activeSession?.bytes_out" variant="outline">{{ formatBytes(activeSession.bytes_out) }}</Badge>
                <Button
                  variant="outline"
                  size="sm"
                  :title="fullscreen ? $t('operations.terminal.exitFullscreen') : $t('operations.terminal.fullscreen')"
                  @click="toggleFullscreen"
                >
                  <Minimize2 v-if="fullscreen" class="size-4" aria-hidden="true" />
                  <Maximize2 v-else class="size-4" aria-hidden="true" />
                  <span class="sr-only sm:not-sr-only">{{ fullscreen ? $t('operations.terminal.exitFullscreen') : $t('operations.terminal.fullscreen') }}</span>
                </Button>
                <Button v-if="activeSession" variant="outline" size="sm" :disabled="closing || activeSession.status === 'closed' || activeSession.status === 'failed'" @click="closeSession">
                  <CircleStop class="size-4" aria-hidden="true" />
                  {{ $t('operations.terminal.close') }}
                </Button>
              </div>
            </div>
          </CardHeader>

          <CardContent class="p-0" :class="fullscreen && 'flex-1 min-h-0'">
            <div
              ref="consoleEl"
              class="bg-[#070a12]"
              :class="fullscreen ? 'h-full' : 'min-h-[360px]'"
              :style="fullscreen ? undefined : { height: consoleHeight + 'px' }"
            >
              <XtermSession
                v-if="activeSession"
                :key="activeSession.id + (streamingEnabled ? ':stream' : ':poll')"
                :session="activeSession"
                :disabled="terminalDisabled"
                :transport="streamingEnabled ? 'stream' : 'poll'"
                @update:session="onSessionUpdate"
                @closed="onSessionClosed"
                @error="onTerminalError"
              />
              <div v-else class="flex h-full items-center justify-center bg-muted/20 p-8">
                <EmptyState
                  :icon="SquareTerminal"
                  :title="$t('operations.terminal.emptyConsoleTitle')"
                  :description="$t('operations.terminal.emptyConsoleDescription')"
                >
                  <Button v-if="selectedNode && isTerminalReady(selectedNode)" :disabled="starting" @click="connectSelected({ preferExisting: true })">
                    <RefreshCw v-if="starting" class="size-4 animate-spin" aria-hidden="true" />
                    <Power v-else class="size-4" aria-hidden="true" />
                    {{ $t('operations.terminal.connect') }}
                  </Button>
                </EmptyState>
              </div>
            </div>
          </CardContent>
        </Card>

        <div v-if="activeSession && !fullscreen" class="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
          <span class="inline-flex items-center gap-1">
            <Wifi class="size-3" aria-hidden="true" />
            {{ activeSession.status }}
          </span>
          <span class="inline-flex items-center gap-1">
            <Clock class="size-3" aria-hidden="true" />
            {{ $t('common.misc.created') }} {{ formatDateTime(activeSession.created_at) }}
          </span>
          <span v-if="activeSession.last_seen" class="inline-flex items-center gap-1">
            <Activity class="size-3" aria-hidden="true" />
            {{ $t('common.misc.updated') }} {{ formatRelativeTime(activeSession.last_seen) }}
          </span>
        </div>
      </section>
    </div>
  </div>
</template>

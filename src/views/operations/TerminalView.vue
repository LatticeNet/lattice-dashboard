<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import {
  Activity,
  CircleStop,
  Clock,
  ExternalLink,
  Power,
  RefreshCw,
  Search,
  Server,
  SquareTerminal,
  Wifi,
} from "lucide-vue-next";
import { api, unwrap, type Node, type TerminalSession } from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { formatBytes, formatDateTime, formatRelativeTime, shortId } from "@/lib/format";
import { cn } from "@/lib/utils";

import PageHeader from "@/components/common/PageHeader.vue";
import DataState from "@/components/common/DataState.vue";
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

function statusVariant(status: string): "success" | "warning" | "destructive" | "secondary" {
  if (status === "open") return "success";
  if (status === "pending") return "warning";
  if (status === "failed") return "destructive";
  return "secondary";
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
              :is-empty="filteredNodes.length === 0"
              :empty-title="$t('operations.terminal.noNodesTitle')"
              :empty-description="$t('operations.terminal.noNodesDescription')"
              @retry="nodesQuery.refresh"
            >
              <div class="max-h-[58vh] space-y-2 overflow-auto pr-1">
                <button
                  v-for="node in filteredNodes"
                  :key="node.id"
                  type="button"
                  class="w-full rounded-md border border-border p-3 text-left text-sm transition-colors hover:bg-muted/35"
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
              <select
                id="terminal-shell"
                v-model="shell"
                class="h-9 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-ring/50 focus-visible:ring-[3px]"
                :disabled="!!activeSession && activeSession.status !== 'closed' && activeSession.status !== 'failed'"
              >
                <option value="sh">/bin/sh</option>
                <option value="bash">bash</option>
                <option value="/bin/zsh">zsh</option>
              </select>
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
        <Card class="overflow-hidden">
          <CardHeader class="border-b border-border">
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
                <Button v-if="activeSession" variant="outline" size="sm" :disabled="closing || activeSession.status === 'closed' || activeSession.status === 'failed'" @click="closeSession">
                  <CircleStop class="size-4" aria-hidden="true" />
                  {{ $t('operations.terminal.close') }}
                </Button>
              </div>
            </div>
          </CardHeader>

          <CardContent class="p-0">
            <div v-if="activeSession" class="h-[calc(100vh-230px)] min-h-[560px] bg-[#070a12]">
              <XtermSession
                :key="activeSession.id"
                :session="activeSession"
                :disabled="terminalDisabled"
                @update:session="onSessionUpdate"
                @closed="onSessionClosed"
                @error="onTerminalError"
              />
            </div>
            <div v-else class="flex min-h-[560px] items-center justify-center bg-muted/20 p-8">
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
          </CardContent>
        </Card>

        <div v-if="activeSession" class="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
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

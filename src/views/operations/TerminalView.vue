<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { useDocumentVisibility } from "@vueuse/core";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import {
  CircleStop,
  Keyboard,
  Power,
  RefreshCw,
  Send,
  SquareTerminal,
} from "lucide-vue-next";
import { api, unwrap, type Node, type TerminalEvent, type TerminalSession } from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { formatBytes, formatDateTime, shortId } from "@/lib/format";
import { cn } from "@/lib/utils";

import PageHeader from "@/components/common/PageHeader.vue";
import DataState from "@/components/common/DataState.vue";
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
import { Label } from "@/components/ui/label";

const EVENT_POLL_MS = 1000;
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;

const { t } = useI18n();
const visibility = useDocumentVisibility();

const nodesQuery = useAsyncData(() => api.nodes.list().then((r) => unwrap(r, "nodes")), {
  pollInterval: 10000,
});
const sessionsQuery = useAsyncData(() => api.terminal.list().then((r) => r.sessions), {
  pollInterval: 5000,
});

const selectedNodeId = ref("");
const activeSession = ref<TerminalSession | undefined>();
const output = ref<TerminalEvent[]>([]);
const cursor = ref(0);
const command = ref("");
const starting = ref(false);
const sending = ref(false);
const closing = ref(false);
const eventError = ref<string | undefined>();
const outputEl = ref<HTMLElement | null>(null);

let eventTimer: ReturnType<typeof setInterval> | undefined;

const nodes = computed(() => nodesQuery.data.value ?? []);
const onlineNodes = computed(() => nodes.value.filter((node) => node.online && !node.disabled));
const sessions = computed(() => sessionsQuery.data.value ?? []);
const sessionStatus = computed(() => activeSession.value?.status ?? "idle");
const canSend = computed(() => activeSession.value?.status === "open" && command.value.length > 0);
const terminalText = computed(() =>
  output.value.map((event) => event.data ?? "").join(""),
);

watch(
  onlineNodes,
  (list) => {
    if (selectedNodeId.value && list.some((node) => node.id === selectedNodeId.value)) return;
    selectedNodeId.value = list[0]?.id ?? "";
  },
  { immediate: true },
);

function nodeName(id: string): string {
  const node = nodes.value.find((candidate) => candidate.id === id);
  return node?.name || shortId(id, 14);
}

function nodeSubtitle(node: Node): string {
  return [node.public_ip || node.public_ipv6, node.agent_version].filter(Boolean).join(" · ");
}

function statusVariant(status: string): "success" | "warning" | "destructive" | "secondary" {
  if (status === "open") return "success";
  if (status === "pending") return "warning";
  if (status === "failed") return "destructive";
  return "secondary";
}

function refreshAll() {
  nodesQuery.refresh();
  sessionsQuery.refresh();
  if (activeSession.value) void pollEvents();
}

async function startSession() {
  if (!selectedNodeId.value) return;
  starting.value = true;
  eventError.value = undefined;
  try {
    const session = await api.terminal.create({
      node_id: selectedNodeId.value,
      shell: "sh",
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
    });
    activeSession.value = session;
    output.value = [];
    cursor.value = 0;
    command.value = "";
    startEventPolling();
    toast.success(t("operations.terminal.toastStarted"));
    sessionsQuery.refresh();
    await pollEvents();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("operations.terminal.toastStartFailed"));
  } finally {
    starting.value = false;
  }
}

function attachSession(session: TerminalSession) {
  activeSession.value = session;
  output.value = [];
  cursor.value = 0;
  eventError.value = undefined;
  startEventPolling();
  void pollEvents();
}

async function pollEvents() {
  const session = activeSession.value;
  if (!session || visibility.value === "hidden") return;
  try {
    const res = await api.terminal.events(session.id, cursor.value);
    activeSession.value = res.session;
    if (res.events.length > 0) {
      output.value.push(...res.events);
      cursor.value = Math.max(cursor.value, ...res.events.map((event) => event.seq));
      await nextTick();
      if (outputEl.value) outputEl.value.scrollTop = outputEl.value.scrollHeight;
    }
    eventError.value = undefined;
  } catch (error) {
    eventError.value = error instanceof Error ? error.message : t("operations.terminal.eventsFailed");
  }
}

function startEventPolling() {
  if (eventTimer) clearInterval(eventTimer);
  eventTimer = setInterval(() => void pollEvents(), EVENT_POLL_MS);
}

async function sendInput(data: string) {
  const session = activeSession.value;
  if (!session || session.status !== "open" || sending.value) return;
  sending.value = true;
  try {
    activeSession.value = await api.terminal.input(session.id, data);
    await pollEvents();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("operations.terminal.toastSendFailed"));
  } finally {
    sending.value = false;
  }
}

async function sendCommand() {
  if (!canSend.value) return;
  const data = command.value.endsWith("\n") ? command.value : `${command.value}\n`;
  command.value = "";
  await sendInput(data);
}

async function sendCtrlC() {
  await sendInput("\u0003");
}

async function closeSession() {
  const session = activeSession.value;
  if (!session || closing.value) return;
  closing.value = true;
  try {
    activeSession.value = await api.terminal.close(session.id);
    await pollEvents();
    toast.success(t("operations.terminal.toastClosed"));
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("operations.terminal.toastCloseFailed"));
  } finally {
    closing.value = false;
  }
}

function onCommandKeydown(event: KeyboardEvent) {
  if (event.key !== "Enter" || event.shiftKey) return;
  event.preventDefault();
  void sendCommand();
}

onBeforeUnmount(() => {
  if (eventTimer) clearInterval(eventTimer);
});
</script>

<template>
  <div class="p-6 space-y-6">
    <PageHeader :title="$t('operations.terminal.title')" :description="$t('operations.terminal.description')">
      <template #actions>
        <Button variant="outline" size="sm" :disabled="nodesQuery.refreshing.value || sessionsQuery.refreshing.value" @click="refreshAll">
          <RefreshCw :class="cn('size-4', (nodesQuery.refreshing.value || sessionsQuery.refreshing.value) && 'animate-spin')" aria-hidden="true" />
          {{ $t('common.actions.refresh') }}
        </Button>
      </template>
    </PageHeader>

    <div class="grid gap-4 lg:grid-cols-[320px_1fr]">
      <div class="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle class="flex items-center gap-2">
              <SquareTerminal class="size-4 text-muted-foreground" aria-hidden="true" />
              {{ $t('operations.terminal.newSession') }}
            </CardTitle>
            <CardDescription>{{ $t('operations.terminal.newSessionHint') }}</CardDescription>
          </CardHeader>
          <CardContent class="space-y-4">
            <DataState
              :loading="nodesQuery.loading.value"
              :error="nodesQuery.error.value"
              :is-empty="onlineNodes.length === 0"
              :empty-title="$t('operations.terminal.noNodesTitle')"
              :empty-description="$t('operations.terminal.noNodesDescription')"
              @retry="nodesQuery.refresh"
            >
              <div class="space-y-2">
                <label
                  v-for="node in onlineNodes"
                  :key="node.id"
                  class="flex cursor-pointer items-start gap-3 rounded-md border border-border p-3 text-sm transition-colors hover:bg-muted/40"
                  :class="selectedNodeId === node.id && 'border-primary bg-primary/5'"
                >
                  <input v-model="selectedNodeId" type="radio" :value="node.id" class="mt-1 size-4 accent-primary" />
                  <span class="min-w-0 flex-1">
                    <span class="block truncate font-medium">{{ node.name || node.id }}</span>
                    <span class="block truncate text-xs text-muted-foreground">{{ nodeSubtitle(node) || node.id }}</span>
                  </span>
                  <Badge variant="success">{{ $t('operations.terminal.online') }}</Badge>
                </label>
              </div>
            </DataState>

            <Button class="w-full" :disabled="starting || !selectedNodeId" @click="startSession">
              <RefreshCw v-if="starting" class="size-4 animate-spin" aria-hidden="true" />
              <Power v-else class="size-4" aria-hidden="true" />
              {{ $t('operations.terminal.connect') }}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{{ $t('operations.terminal.sessions') }}</CardTitle>
            <CardDescription>{{ $t('operations.terminal.sessionsHint') }}</CardDescription>
          </CardHeader>
          <CardContent>
            <DataState
              :loading="sessionsQuery.loading.value"
              :error="sessionsQuery.error.value"
              :is-empty="sessions.length === 0"
              :empty-title="$t('operations.terminal.noSessionsTitle')"
              :empty-description="$t('operations.terminal.noSessionsDescription')"
              @retry="sessionsQuery.refresh"
            >
              <div class="space-y-2">
                <button
                  v-for="session in sessions"
                  :key="session.id"
                  type="button"
                  class="w-full rounded-md border border-border p-3 text-left text-sm transition-colors hover:bg-muted/40"
                  :class="activeSession?.id === session.id && 'border-primary bg-primary/5'"
                  @click="attachSession(session)"
                >
                  <span class="flex items-center justify-between gap-2">
                    <span class="font-medium">{{ nodeName(session.node_id) }}</span>
                    <Badge :variant="statusVariant(session.status)">{{ session.status }}</Badge>
                  </span>
                  <span class="mt-1 block text-xs text-muted-foreground">
                    {{ shortId(session.id, 12) }} · {{ formatDateTime(session.created_at) }}
                  </span>
                </button>
              </div>
            </DataState>
          </CardContent>
        </Card>
      </div>

      <Card class="min-h-[620px]">
        <CardHeader class="border-b border-border">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle class="flex items-center gap-2">
                <Keyboard class="size-4 text-muted-foreground" aria-hidden="true" />
                {{ activeSession ? nodeName(activeSession.node_id) : $t('operations.terminal.console') }}
              </CardTitle>
              <CardDescription>
                <span v-if="activeSession">
                  {{ shortId(activeSession.id, 14) }} · {{ activeSession.shell || "/bin/sh" }}
                </span>
                <span v-else>{{ $t('operations.terminal.consoleHint') }}</span>
              </CardDescription>
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <Badge :variant="statusVariant(sessionStatus)">{{ sessionStatus }}</Badge>
              <Badge v-if="activeSession?.bytes_out" variant="outline">{{ formatBytes(activeSession.bytes_out) }}</Badge>
              <Button v-if="activeSession" variant="outline" size="sm" :disabled="closing" @click="closeSession">
                <CircleStop class="size-4" aria-hidden="true" />
                {{ $t('operations.terminal.close') }}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent class="space-y-4 p-4">
          <div
            ref="outputEl"
            class="h-[420px] overflow-auto rounded-md border border-border bg-zinc-950 p-4 font-mono text-[13px] leading-relaxed text-zinc-100"
          >
            <pre v-if="terminalText" class="whitespace-pre-wrap break-words">{{ terminalText }}</pre>
            <div v-else class="flex h-full items-center justify-center text-sm text-zinc-400">
              {{ activeSession ? $t('operations.terminal.waiting') : $t('operations.terminal.selectPrompt') }}
            </div>
          </div>

          <div v-if="eventError" class="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            {{ eventError }}
          </div>
          <div v-else-if="activeSession?.status === 'pending'" class="rounded-md border border-warning/30 bg-warning/10 p-3 text-sm text-warning-foreground">
            {{ $t('operations.terminal.pendingHint') }}
          </div>
          <div v-else-if="activeSession?.error" class="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            {{ activeSession.error }}
          </div>

          <div class="grid gap-2">
            <Label for="terminal-command">{{ $t('operations.terminal.input') }}</Label>
            <div class="flex gap-2">
              <Input
                id="terminal-command"
                v-model="command"
                class="font-mono"
                :placeholder="$t('operations.terminal.inputPlaceholder')"
                :disabled="activeSession?.status !== 'open'"
                @keydown="onCommandKeydown"
              />
              <Button :disabled="!canSend || sending" @click="sendCommand">
                <Send class="size-4" aria-hidden="true" />
                {{ $t('operations.terminal.send') }}
              </Button>
              <Button variant="outline" :disabled="activeSession?.status !== 'open' || sending" @click="sendCtrlC">
                ^C
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  </div>
</template>

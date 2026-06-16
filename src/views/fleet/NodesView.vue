<script setup lang="ts">
import { computed, ref } from "vue";
import { toast } from "vue-sonner";
import {
  Activity,
  AlertTriangle,
  Cpu,
  HardDrive,
  KeyRound,
  MemoryStick,
  Plus,
  Power,
  RefreshCw,
  RotateCw,
  Server,
  Wifi,
} from "lucide-vue-next";
import { api, unwrap, type EnrollTokenResponse, type Node } from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { useAuthStore } from "@/stores/auth";
import {
  formatBytes,
  formatBytesPerSec,
  formatDateTime,
  formatDuration,
  formatPercent,
  formatRelativeTime,
  ratio,
  shortId,
} from "@/lib/format";
import { cn } from "@/lib/utils";

import PageHeader from "@/components/common/PageHeader.vue";
import StatusDot from "@/components/common/StatusDot.vue";
import MetricBar from "@/components/common/MetricBar.vue";
import DataState from "@/components/common/DataState.vue";
import CopyButton from "@/components/common/CopyButton.vue";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const auth = useAuthStore();
const nodesQuery = useAsyncData(() => api.nodes.list().then((r) => unwrap(r, "nodes")), {
  pollInterval: 5000,
});

const enrollName = ref("");
const enrollId = ref("");
const enrollRole = ref("");
const enrollTags = ref("");
const enrollWireGuardIp = ref("");
const enrollPending = ref(false);
const enrollResult = ref<EnrollTokenResponse | undefined>();

const selectedNode = ref<Node | undefined>();
const pendingNode = ref<string | undefined>();
const rotatedToken = ref<{ node_id: string; token: string } | undefined>();

const nodes = computed(() => nodesQuery.data.value ?? []);
const onlineCount = computed(() => nodes.value.filter((n) => n.online && !n.disabled).length);
const disabledCount = computed(() => nodes.value.filter((n) => n.disabled).length);
const canAdminNodes = computed(() => auth.can("node:admin"));

const sortedNodes = computed(() =>
  [...nodes.value].sort((a, b) => {
    if (!!a.disabled !== !!b.disabled) return a.disabled ? 1 : -1;
    if (a.online !== b.online) return a.online ? -1 : 1;
    return (a.name || a.id).localeCompare(b.name || b.id);
  }),
);

function parseTags(): string[] {
  return enrollTags.value
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

async function enrollNode() {
  if (!enrollName.value.trim()) return;
  enrollPending.value = true;
  enrollResult.value = undefined;
  try {
    enrollResult.value = await api.nodes.enrollToken({
      node_id: enrollId.value.trim() || undefined,
      name: enrollName.value.trim(),
      role: enrollRole.value.trim() || undefined,
      tags: parseTags(),
      wireguard_ip: enrollWireGuardIp.value.trim() || undefined,
    });
    enrollName.value = "";
    enrollId.value = "";
    enrollRole.value = "";
    enrollTags.value = "";
    enrollWireGuardIp.value = "";
    toast.success("Enrollment token created");
    nodesQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "Enrollment failed");
  } finally {
    enrollPending.value = false;
  }
}

async function rotateToken(node: Node) {
  pendingNode.value = node.id;
  rotatedToken.value = undefined;
  try {
    rotatedToken.value = await api.nodes.rotateToken(node.id);
    toast.success("Node token rotated");
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "Token rotation failed");
  } finally {
    pendingNode.value = undefined;
  }
}

async function setDisabled(node: Node, disabled: boolean) {
  pendingNode.value = node.id;
  try {
    await api.nodes.disable(node.id, disabled);
    toast.success(disabled ? "Node disabled" : "Node enabled");
    nodesQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "Node update failed");
  } finally {
    pendingNode.value = undefined;
  }
}

function closeDetail(open: boolean) {
  if (!open) selectedNode.value = undefined;
}
</script>

<template>
  <div class="p-6 space-y-6">
    <PageHeader title="Nodes" description="Enroll, inspect, and administer fleet nodes">
      <template #actions>
        <Button variant="outline" size="sm" :disabled="nodesQuery.refreshing.value" @click="nodesQuery.refresh">
          <RotateCw :class="cn('size-4', nodesQuery.refreshing.value && 'animate-spin')" />
          Refresh
        </Button>
      </template>
    </PageHeader>

    <div class="grid gap-4 md:grid-cols-3">
      <Card>
        <CardContent class="flex items-center justify-between p-4">
          <div>
            <p class="text-sm text-muted-foreground">Total</p>
            <p class="text-2xl font-semibold">{{ nodes.length }}</p>
          </div>
          <Server class="size-5 text-muted-foreground" />
        </CardContent>
      </Card>
      <Card>
        <CardContent class="flex items-center justify-between p-4">
          <div>
            <p class="text-sm text-muted-foreground">Online</p>
            <p class="text-2xl font-semibold text-success">{{ onlineCount }}</p>
          </div>
          <Wifi class="size-5 text-success" />
        </CardContent>
      </Card>
      <Card>
        <CardContent class="flex items-center justify-between p-4">
          <div>
            <p class="text-sm text-muted-foreground">Disabled</p>
            <p class="text-2xl font-semibold text-muted-foreground">{{ disabledCount }}</p>
          </div>
          <Power class="size-5 text-muted-foreground" />
        </CardContent>
      </Card>
    </div>

    <Card v-if="canAdminNodes">
      <CardHeader>
        <CardTitle class="flex items-center gap-2">
          <Plus class="size-4 text-muted-foreground" />
          Enroll Node
        </CardTitle>
        <CardDescription>Create a one-time node enrollment token and install command.</CardDescription>
      </CardHeader>
      <CardContent class="space-y-4">
        <form class="grid gap-3 lg:grid-cols-[1.2fr_1fr_0.7fr_1fr_1fr_auto]" @submit.prevent="enrollNode">
          <div class="grid gap-2">
            <Label for="enroll-name">Name</Label>
            <Input id="enroll-name" v-model="enrollName" required />
          </div>
          <div class="grid gap-2">
            <Label for="enroll-id">Node ID</Label>
            <Input id="enroll-id" v-model="enrollId" placeholder="optional" />
          </div>
          <div class="grid gap-2">
            <Label for="enroll-role">Role</Label>
            <Input id="enroll-role" v-model="enrollRole" placeholder="edge" />
          </div>
          <div class="grid gap-2">
            <Label for="enroll-tags">Tags</Label>
            <Input id="enroll-tags" v-model="enrollTags" placeholder="prod, us-east" />
          </div>
          <div class="grid gap-2">
            <Label for="enroll-wg">WireGuard IP</Label>
            <Input id="enroll-wg" v-model="enrollWireGuardIp" placeholder="optional" />
          </div>
          <div class="flex items-end">
            <Button type="submit" :disabled="enrollPending || !enrollName.trim()">
              <RefreshCw v-if="enrollPending" class="size-4 animate-spin" />
              <Plus v-else class="size-4" />
              Enroll
            </Button>
          </div>
        </form>

        <div v-if="enrollResult" class="grid gap-3 rounded-md border border-success/40 bg-success/5 p-4">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p class="text-sm font-medium">Enrollment token for {{ enrollResult.node_id }}</p>
              <p class="text-xs text-muted-foreground">Copy it now. Rotating the token will invalidate this value.</p>
            </div>
            <CopyButton :value="enrollResult.command || enrollResult.token" label="Copy command" />
          </div>
          <code class="block overflow-x-auto whitespace-pre-wrap rounded-md bg-background/70 p-3 font-mono text-xs">
            {{ enrollResult.command || enrollResult.token }}
          </code>
        </div>

        <div v-if="rotatedToken" class="grid gap-3 rounded-md border border-warning/40 bg-warning/5 p-4">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p class="text-sm font-medium">Rotated token for {{ rotatedToken.node_id }}</p>
              <p class="text-xs text-muted-foreground">Update the agent with this token before rotating again.</p>
            </div>
            <CopyButton :value="rotatedToken.token" label="Copy token" />
          </div>
          <code class="block overflow-x-auto whitespace-pre-wrap rounded-md bg-background/70 p-3 font-mono text-xs">
            {{ rotatedToken.token }}
          </code>
        </div>
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <CardTitle>Fleet</CardTitle>
        <CardDescription>{{ onlineCount }} of {{ nodes.length }} active nodes online</CardDescription>
      </CardHeader>
      <CardContent>
        <DataState
          :loading="nodesQuery.loading.value"
          :error="nodesQuery.error.value"
          :is-empty="nodes.length === 0"
          empty-title="No nodes enrolled yet"
          empty-description="Create an enrollment token to add the first node."
          @retry="nodesQuery.refresh"
        >
          <div class="grid gap-3 xl:grid-cols-2">
            <div
              v-for="node in sortedNodes"
              :key="node.id"
              :class="cn('rounded-lg border border-border p-4 transition-colors hover:bg-muted/30', node.disabled && 'opacity-60')"
            >
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0">
                  <button
                    type="button"
                    class="flex min-w-0 items-center gap-2 text-left font-medium hover:text-primary"
                    @click="selectedNode = node"
                  >
                    <StatusDot :active="node.online && !node.disabled" :pulse="node.online && !node.disabled" />
                    <span class="truncate">{{ node.name || node.id }}</span>
                  </button>
                  <p class="mt-1 font-mono text-xs text-muted-foreground">
                    {{ shortId(node.id, 16) }} · last seen {{ formatRelativeTime(node.last_seen) }}
                  </p>
                </div>
                <div class="flex flex-wrap justify-end gap-1">
                  <Badge v-if="node.disabled" variant="secondary">disabled</Badge>
                  <Badge v-else :variant="node.online ? 'success' : 'destructive'">
                    {{ node.online ? "online" : "offline" }}
                  </Badge>
                  <Badge v-if="node.role" variant="outline">{{ node.role }}</Badge>
                </div>
              </div>

              <div class="mt-4 grid gap-2">
                <MetricBar label="CPU" :icon="Cpu" :percent="node.metrics?.cpu_percent ?? 0" :value-text="formatPercent(node.metrics?.cpu_percent)" />
                <MetricBar label="Memory" :icon="MemoryStick" tone="memory" :percent="ratio(node.metrics?.memory_used, node.metrics?.memory_total)" :used="node.metrics?.memory_used" :total="node.metrics?.memory_total" />
                <MetricBar label="Disk" :icon="HardDrive" tone="disk" :percent="ratio(node.metrics?.disk_used, node.metrics?.disk_total)" :used="node.metrics?.disk_used" :total="node.metrics?.disk_total" />
              </div>

              <div class="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span class="inline-flex items-center gap-1"><Activity class="size-3" />{{ formatDuration(node.metrics?.uptime_seconds) }}</span>
                <span>{{ formatBytesPerSec(node.metrics?.net_rx_speed) }} down</span>
                <span>{{ formatBytesPerSec(node.metrics?.net_tx_speed) }} up</span>
              </div>

              <div v-if="canAdminNodes" class="mt-4 flex flex-wrap gap-2">
                <Button size="sm" variant="outline" :disabled="pendingNode === node.id" @click="rotateToken(node)">
                  <KeyRound class="size-4" />
                  Rotate token
                </Button>
                <Button
                  size="sm"
                  :variant="node.disabled ? 'outline' : 'destructive'"
                  :disabled="pendingNode === node.id"
                  @click="setDisabled(node, !node.disabled)"
                >
                  <Power class="size-4" />
                  {{ node.disabled ? "Enable" : "Disable" }}
                </Button>
              </div>
            </div>
          </div>
        </DataState>
      </CardContent>
    </Card>

    <Dialog :open="!!selectedNode" @update:open="closeDetail">
      <DialogContent class="max-h-[88vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{{ selectedNode?.name || selectedNode?.id }}</DialogTitle>
          <DialogDescription>
            {{ selectedNode?.id }} · {{ selectedNode?.online ? "online" : "offline" }}
          </DialogDescription>
        </DialogHeader>
        <div v-if="selectedNode" class="space-y-5">
          <div class="grid gap-3 sm:grid-cols-2">
            <div class="rounded-md border border-border p-3">
              <p class="text-xs font-medium uppercase text-muted-foreground">Agent</p>
              <p class="mt-1 text-sm">{{ selectedNode.agent_version || "unknown" }}</p>
            </div>
            <div class="rounded-md border border-border p-3">
              <p class="text-xs font-medium uppercase text-muted-foreground">Last seen</p>
              <p class="mt-1 text-sm">{{ formatDateTime(selectedNode.last_seen) }}</p>
            </div>
            <div class="rounded-md border border-border p-3">
              <p class="text-xs font-medium uppercase text-muted-foreground">Public IP</p>
              <p class="mt-1 font-mono text-sm">{{ selectedNode.public_ip || selectedNode.public_ipv6 || "unknown" }}</p>
            </div>
            <div class="rounded-md border border-border p-3">
              <p class="text-xs font-medium uppercase text-muted-foreground">WireGuard</p>
              <p class="mt-1 font-mono text-sm">{{ selectedNode.wireguard_ip || "not set" }}</p>
            </div>
          </div>

          <div v-if="selectedNode.host_facts" class="space-y-3">
            <h3 class="text-sm font-medium">Host facts</h3>
            <div class="grid gap-2 sm:grid-cols-2">
              <div class="rounded-md bg-muted/40 p-3 text-sm">OS: {{ selectedNode.host_facts.os || "unknown" }}</div>
              <div class="rounded-md bg-muted/40 p-3 text-sm">Arch: {{ selectedNode.host_facts.arch || "unknown" }}</div>
              <div class="rounded-md bg-muted/40 p-3 text-sm">CPU: {{ selectedNode.host_facts.cpu_cores || "?" }} cores</div>
              <div class="rounded-md bg-muted/40 p-3 text-sm">Memory: {{ formatBytes(selectedNode.host_facts.memory_total) }}</div>
              <div class="rounded-md bg-muted/40 p-3 text-sm sm:col-span-2">Kernel: {{ selectedNode.host_facts.kernel || "unknown" }}</div>
            </div>
          </div>

          <div v-else class="flex items-center gap-2 rounded-md border border-border p-3 text-sm text-muted-foreground">
            <AlertTriangle class="size-4" />
            Host facts have not been reported yet.
          </div>
        </div>
      </DialogContent>
    </Dialog>
  </div>
</template>

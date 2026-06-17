<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { RouterLink } from "vue-router";
import { toast } from "vue-sonner";
import {
  ExternalLink,
  Network,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-vue-next";
import {
  api,
  unwrap,
  type ApprovalView,
  type NetEndpointKind,
  type NetPolicyGraph,
  type NetPolicyUpsertRequest,
  type NetPolicyView,
  type NetRule,
  type NetRuleAction,
  type NetRuleDirection,
  type NetRuleProtocol,
} from "@/lib/api";
import { sha256Hex } from "@/lib/crypto";
import { useAsyncData } from "@/composables/useAsyncData";
import { useAuthStore } from "@/stores/auth";
import { formatDateTime, shortId } from "@/lib/format";
import { cn } from "@/lib/utils";

import PageHeader from "@/components/common/PageHeader.vue";
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
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogScrollContent,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const auth = useAuthStore();
const canRead = computed(() => auth.can("netpolicy:read"));
const canAdmin = computed(() => auth.can("netpolicy:admin"));

const tab = ref<"policies" | "graph">("policies");

const policiesQuery = useAsyncData(() => api.netpolicy.list().then((r) => unwrap(r, "policies")), {
  pollInterval: 15000,
});
const nodesQuery = useAsyncData(() => api.nodes.list().then((r) => unwrap(r, "nodes")), {
  pollInterval: 0,
});
const graphQuery = useAsyncData(() => api.netpolicy.graph(), { immediate: false });

const policies = computed(() => policiesQuery.data.value ?? []);
const nodes = computed(() => nodesQuery.data.value ?? []);

const sortedPolicies = computed(() =>
  [...policies.value].sort((a, b) =>
    (a.target_node_name || a.target_node_id).localeCompare(b.target_node_name || b.target_node_id),
  ),
);

function policyNodeLabel(p: NetPolicyView): string {
  return p.target_node_name || p.target_node_id;
}

function nodeName(id: string): string {
  return nodes.value.find((n) => n.id === id)?.name || shortId(id, 14);
}

function activeRuleCount(p: NetPolicyView): number {
  return p.rules.filter((r) => !r.disabled).length;
}

function loadGraph() {
  if (graphQuery.data.value === undefined && !graphQuery.loading.value) graphQuery.refresh();
}

function onTabChange(value: string | number) {
  const next = String(value) as "policies" | "graph";
  tab.value = next;
  if (next === "graph") loadGraph();
}

// ── Rules editor model ────────────────────────────────────────────────────
interface RuleDraft {
  action: NetRuleAction;
  direction: NetRuleDirection;
  protocol: NetRuleProtocol;
  ports: string;
  remoteKind: NetEndpointKind;
  remoteNodeId: string;
  remoteCidr: string;
  remoteDomain: string;
  comment: string;
  disabled: boolean;
}

function emptyRule(): RuleDraft {
  return {
    action: "allow",
    direction: "egress",
    protocol: "tcp",
    ports: "",
    remoteKind: "any",
    remoteNodeId: "",
    remoteCidr: "",
    remoteDomain: "",
    comment: "",
    disabled: false,
  };
}

function ruleToDraft(rule: NetRule): RuleDraft {
  return {
    action: rule.action,
    direction: rule.direction,
    protocol: rule.protocol,
    ports: (rule.ports ?? []).join(", "),
    remoteKind: rule.remote.kind,
    remoteNodeId: rule.remote.node_id ?? "",
    remoteCidr: rule.remote.cidr ?? "",
    remoteDomain: rule.remote.domain ?? "",
    comment: rule.comment ?? "",
    disabled: !!rule.disabled,
  };
}

function parsePorts(input: string): number[] {
  const set = new Set<number>();
  for (const piece of input.split(",")) {
    const trimmed = piece.trim();
    if (!trimmed) continue;
    const value = Number(trimmed);
    if (Number.isInteger(value) && value >= 1 && value <= 65535) set.add(value);
  }
  return [...set].sort((a, b) => a - b);
}

// ── Create / edit dialog ──────────────────────────────────────────────────
const dialogOpen = ref(false);
const editingId = ref<string | undefined>(undefined);
const saving = ref(false);
const form = reactive<{ target_node_id: string; enabled: boolean; rules: RuleDraft[] }>({
  target_node_id: "",
  enabled: true,
  rules: [],
});

function openCreate() {
  editingId.value = undefined;
  form.target_node_id = "";
  form.enabled = true;
  form.rules = [emptyRule()];
  dialogOpen.value = true;
}

function openEdit(p: NetPolicyView) {
  editingId.value = p.target_node_id;
  form.target_node_id = p.target_node_id;
  form.enabled = p.enabled;
  form.rules = p.rules.length ? p.rules.map(ruleToDraft) : [emptyRule()];
  dialogOpen.value = true;
}

function addRule() {
  form.rules.push(emptyRule());
}

function removeRule(index: number) {
  form.rules.splice(index, 1);
}

/** domain remotes are egress-only; clear protocol ports when protocol=any. */
function ruleError(draft: RuleDraft): string | undefined {
  if (draft.remoteKind === "domain" && draft.direction === "ingress") {
    return "domain remotes are egress-only";
  }
  if (draft.remoteKind === "node" && !draft.remoteNodeId) return "select a node";
  if (draft.remoteKind === "cidr" && !draft.remoteCidr.trim()) return "enter a CIDR";
  if (draft.remoteKind === "domain" && !draft.remoteDomain.trim()) return "enter a domain";
  if (draft.protocol === "any" && parsePorts(draft.ports).length > 0) {
    return "protocol any cannot carry ports";
  }
  return undefined;
}

const formErrors = computed(() => form.rules.map(ruleError));
const hasRuleErrors = computed(() => formErrors.value.some((e) => e !== undefined));
const canSubmit = computed(
  () => canAdmin.value && !!form.target_node_id && !hasRuleErrors.value,
);

function draftToRule(draft: RuleDraft, index: number): NetRule {
  return {
    id: `rule_${String(index + 1).padStart(3, "0")}`,
    action: draft.action,
    direction: draft.direction,
    protocol: draft.protocol,
    ports: draft.protocol === "any" ? [] : parsePorts(draft.ports),
    remote: {
      kind: draft.remoteKind,
      ...(draft.remoteKind === "node" ? { node_id: draft.remoteNodeId } : {}),
      ...(draft.remoteKind === "cidr" ? { cidr: draft.remoteCidr.trim() } : {}),
      ...(draft.remoteKind === "domain" ? { domain: draft.remoteDomain.trim() } : {}),
    },
    ...(draft.comment.trim() ? { comment: draft.comment.trim() } : {}),
    ...(draft.disabled ? { disabled: true } : {}),
  };
}

async function submit() {
  if (!canSubmit.value) return;
  saving.value = true;
  try {
    const body: NetPolicyUpsertRequest = {
      target_node_id: form.target_node_id,
      enabled: form.enabled,
      rules: form.rules.map(draftToRule),
    };
    await api.netpolicy.upsert(body);
    toast.success(editingId.value ? "Policy updated" : "Policy created");
    dialogOpen.value = false;
    policiesQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "Failed to save policy");
  } finally {
    saving.value = false;
  }
}

// ── Delete confirm ────────────────────────────────────────────────────────
const deleteTarget = ref<NetPolicyView | undefined>(undefined);
const deleting = ref(false);

async function confirmDelete() {
  if (!deleteTarget.value) return;
  deleting.value = true;
  try {
    await api.netpolicy.delete(deleteTarget.value.target_node_id);
    toast.success("Policy deleted");
    deleteTarget.value = undefined;
    policiesQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "Failed to delete policy");
  } finally {
    deleting.value = false;
  }
}

// ── Plan dialog ───────────────────────────────────────────────────────────
const planning = ref<string | undefined>(undefined);
const planApproval = ref<ApprovalView | undefined>(undefined);
const planSha = ref("");

async function plan(p: NetPolicyView) {
  if (!canAdmin.value) return;
  planning.value = p.target_node_id;
  try {
    const approval = await api.netpolicy.plan(p.target_node_id);
    planApproval.value = approval;
    planSha.value = await sha256Hex(approval.plan || "");
    toast.success("Plan created — review in Approvals");
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "Plan failed");
  } finally {
    planning.value = undefined;
  }
}

function closePlan(open: boolean) {
  if (!open) {
    planApproval.value = undefined;
    planSha.value = "";
  }
}

// ── Topology graph (CSP-safe inline SVG, circular layout) ─────────────────
const GRAPH_SIZE = 640;
const GRAPH_CENTER = GRAPH_SIZE / 2;
const GRAPH_RADIUS = 220;
const NODE_RADIUS = 26;

interface PlacedNode {
  id: string;
  name: string;
  online: boolean;
  x: number;
  y: number;
}

const graph = computed<NetPolicyGraph | undefined>(() => graphQuery.data.value);

const placedNodes = computed<PlacedNode[]>(() => {
  const list = graph.value?.nodes ?? [];
  const count = Math.max(1, list.length);
  return list.map((node, index) => {
    const angle = (index / count) * Math.PI * 2 - Math.PI / 2;
    return {
      id: node.id,
      name: node.name || node.id,
      online: node.online,
      x: GRAPH_CENTER + GRAPH_RADIUS * Math.cos(angle),
      y: GRAPH_CENTER + GRAPH_RADIUS * Math.sin(angle),
    };
  });
});

const nodePosById = computed<Record<string, PlacedNode>>(() => {
  const map: Record<string, PlacedNode> = {};
  for (const node of placedNodes.value) map[node.id] = node;
  return map;
});

interface DrawnEdge {
  key: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  allow: boolean;
  label: string;
}

/** Shorten an edge so its endpoint sits on the node ring (so arrows are visible). */
function trimToRing(
  from: PlacedNode,
  to: PlacedNode,
): { x1: number; y1: number; x2: number; y2: number } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy) || 1;
  const ux = dx / dist;
  const uy = dy / dist;
  return {
    x1: from.x + ux * NODE_RADIUS,
    y1: from.y + uy * NODE_RADIUS,
    x2: to.x - ux * (NODE_RADIUS + 6),
    y2: to.y - uy * (NODE_RADIUS + 6),
  };
}

const drawnEdges = computed<DrawnEdge[]>(() => {
  const edges = graph.value?.edges ?? [];
  const out: DrawnEdge[] = [];
  for (const edge of edges) {
    const from = nodePosById.value[edge.from];
    const to = nodePosById.value[edge.to];
    if (!from || !to || from.id === to.id) continue;
    const seg = trimToRing(from, to);
    const portLabel = edge.ports?.length ? `:${edge.ports.join(",")}` : "";
    out.push({
      key: `${edge.rule_id}:${edge.from}->${edge.to}`,
      ...seg,
      allow: edge.action === "allow",
      label: `${edge.protocol}${portLabel}`,
    });
  }
  return out;
});

const externals = computed(() => graph.value?.externals ?? []);
const hasGraphEdges = computed(() => drawnEdges.value.length > 0);
</script>

<template>
  <div class="p-6 space-y-6">
    <PageHeader
      title="Network Policy"
      description="Per-node L3/L4 network intent compiled into nftables, plus a topology view"
    >
      <template #actions>
        <Button
          variant="outline"
          size="sm"
          :disabled="policiesQuery.refreshing.value"
          @click="policiesQuery.refresh"
        >
          <RefreshCw :class="cn('size-4', policiesQuery.refreshing.value && 'animate-spin')" aria-hidden="true" />
          Refresh
        </Button>
        <Button v-if="canAdmin" size="sm" @click="openCreate">
          <Plus class="size-4" aria-hidden="true" />
          New policy
        </Button>
      </template>
    </PageHeader>

    <Tabs :model-value="tab" @update:model-value="onTabChange">
      <TabsList>
        <TabsTrigger value="policies">Policies</TabsTrigger>
        <TabsTrigger value="graph">Topology graph</TabsTrigger>
      </TabsList>

      <!-- Policies tab -->
      <TabsContent value="policies" class="mt-4">
        <Card>
          <CardHeader>
            <CardTitle class="flex items-center gap-2">
              <Network class="size-4 text-muted-foreground" aria-hidden="true" />
              Node policies
            </CardTitle>
            <CardDescription>
              Each policy is an ordered set of allow/deny L3/L4 rules for one target node.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <DataState
              :loading="policiesQuery.loading.value"
              :error="policiesQuery.error.value"
              :is-empty="policies.length === 0"
              empty-title="No network policies"
              :empty-description="canRead ? 'Create a policy to control egress and ingress for a node.' : 'netpolicy:read is required to view policies.'"
              @retry="policiesQuery.refresh"
            >
              <div class="overflow-x-auto">
                <table class="w-full text-sm">
                  <thead>
                    <tr class="border-b border-border text-left text-xs text-muted-foreground">
                      <th scope="col" class="py-2 pr-3 font-medium">Target node</th>
                      <th scope="col" class="py-2 pr-3 font-medium">Enabled</th>
                      <th scope="col" class="py-2 pr-3 text-right font-medium">Rules</th>
                      <th scope="col" class="py-2 pr-3 font-medium">Last plan</th>
                      <th scope="col" class="py-2 pr-3 font-medium">Last applied</th>
                      <th scope="col" class="py-2 pr-3 font-medium">Last error</th>
                      <th scope="col" class="py-2 pl-3 text-right font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr
                      v-for="p in sortedPolicies"
                      :key="p.target_node_id"
                      class="border-b border-border last:border-b-0 hover:bg-muted/40"
                    >
                      <td class="py-3 pr-3">
                        <div class="font-medium">{{ policyNodeLabel(p) }}</div>
                        <div class="font-mono text-xs text-muted-foreground">{{ shortId(p.target_node_id, 16) }}</div>
                      </td>
                      <td class="py-3 pr-3">
                        <Badge :variant="p.enabled ? 'success' : 'secondary'">
                          {{ p.enabled ? "enabled" : "disabled" }}
                        </Badge>
                      </td>
                      <td class="py-3 pr-3 text-right tabular">{{ activeRuleCount(p) }} / {{ p.rules.length }}</td>
                      <td class="py-3 pr-3 font-mono text-xs text-muted-foreground">
                        {{ p.last_plan_sha ? shortId(p.last_plan_sha, 12) : "—" }}
                      </td>
                      <td class="py-3 pr-3 text-xs text-muted-foreground">
                        {{ p.last_applied_at ? formatDateTime(p.last_applied_at) : "—" }}
                      </td>
                      <td class="py-3 pr-3">
                        <span v-if="p.last_error" class="text-xs text-destructive">{{ p.last_error }}</span>
                        <span v-else class="text-xs text-muted-foreground">—</span>
                      </td>
                      <td class="py-3 pl-3">
                        <div class="flex items-center justify-end gap-1">
                          <Button
                            v-if="canAdmin"
                            variant="outline"
                            size="sm"
                            :disabled="planning === p.target_node_id"
                            @click="plan(p)"
                          >
                            <RefreshCw v-if="planning === p.target_node_id" class="size-4 animate-spin" aria-hidden="true" />
                            <Play v-else class="size-4" aria-hidden="true" />
                            Plan
                          </Button>
                          <Button
                            v-if="canAdmin"
                            variant="ghost"
                            size="icon-sm"
                            aria-label="Edit"
                            @click="openEdit(p)"
                          >
                            <Pencil class="size-4" />
                          </Button>
                          <Button
                            v-if="canAdmin"
                            variant="ghost"
                            size="icon-sm"
                            aria-label="Delete"
                            @click="deleteTarget = p"
                          >
                            <Trash2 class="size-4 text-destructive" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </DataState>
          </CardContent>
        </Card>
      </TabsContent>

      <!-- Topology graph tab -->
      <TabsContent value="graph" class="mt-4">
        <Card>
          <CardHeader>
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div>
                <CardTitle class="flex items-center gap-2">
                  <Network class="size-4 text-muted-foreground" aria-hidden="true" />
                  Topology graph
                </CardTitle>
                <CardDescription>
                  Node-to-node edges from policy rules. Green = allow, red = deny.
                </CardDescription>
              </div>
              <Button
                variant="outline"
                size="sm"
                :disabled="graphQuery.refreshing.value"
                @click="graphQuery.refresh"
              >
                <RefreshCw :class="cn('size-4', graphQuery.refreshing.value && 'animate-spin')" aria-hidden="true" />
                Reload graph
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <DataState
              :loading="graphQuery.loading.value"
              :error="graphQuery.error.value"
              :is-empty="(graph?.nodes.length ?? 0) === 0"
              empty-title="No nodes in graph"
              empty-description="Only nodes you can read with active policies appear in the topology."
              @retry="graphQuery.refresh"
            >
              <div class="space-y-6">
                <!-- Legend -->
                <div class="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
                  <span class="inline-flex items-center gap-1.5">
                    <span class="inline-block h-0.5 w-6 rounded bg-success"></span> allow
                  </span>
                  <span class="inline-flex items-center gap-1.5">
                    <span class="inline-block h-0.5 w-6 rounded bg-destructive"></span> deny
                  </span>
                  <span class="inline-flex items-center gap-1.5">
                    <span class="inline-block size-2 rounded-full bg-success"></span> online
                  </span>
                  <span class="inline-flex items-center gap-1.5">
                    <span class="inline-block size-2 rounded-full bg-muted-foreground"></span> offline
                  </span>
                </div>

                <!-- Circular node-link diagram -->
                <div class="overflow-x-auto rounded-lg border border-border bg-muted/10 p-2">
                  <svg
                    :viewBox="`0 0 ${GRAPH_SIZE} ${GRAPH_SIZE}`"
                    class="mx-auto block h-[480px] w-full max-w-[640px]"
                    role="img"
                    aria-label="Network policy topology"
                  >
                    <defs>
                      <marker
                        id="arrow-allow"
                        viewBox="0 0 10 10"
                        refX="8"
                        refY="5"
                        markerWidth="6"
                        markerHeight="6"
                        orient="auto-start-reverse"
                      >
                        <path d="M0,0 L10,5 L0,10 z" class="fill-success" />
                      </marker>
                      <marker
                        id="arrow-deny"
                        viewBox="0 0 10 10"
                        refX="8"
                        refY="5"
                        markerWidth="6"
                        markerHeight="6"
                        orient="auto-start-reverse"
                      >
                        <path d="M0,0 L10,5 L0,10 z" class="fill-destructive" />
                      </marker>
                    </defs>

                    <!-- edges -->
                    <g v-if="hasGraphEdges">
                      <g v-for="edge in drawnEdges" :key="edge.key">
                        <line
                          :x1="edge.x1"
                          :y1="edge.y1"
                          :x2="edge.x2"
                          :y2="edge.y2"
                          :class="edge.allow ? 'stroke-success' : 'stroke-destructive'"
                          stroke-width="1.6"
                          :marker-end="edge.allow ? 'url(#arrow-allow)' : 'url(#arrow-deny)'"
                          :stroke-dasharray="edge.allow ? '0' : '5 4'"
                        />
                        <text
                          :x="(edge.x1 + edge.x2) / 2"
                          :y="(edge.y1 + edge.y2) / 2 - 3"
                          text-anchor="middle"
                          class="fill-muted-foreground text-[9px]"
                        >
                          {{ edge.label }}
                        </text>
                      </g>
                    </g>

                    <!-- nodes -->
                    <g v-for="node in placedNodes" :key="node.id">
                      <circle
                        :cx="node.x"
                        :cy="node.y"
                        :r="NODE_RADIUS"
                        class="fill-card stroke-border"
                        stroke-width="1.5"
                      />
                      <circle
                        :cx="node.x"
                        :cy="node.y - NODE_RADIUS + 6"
                        r="4"
                        :class="node.online ? 'fill-success' : 'fill-muted-foreground'"
                      />
                      <text
                        :x="node.x"
                        :y="node.y + 4"
                        text-anchor="middle"
                        class="fill-foreground text-[10px] font-medium"
                      >
                        {{ node.name.length > 10 ? node.name.slice(0, 9) + "…" : node.name }}
                      </text>
                    </g>
                  </svg>
                  <p v-if="!hasGraphEdges" class="pb-2 text-center text-xs text-muted-foreground">
                    No node-to-node edges. External endpoints are listed below.
                  </p>
                </div>

                <!-- Externals adjacency table -->
                <div v-if="externals.length" class="overflow-x-auto rounded-lg border border-border">
                  <table class="w-full text-sm">
                    <thead>
                      <tr class="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
                        <th scope="col" class="px-3 py-2 font-medium">Target node</th>
                        <th scope="col" class="px-3 py-2 font-medium">Direction</th>
                        <th scope="col" class="px-3 py-2 font-medium">Action</th>
                        <th scope="col" class="px-3 py-2 font-medium">Remote</th>
                        <th scope="col" class="px-3 py-2 font-medium">Protocol</th>
                        <th scope="col" class="px-3 py-2 font-medium">Ports</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr
                        v-for="ext in externals"
                        :key="`${ext.rule_id}:${ext.target_node_id}:${ext.remote}`"
                        class="border-b border-border last:border-b-0 hover:bg-muted/40"
                      >
                        <td class="px-3 py-2">{{ nodeName(ext.target_node_id) }}</td>
                        <td class="px-3 py-2 text-xs">{{ ext.direction }}</td>
                        <td class="px-3 py-2">
                          <Badge :variant="ext.action === 'allow' ? 'success' : 'destructive'">{{ ext.action }}</Badge>
                        </td>
                        <td class="px-3 py-2 font-mono text-xs">{{ ext.remote }}</td>
                        <td class="px-3 py-2 text-xs">{{ ext.protocol }}</td>
                        <td class="px-3 py-2 font-mono text-xs">{{ ext.ports?.length ? ext.ports.join(", ") : "all" }}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            </DataState>
          </CardContent>
        </Card>
      </TabsContent>
    </Tabs>

    <!-- Create / edit policy dialog -->
    <Dialog v-model:open="dialogOpen">
      <DialogScrollContent class="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{{ editingId ? "Edit policy" : "New policy" }}</DialogTitle>
          <DialogDescription>
            Define ordered rules. Domain remotes are egress-only; protocol "any" carries no ports.
          </DialogDescription>
        </DialogHeader>

        <form class="space-y-5" @submit.prevent="submit">
          <div class="grid gap-3 sm:grid-cols-2">
            <div class="grid gap-2">
              <Label for="policy-node">Target node</Label>
              <Select v-model="form.target_node_id" :disabled="!!editingId">
                <SelectTrigger id="policy-node" class="w-full">
                  <SelectValue placeholder="Select a node" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="node in nodes" :key="node.id" :value="node.id">
                    {{ node.name || node.id }}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div class="grid gap-2">
              <Label>Policy state</Label>
              <label class="flex h-9 items-center gap-2 rounded-md border border-input px-3 text-sm">
                <input v-model="form.enabled" type="checkbox" class="size-4 accent-primary" />
                Enabled
              </label>
            </div>
          </div>

          <div class="space-y-3">
            <div class="flex items-center justify-between">
              <Label>Rules</Label>
              <Button type="button" variant="outline" size="sm" @click="addRule">
                <Plus class="size-4" aria-hidden="true" />
                Add rule
              </Button>
            </div>

            <p v-if="form.rules.length === 0" class="rounded-md border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
              No rules. An empty enabled policy denies all non-baseline traffic.
            </p>

            <div
              v-for="(rule, index) in form.rules"
              :key="index"
              class="space-y-3 rounded-lg border border-border p-3"
            >
              <div class="flex items-center justify-between">
                <span class="text-xs font-medium text-muted-foreground">Rule {{ index + 1 }}</span>
                <Button type="button" variant="ghost" size="icon-sm" aria-label="Remove rule" @click="removeRule(index)">
                  <Trash2 class="size-4 text-destructive" />
                </Button>
              </div>

              <div class="grid gap-3 sm:grid-cols-3">
                <div class="grid gap-1.5">
                  <Label class="text-xs">Action</Label>
                  <Select v-model="rule.action">
                    <SelectTrigger class="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="allow">allow</SelectItem>
                      <SelectItem value="deny">deny</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div class="grid gap-1.5">
                  <Label class="text-xs">Direction</Label>
                  <Select v-model="rule.direction">
                    <SelectTrigger class="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="egress">egress</SelectItem>
                      <SelectItem value="ingress">ingress</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div class="grid gap-1.5">
                  <Label class="text-xs">Protocol</Label>
                  <Select v-model="rule.protocol">
                    <SelectTrigger class="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="tcp">tcp</SelectItem>
                      <SelectItem value="udp">udp</SelectItem>
                      <SelectItem value="any">any</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div class="grid gap-3 sm:grid-cols-2">
                <div class="grid gap-1.5">
                  <Label class="text-xs">Ports</Label>
                  <Input
                    v-model="rule.ports"
                    :disabled="rule.protocol === 'any'"
                    placeholder="empty = all ports"
                  />
                </div>
                <div class="grid gap-1.5">
                  <Label class="text-xs">Remote kind</Label>
                  <Select v-model="rule.remoteKind">
                    <SelectTrigger class="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="node">node</SelectItem>
                      <SelectItem value="cidr">cidr</SelectItem>
                      <SelectItem value="domain">domain</SelectItem>
                      <SelectItem value="any">any</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div v-if="rule.remoteKind === 'node'" class="grid gap-1.5">
                <Label class="text-xs">Remote node</Label>
                <Select v-model="rule.remoteNodeId">
                  <SelectTrigger class="w-full"><SelectValue placeholder="Select a node" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem v-for="node in nodes" :key="node.id" :value="node.id">
                      {{ node.name || node.id }}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div v-else-if="rule.remoteKind === 'cidr'" class="grid gap-1.5">
                <Label class="text-xs">Remote CIDR</Label>
                <Input v-model="rule.remoteCidr" placeholder="10.0.0.0/24 or 1.2.3.4" />
              </div>
              <div v-else-if="rule.remoteKind === 'domain'" class="grid gap-1.5">
                <Label class="text-xs">Remote domain (egress only)</Label>
                <Input v-model="rule.remoteDomain" placeholder="api.example.com" />
              </div>

              <div class="grid gap-3 sm:grid-cols-2">
                <div class="grid gap-1.5">
                  <Label class="text-xs">Comment</Label>
                  <Input v-model="rule.comment" placeholder="optional" />
                </div>
                <label class="flex items-center gap-2 self-end pb-2 text-sm">
                  <input v-model="rule.disabled" type="checkbox" class="size-4 accent-primary" />
                  Disabled
                </label>
              </div>

              <p v-if="formErrors[index]" class="text-xs text-destructive">{{ formErrors[index] }}</p>
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" @click="dialogOpen = false">Cancel</Button>
            <Button type="submit" :disabled="!canSubmit || saving">
              <RefreshCw v-if="saving" class="size-4 animate-spin" aria-hidden="true" />
              {{ editingId ? "Save changes" : "Create policy" }}
            </Button>
          </DialogFooter>
        </form>
      </DialogScrollContent>
    </Dialog>

    <!-- Delete confirm dialog -->
    <Dialog :open="!!deleteTarget" @update:open="(v) => { if (!v) deleteTarget = undefined; }">
      <DialogScrollContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete policy</DialogTitle>
          <DialogDescription>
            Delete the network policy for
            <span class="font-medium">{{ deleteTarget ? policyNodeLabel(deleteTarget) : "" }}</span>?
            This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" @click="deleteTarget = undefined">Cancel</Button>
          <Button type="button" variant="destructive" :disabled="deleting" @click="confirmDelete">
            <RefreshCw v-if="deleting" class="size-4 animate-spin" aria-hidden="true" />
            <Trash2 v-else class="size-4" aria-hidden="true" />
            Delete
          </Button>
        </DialogFooter>
      </DialogScrollContent>
    </Dialog>

    <!-- Plan review dialog -->
    <Dialog :open="!!planApproval" @update:open="closePlan">
      <DialogScrollContent class="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Plan created</DialogTitle>
          <DialogDescription>
            Review &amp; approve under Operations → Approvals. Nothing is applied until approved.
          </DialogDescription>
        </DialogHeader>
        <div v-if="planApproval" class="space-y-4">
          <div class="flex flex-wrap items-center gap-2">
            <Badge variant="warning">{{ planApproval.status }}</Badge>
            <Badge variant="outline">{{ planApproval.plugin }} · {{ planApproval.action }}</Badge>
            <Badge variant="secondary">id {{ shortId(planApproval.id, 12) }}</Badge>
          </div>

          <div class="rounded-md border border-border">
            <div class="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
              <span class="text-sm font-medium">Plan</span>
              <CopyButton :value="planApproval.plan || ''" />
            </div>
            <pre class="max-h-[420px] overflow-auto whitespace-pre-wrap p-4 font-mono text-xs leading-relaxed">{{ planApproval.plan }}</pre>
          </div>

          <div class="flex flex-wrap items-center gap-2 rounded-md bg-muted/40 p-3 text-xs">
            <span class="font-medium">sha256</span>
            <code class="break-all font-mono">{{ planSha }}</code>
            <CopyButton :value="planSha" />
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" @click="closePlan(false)">Close</Button>
          <Button as-child>
            <RouterLink to="/approvals">
              <ExternalLink class="size-4" aria-hidden="true" />
              Go to Approvals
            </RouterLink>
          </Button>
        </DialogFooter>
      </DialogScrollContent>
    </Dialog>
  </div>
</template>

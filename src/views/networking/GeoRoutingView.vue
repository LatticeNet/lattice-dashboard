<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import {
  AlertTriangle,
  FileCode2,
  Globe,
  Pencil,
  Plus,
  RefreshCw,
  Route,
  Trash2,
} from "lucide-vue-next";
import {
  api,
  unwrap,
  type GeoRouting,
  type GeoRoutingPlanView,
  type GeoRoutingUpsertRequest,
  type Node,
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogScrollContent,
  DialogTitle,
} from "@/components/ui/dialog";

type Strategy = "geoip" | "all-healthy";

const { t } = useI18n();
const auth = useAuthStore();
const canRead = computed(() => auth.can("geo:read"));
const canAdmin = computed(() => auth.can("geo:admin"));
const canReadNodes = computed(() => auth.can("node:read"));

const routesQuery = useAsyncData(
  () => {
    if (!canRead.value) return Promise.resolve([] as GeoRouting[]);
    return api.geoRouting.list().then((r) => unwrap(r, "geo_routings"));
  },
  { pollInterval: 15000, immediate: canRead.value },
);
const nodesQuery = useAsyncData(
  () => {
    if (!canReadNodes.value) return Promise.resolve([] as Node[]);
    return api.nodes.list().then((r) => unwrap(r, "nodes"));
  },
  {
    pollInterval: 15000,
    immediate: canReadNodes.value,
  },
);

const routes = computed(() => routesQuery.data.value ?? []);
const nodes = computed(() => nodesQuery.data.value ?? []);

const sortedRoutes = computed(() =>
  [...routes.value].sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id)),
);

function nodeName(id: string): string {
  return nodes.value.find((node) => node.id === id)?.name || shortId(id, 14);
}

function strategyVariant(strategy: string): "info" | "secondary" {
  return strategy === "geoip" ? "info" : "secondary";
}

// ── Create / edit dialog ────────────────────────────────────────────────────
const formOpen = ref(false);
const editingId = ref<string | undefined>();
const saving = ref(false);

const form = reactive({
  name: "",
  hostname: "",
  strategy: "geoip" as Strategy,
  node_ids: [] as string[],
  dns_node_ids: [] as string[],
  ttl: 60,
  geoip_db_path: "",
  publish_ns: false,
  ddns_profile_id: "",
});
const nodeIdsInput = computed({
  get: () => form.node_ids.join(", "),
  set: (value: string) => {
    form.node_ids = parseNodeIdList(value);
  },
});
const dnsNodeIdsInput = computed({
  get: () => form.dns_node_ids.join(", "),
  set: (value: string) => {
    form.dns_node_ids = parseNodeIdList(value);
  },
});

function parseNodeIdList(value: string): string[] {
  return [...new Set(value.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean))];
}

function resetForm() {
  form.name = "";
  form.hostname = "";
  form.strategy = "geoip";
  form.node_ids = [];
  form.dns_node_ids = [];
  form.ttl = 60;
  form.geoip_db_path = "";
  form.publish_ns = false;
  form.ddns_profile_id = "";
}

function openCreate() {
  if (!canAdmin.value) return;
  editingId.value = undefined;
  resetForm();
  formOpen.value = true;
}

function openEdit(route: GeoRouting) {
  if (!canAdmin.value) return;
  editingId.value = route.id;
  form.name = route.name;
  form.hostname = route.hostname;
  form.strategy = (route.strategy === "all-healthy" ? "all-healthy" : "geoip") as Strategy;
  form.node_ids = [...(route.node_ids ?? [])];
  form.dns_node_ids = [...(route.dns_node_ids ?? [])];
  form.ttl = route.ttl ?? 60;
  form.geoip_db_path = route.geoip_db_path ?? "";
  form.publish_ns = route.publish_ns ?? false;
  form.ddns_profile_id = route.ddns_profile_id ?? "";
  formOpen.value = true;
}

const canSubmit = computed(
  () =>
    !!form.name.trim() &&
    !!form.hostname.trim() &&
    form.node_ids.length > 0 &&
    form.dns_node_ids.length > 0 &&
    form.ttl >= 10 &&
    form.ttl <= 3600,
);

function toggleId(list: "node_ids" | "dns_node_ids", id: string) {
  const current = form[list];
  form[list] = current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
}

async function submitForm() {
  if (!canSubmit.value || !canAdmin.value) return;
  saving.value = true;
  try {
    const req: GeoRoutingUpsertRequest = {
      id: editingId.value,
      name: form.name.trim(),
      hostname: form.hostname.trim(),
      strategy: form.strategy,
      node_ids: form.node_ids,
      dns_node_ids: form.dns_node_ids,
      ttl: Number(form.ttl),
      publish_ns: form.publish_ns,
    };
    if (form.strategy === "geoip" && form.geoip_db_path.trim()) {
      req.geoip_db_path = form.geoip_db_path.trim();
    }
    if (form.ddns_profile_id.trim()) {
      req.ddns_profile_id = form.ddns_profile_id.trim();
    }
    await api.geoRouting.upsert(req);
    toast.success(editingId.value ? t("networking.geoRouting.toastUpdated") : t("networking.geoRouting.toastCreated"));
    formOpen.value = false;
    if (canRead.value) routesQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("networking.geoRouting.toastSaveFailed"));
  } finally {
    saving.value = false;
  }
}

// ── Delete confirmation ─────────────────────────────────────────────────────
const deleteTarget = ref<GeoRouting | undefined>();
const deleting = ref(false);

async function confirmDelete() {
  if (!deleteTarget.value) return;
  deleting.value = true;
  try {
    await api.geoRouting.delete(deleteTarget.value.id);
    toast.success(t("networking.geoRouting.toastDeleted"));
    deleteTarget.value = undefined;
    if (canRead.value) routesQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("networking.geoRouting.toastDeleteFailed"));
  } finally {
    deleting.value = false;
  }
}

// ── Plan preview (pure render — NOT an approval) ────────────────────────────
const planOpen = ref(false);
const planning = ref<string | undefined>();
const plan = ref<GeoRoutingPlanView | undefined>();
const planDigest = ref("");

async function openPlan(route: GeoRouting) {
  if (!canRead.value) return;
  planning.value = route.id;
  try {
    const result = await api.geoRouting.plan(route.id);
    plan.value = result;
    planDigest.value = await sha256Hex(result.config || "");
    planOpen.value = true;
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("networking.geoRouting.toastPlanFailed"));
  } finally {
    planning.value = undefined;
  }
}

const continentEntries = computed(() =>
  Object.entries(plan.value?.continent_choice ?? {}).sort((a, b) => a[0].localeCompare(b[0])),
);
</script>

<template>
  <div class="p-6 space-y-6">
    <PageHeader
      :title="$t('networking.geoRouting.title')"
      :description="$t('networking.geoRouting.description')"
    >
      <template #actions>
        <Button
          v-if="canRead"
          variant="outline"
          size="sm"
          :disabled="routesQuery.refreshing.value"
          @click="routesQuery.refresh"
        >
          <RefreshCw :class="cn('size-4', routesQuery.refreshing.value && 'animate-spin')" aria-hidden="true" />
          {{ $t('common.actions.refresh') }}
        </Button>
        <Button
          v-if="canAdmin"
          size="sm"
          @click="openCreate"
        >
          <Plus class="size-4" aria-hidden="true" />
          {{ $t('networking.geoRouting.newRouting') }}
        </Button>
      </template>
    </PageHeader>

    <Card>
      <CardHeader>
        <CardTitle class="flex items-center gap-2">
          <Route class="size-4 text-muted-foreground" aria-hidden="true" />
          {{ $t('networking.geoRouting.routings') }}
        </CardTitle>
        <CardDescription>
          {{ routes.length === 1 ? $t('networking.geoRouting.apexRecord', { count: routes.length }) : $t('networking.geoRouting.apexRecords', { count: routes.length }) }}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <DataState
          :loading="routesQuery.loading.value"
          :error="routesQuery.error.value"
          :has-data="routesQuery.data.value !== undefined"
          :is-empty="routes.length === 0"
          :empty-title="$t('networking.geoRouting.emptyTitle')"
          :empty-description="$t('networking.geoRouting.emptyDescription')"
          @retry="routesQuery.refresh"
        >
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead>
                <tr class="border-b border-border text-left text-xs text-muted-foreground">
                  <th scope="col" class="py-2 pr-4 font-medium">{{ $t('networking.geoRouting.colName') }}</th>
                  <th scope="col" class="py-2 pr-4 font-medium">{{ $t('networking.geoRouting.colHostname') }}</th>
                  <th scope="col" class="py-2 pr-4 font-medium">{{ $t('networking.geoRouting.colStrategy') }}</th>
                  <th scope="col" class="py-2 pr-4 text-right font-medium">{{ $t('networking.geoRouting.colNodes') }}</th>
                  <th scope="col" class="py-2 pr-4 text-right font-medium">{{ $t('networking.geoRouting.colDns') }}</th>
                  <th scope="col" class="py-2 pr-4 font-medium">{{ $t('networking.geoRouting.colStatus') }}</th>
                  <th scope="col" class="py-2 pr-4 font-medium">{{ $t('networking.geoRouting.colLastApplied') }}</th>
                  <th scope="col" class="py-2 pr-4 font-medium">{{ $t('networking.geoRouting.colLastError') }}</th>
                  <th scope="col" class="py-2 pl-4 text-right font-medium">{{ $t('networking.geoRouting.colActions') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="route in sortedRoutes"
                  :key="route.id"
                  class="border-b border-border last:border-b-0 hover:bg-muted/40"
                >
                  <td class="py-3 pr-4">
                    <div class="font-medium">{{ route.name || route.id }}</div>
                    <div class="font-mono text-xs text-muted-foreground">{{ shortId(route.id, 16) }}</div>
                  </td>
                  <td class="py-3 pr-4 font-mono text-xs">{{ route.hostname }}</td>
                  <td class="py-3 pr-4">
                    <Badge :variant="strategyVariant(route.strategy)">{{ route.strategy }}</Badge>
                  </td>
                  <td class="py-3 pr-4 text-right tabular">{{ route.node_ids?.length ?? 0 }}</td>
                  <td class="py-3 pr-4 text-right tabular">{{ route.dns_node_ids?.length ?? 0 }}</td>
                  <td class="py-3 pr-4">
                    <Badge v-if="route.status" :variant="route.status === 'configured' ? 'success' : 'warning'">
                      {{ route.status }}
                    </Badge>
                    <span v-else class="text-xs text-muted-foreground">—</span>
                  </td>
                  <td class="py-3 pr-4 text-xs text-muted-foreground">
                    {{ route.last_applied_at ? formatDateTime(route.last_applied_at) : $t('common.misc.never') }}
                  </td>
                  <td class="py-3 pr-4 max-w-[180px]">
                    <span v-if="route.last_error" class="break-words text-xs text-destructive">
                      {{ route.last_error }}
                    </span>
                    <span v-else class="text-xs text-muted-foreground">—</span>
                  </td>
                  <td class="py-3 pl-4">
                    <div class="flex justify-end gap-1">
                      <Button
                        v-if="canRead"
                        variant="ghost"
                        size="sm"
                        :disabled="planning === route.id"
                        @click="openPlan(route)"
                      >
                        <RefreshCw v-if="planning === route.id" class="size-4 animate-spin" aria-hidden="true" />
                        <FileCode2 v-else class="size-4" aria-hidden="true" />
                        {{ $t('networking.shared.plan') }}
                      </Button>
                      <Button
                        v-if="canAdmin"
                        variant="ghost"
                        size="icon-sm"
                        :aria-label="$t('common.actions.edit')"
                        @click="openEdit(route)"
                      >
                        <Pencil class="size-4" />
                      </Button>
                      <Button
                        v-if="canAdmin"
                        variant="ghost"
                        size="icon-sm"
                        :aria-label="$t('common.actions.delete')"
                        @click="deleteTarget = route"
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

    <!-- Create / edit dialog -->
    <Dialog v-model:open="formOpen">
      <DialogScrollContent class="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{{ editingId ? $t('networking.geoRouting.editTitle') : $t('networking.geoRouting.newTitle') }}</DialogTitle>
          <DialogDescription>
            {{ $t('networking.geoRouting.dialogDescription') }}
          </DialogDescription>
        </DialogHeader>

        <form class="space-y-4" @submit.prevent="submitForm">
          <div class="grid gap-3 sm:grid-cols-2">
            <div class="grid gap-2">
              <Label for="geo-name">{{ $t('networking.geoRouting.name') }}</Label>
              <Input id="geo-name" v-model="form.name" required placeholder="apex-edge" />
            </div>
            <div class="grid gap-2">
              <Label for="geo-hostname">{{ $t('networking.geoRouting.hostname') }}</Label>
              <Input id="geo-hostname" v-model="form.hostname" required placeholder="app.example.com" />
            </div>
          </div>

          <div class="grid gap-3 sm:grid-cols-2">
            <div class="grid gap-2">
              <Label for="geo-strategy">{{ $t('networking.geoRouting.strategy') }}</Label>
              <Select v-model="form.strategy">
                <SelectTrigger id="geo-strategy" class="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="geoip">{{ $t('networking.geoRouting.strategyGeoip') }}</SelectItem>
                  <SelectItem value="all-healthy">{{ $t('networking.geoRouting.strategyAllHealthy') }}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div class="grid gap-2">
              <Label for="geo-ttl">{{ $t('networking.geoRouting.ttlSeconds') }}</Label>
              <Input id="geo-ttl" v-model.number="form.ttl" type="number" min="10" max="3600" />
            </div>
          </div>

          <div v-if="form.strategy === 'geoip'" class="grid gap-2">
            <Label for="geo-db">{{ $t('networking.geoRouting.geoipDbPath') }}</Label>
            <Input
              id="geo-db"
              v-model="form.geoip_db_path"
              :placeholder="$t('networking.geoRouting.geoipDbPlaceholder')"
            />
            <p class="text-xs text-muted-foreground">
              {{ $t('networking.geoRouting.geoipDbHint') }}
            </p>
          </div>

          <div class="grid gap-2">
            <Label>{{ $t('networking.geoRouting.participatingNodes') }}</Label>
            <p class="text-xs text-muted-foreground">{{ $t('networking.geoRouting.participatingNodesHint') }}</p>
            <DataState
              v-if="canReadNodes"
              :loading="nodesQuery.loading.value"
              :error="nodesQuery.error.value"
              :has-data="nodesQuery.data.value !== undefined"
              :is-empty="nodes.length === 0"
              :empty-title="$t('networking.geoRouting.noNodesTitle')"
              :empty-description="$t('networking.geoRouting.noNodesDescription')"
              :skeleton-rows="2"
              @retry="nodesQuery.refresh"
            >
              <div class="grid max-h-48 gap-1 overflow-auto rounded-md border border-border p-2">
                <label
                  v-for="node in nodes"
                  :key="node.id"
                  class="flex items-center gap-2 rounded-md p-2 text-sm hover:bg-muted/40"
                >
                  <input
                    type="checkbox"
                    class="size-4 accent-primary"
                    :checked="form.node_ids.includes(node.id)"
                    @change="toggleId('node_ids', node.id)"
                  />
                  <span class="min-w-0 flex-1 truncate">{{ node.name || node.id }}</span>
                  <Badge :variant="node.online ? 'success' : 'secondary'">{{ node.online ? $t('networking.geoRouting.on') : $t('networking.geoRouting.off') }}</Badge>
                </label>
              </div>
            </DataState>
            <div v-else class="grid gap-2">
              <Input
                id="geo-node-ids"
                v-model="nodeIdsInput"
                :placeholder="$t('networking.geoRouting.nodeIdsPlaceholder')"
              />
              <p class="text-xs text-muted-foreground">{{ $t('networking.geoRouting.nodeIdsManualHint') }}</p>
            </div>
          </div>

          <div class="grid gap-2">
            <Label>{{ $t('networking.geoRouting.authoritativeNodes') }}</Label>
            <p class="text-xs text-muted-foreground">{{ $t('networking.geoRouting.authoritativeNodesHint') }}</p>
            <div v-if="canReadNodes" class="grid max-h-48 gap-1 overflow-auto rounded-md border border-border p-2">
              <label
                v-for="node in nodes"
                :key="node.id"
                class="flex items-center gap-2 rounded-md p-2 text-sm hover:bg-muted/40"
              >
                <input
                  type="checkbox"
                  class="size-4 accent-primary"
                  :checked="form.dns_node_ids.includes(node.id)"
                  @change="toggleId('dns_node_ids', node.id)"
                />
                <span class="min-w-0 flex-1 truncate">{{ node.name || node.id }}</span>
                <Badge :variant="node.online ? 'success' : 'secondary'">{{ node.online ? $t('networking.geoRouting.on') : $t('networking.geoRouting.off') }}</Badge>
              </label>
            </div>
            <div v-else class="grid gap-2">
              <Input
                id="geo-dns-node-ids"
                v-model="dnsNodeIdsInput"
                :placeholder="$t('networking.geoRouting.nodeIdsPlaceholder')"
              />
              <p class="text-xs text-muted-foreground">{{ $t('networking.geoRouting.nodeIdsManualHint') }}</p>
            </div>
          </div>

          <div class="grid gap-3 sm:grid-cols-2">
            <div class="grid gap-2">
              <Label for="geo-ddns">{{ $t('networking.geoRouting.ddnsProfileId') }}</Label>
              <Input id="geo-ddns" v-model="form.ddns_profile_id" :placeholder="$t('networking.geoRouting.ddnsProfilePlaceholder')" />
            </div>
            <label class="flex items-center gap-2 self-end pb-2 text-sm">
              <input v-model="form.publish_ns" type="checkbox" class="size-4 accent-primary" />
              {{ $t('networking.geoRouting.publishNs') }}
            </label>
          </div>

          <DialogFooter>
            <DialogClose as-child>
              <Button type="button" variant="outline">{{ $t('common.actions.cancel') }}</Button>
            </DialogClose>
            <Button type="submit" :disabled="saving || !canSubmit">
              <RefreshCw v-if="saving" class="size-4 animate-spin" aria-hidden="true" />
              <Plus v-else class="size-4" aria-hidden="true" />
              {{ editingId ? $t('common.actions.saveChanges') : $t('common.actions.create') }}
            </Button>
          </DialogFooter>
        </form>
      </DialogScrollContent>
    </Dialog>

    <!-- Delete confirmation -->
    <Dialog :open="!!deleteTarget" @update:open="(v) => { if (!v) deleteTarget = undefined; }">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{{ $t('networking.geoRouting.deleteTitle') }}</DialogTitle>
          <DialogDescription>
            {{ $t('networking.geoRouting.deleteDescription', { name: deleteTarget?.name || deleteTarget?.id, hostname: deleteTarget?.hostname }) }}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose as-child>
            <Button type="button" variant="outline">{{ $t('common.actions.cancel') }}</Button>
          </DialogClose>
          <Button type="button" variant="destructive" :disabled="deleting" @click="confirmDelete">
            <RefreshCw v-if="deleting" class="size-4 animate-spin" aria-hidden="true" />
            <Trash2 v-else class="size-4" aria-hidden="true" />
            {{ $t('common.actions.delete') }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- Plan preview (pure render, not an approval) -->
    <Dialog v-model:open="planOpen">
      <DialogScrollContent class="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle class="flex items-center gap-2">
            <FileCode2 class="size-5 text-muted-foreground" aria-hidden="true" />
            {{ $t('networking.geoRouting.previewTitle') }}
          </DialogTitle>
          <DialogDescription v-if="plan">
            {{ $t('networking.geoRouting.previewSubtitle', { hostname: plan.hostname, strategy: plan.strategy }) }}
          </DialogDescription>
        </DialogHeader>

        <div v-if="plan" class="space-y-4">
          <div class="flex items-start gap-2 rounded-md border border-info/40 bg-info/5 p-3 text-sm">
            <Globe class="mt-0.5 size-4 shrink-0 text-info" aria-hidden="true" />
            <i18n-t keypath="networking.geoRouting.renderOnlyHint" tag="p" class="text-muted-foreground" scope="global">
              <template #renderOnly>
                <span class="font-medium text-foreground">{{ $t('networking.geoRouting.renderOnlyLead') }}</span>
              </template>
            </i18n-t>
          </div>

          <div class="rounded-md border border-border">
            <div class="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
              <span class="text-sm font-medium">{{ $t('networking.geoRouting.serverBlock') }}</span>
              <CopyButton :value="plan.config || ''" />
            </div>
            <pre class="max-h-[420px] overflow-auto whitespace-pre-wrap p-4 font-mono text-xs leading-relaxed">{{ plan.config }}</pre>
          </div>

          <div class="flex flex-wrap items-center gap-2 rounded-md bg-muted/40 p-3 text-xs">
            <span class="font-medium">sha256</span>
            <code class="break-all font-mono">{{ planDigest || plan.sha256 }}</code>
            <CopyButton :value="planDigest || plan.sha256 || ''" />
          </div>

          <div v-if="plan.warnings && plan.warnings.length" class="space-y-2">
            <p class="flex items-center gap-2 text-sm font-medium text-warning">
              <AlertTriangle class="size-4" aria-hidden="true" />
              {{ $t('networking.geoRouting.warnings') }}
            </p>
            <ul class="space-y-1 rounded-md border border-warning/40 bg-warning/5 p-3 text-xs text-muted-foreground">
              <li v-for="(warning, index) in plan.warnings" :key="index" class="break-words">{{ warning }}</li>
            </ul>
          </div>

          <div v-if="continentEntries.length" class="space-y-2">
            <p class="text-sm font-medium">{{ $t('networking.geoRouting.perContinentTitle') }}</p>
            <div class="overflow-x-auto rounded-md border border-border">
              <table class="w-full text-sm">
                <thead>
                  <tr class="border-b border-border text-left text-xs text-muted-foreground">
                    <th scope="col" class="px-3 py-2 font-medium">{{ $t('networking.geoRouting.colContinent') }}</th>
                    <th scope="col" class="px-3 py-2 font-medium">{{ $t('networking.geoRouting.colChoiceNode') }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="[continent, node] in continentEntries"
                    :key="continent"
                    class="border-b border-border last:border-b-0"
                  >
                    <td class="px-3 py-2 font-mono text-xs">{{ continent }}</td>
                    <td class="px-3 py-2">{{ nodeName(node) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <DialogFooter>
          <DialogClose as-child>
            <Button type="button" variant="outline">{{ $t('common.actions.close') }}</Button>
          </DialogClose>
        </DialogFooter>
      </DialogScrollContent>
    </Dialog>
  </div>
</template>

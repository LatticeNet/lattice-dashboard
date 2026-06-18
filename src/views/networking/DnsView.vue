<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import {
  Globe2,
  KeyRound,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Trash2,
  UploadCloud,
} from "lucide-vue-next";
import {
  api,
  unwrap,
  type ApprovalView,
  type DNSDeploymentBody,
  type DNSDeploymentView,
  type DNSRecord,
  type DNSZone,
} from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { usePlanDigest } from "@/composables/usePlanDigest";
import { useAuthStore } from "@/stores/auth";
import { formatDateTime, shortId } from "@/lib/format";
import { cn } from "@/lib/utils";

import PageHeader from "@/components/common/PageHeader.vue";
import FreshnessLabel from "@/components/common/FreshnessLabel.vue";
import ConfirmDialog from "@/components/common/ConfirmDialog.vue";
import PlanReviewDialog from "@/components/common/PlanReviewDialog.vue";
import DataTable, { type DataTableColumn } from "@/components/common/DataTable.vue";
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

const { t } = useI18n();
const auth = useAuthStore();
const canAdmin = computed(() => auth.can("dns:admin"));
const canPlan = computed(() => auth.can("dns:admin") && auth.can("network:plan"));

const deploymentsQuery = useAsyncData(
  () => api.dns.deployments().then((r) => unwrap(r, "deployments")),
  { pollInterval: 15000 },
);
const nodesQuery = useAsyncData(() => api.nodes.list().then((r) => unwrap(r, "nodes")), {
  pollInterval: 0,
});

const deployments = computed(() => deploymentsQuery.data.value ?? []);
const nodes = computed(() => nodesQuery.data.value ?? []);

const sortedDeployments = computed(() =>
  [...deployments.value].sort((a, b) => a.name.localeCompare(b.name)),
);

function nodeLabel(dep: DNSDeploymentView): string {
  return dep.node_name || dep.node_id;
}

function statusVariant(status: string): "success" | "destructive" | "warning" | "secondary" {
  switch (status) {
    case "running":
      return "success";
    case "failed":
      return "destructive";
    case "pending":
    case "applying":
      return "warning";
    default:
      return "secondary";
  }
}

const columns = computed<DataTableColumn<DNSDeploymentView>[]>(() => [
  { key: "name", label: t("networking.dns.colName"), sortable: true, searchable: true },
  {
    key: "node",
    label: t("networking.dns.colNode"),
    sortable: true,
    searchable: true,
    value: (dep) => nodeLabel(dep),
  },
  { key: "listen", label: t("networking.dns.colListen") },
  { key: "exposure", label: t("networking.dns.colExposure"), sortable: true },
  { key: "zones", label: t("networking.dns.colZones"), align: "right", sortable: true, value: (dep) => dep.zones.length },
  { key: "hostname", label: t("networking.dns.colHostname"), searchable: true },
  { key: "status", label: t("networking.dns.colStatus"), sortable: true },
  { key: "credential", label: t("networking.dns.colCredential") },
  { key: "published", label: t("networking.dns.colPublished") },
  { key: "actions", label: t("networking.dns.colActions"), align: "right" },
]);

// ── Zone / record editor drafts ───────────────────────────────────────────
type ZoneMode = "forward" | "static" | "block";

interface RecordDraft {
  name: string;
  type: string;
  value: string;
  ttl: string;
}

interface ZoneDraft {
  suffix: string;
  mode: ZoneMode;
  upstreams: string;
  records: RecordDraft[];
}

function emptyRecord(): RecordDraft {
  return { name: "", type: "A", value: "", ttl: "300" };
}

function emptyZone(): ZoneDraft {
  return { suffix: "", mode: "forward", upstreams: "", records: [] };
}

function zoneToDraft(zone: DNSZone): ZoneDraft {
  const mode = (zone.mode as ZoneMode) || "forward";
  return {
    suffix: zone.suffix,
    mode,
    upstreams: (zone.upstreams ?? []).join(", "),
    records: (zone.records ?? []).map((r) => ({
      name: r.name,
      type: r.type || "A",
      value: r.value,
      ttl: r.ttl !== undefined ? String(r.ttl) : "300",
    })),
  };
}

// ── Create / edit dialog ──────────────────────────────────────────────────
interface DnsForm {
  name: string;
  node_id: string;
  listen_port: string;
  enable_udp: boolean;
  enable_tcp: boolean;
  exposure: "mesh" | "public";
  zones: ZoneDraft[];
  hostname: string;
  publish_ipv4: boolean;
  publish_ipv6: boolean;
  record_ttl: string;
  cf_api_token: string;
  ddns_profile_id: string;
}

const dialogOpen = ref(false);
const editingId = ref<string | undefined>(undefined);
const editingHasCredential = ref(false);
const saving = ref(false);
const form = reactive<DnsForm>(emptyForm());

function emptyForm(): DnsForm {
  return {
    name: "",
    node_id: "",
    listen_port: "53",
    enable_udp: true,
    enable_tcp: true,
    exposure: "mesh",
    zones: [emptyZone()],
    hostname: "",
    publish_ipv4: true,
    publish_ipv6: false,
    record_ttl: "60",
    cf_api_token: "",
    ddns_profile_id: "",
  };
}

function openCreate() {
  editingId.value = undefined;
  editingHasCredential.value = false;
  Object.assign(form, emptyForm());
  dialogOpen.value = true;
}

function openEdit(dep: DNSDeploymentView) {
  editingId.value = dep.id;
  editingHasCredential.value = dep.has_credential;
  Object.assign(form, {
    name: dep.name,
    node_id: dep.node_id,
    listen_port: String(dep.listen_port ?? 53),
    enable_udp: dep.enable_udp,
    enable_tcp: dep.enable_tcp,
    exposure: (dep.exposure as "mesh" | "public") || "mesh",
    zones: dep.zones.length ? dep.zones.map(zoneToDraft) : [emptyZone()],
    hostname: dep.hostname ?? "",
    publish_ipv4: dep.publish_ipv4,
    publish_ipv6: dep.publish_ipv6,
    record_ttl: dep.record_ttl !== undefined ? String(dep.record_ttl) : "60",
    cf_api_token: "",
    ddns_profile_id: dep.ddns_profile_id ?? "",
  } satisfies DnsForm);
  dialogOpen.value = true;
}

function addZone() {
  form.zones.push(emptyZone());
}
function removeZone(index: number) {
  form.zones.splice(index, 1);
}
function addRecord(zone: ZoneDraft) {
  zone.records.push(emptyRecord());
}
function removeRecord(zone: ZoneDraft, index: number) {
  zone.records.splice(index, 1);
}

function splitList(input: string): string[] {
  return input
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** A hostname needs a credential: an inline token, a referenced profile, or one already stored. */
const credentialAvailable = computed(
  () => !!form.cf_api_token.trim() || !!form.ddns_profile_id.trim() || editingHasCredential.value,
);
const hostnameNeedsCredential = computed(
  () => !!form.hostname.trim() && !credentialAvailable.value,
);

function zoneError(zone: ZoneDraft): string | undefined {
  if (!zone.suffix.trim()) return t("networking.dns.errSuffixRequired");
  if (zone.mode === "forward" && splitList(zone.upstreams).length === 0) {
    return t("networking.dns.errForwardUpstream");
  }
  if (zone.mode === "static" && zone.records.length === 0) {
    return t("networking.dns.errStaticRecord");
  }
  return undefined;
}

const zoneErrors = computed(() => form.zones.map(zoneError));
const hasZoneErrors = computed(() => zoneErrors.value.some((e) => e !== undefined));

const canSubmit = computed(
  () =>
    canAdmin.value &&
    !!form.name.trim() &&
    !!form.node_id &&
    form.zones.length > 0 &&
    !hasZoneErrors.value &&
    !hostnameNeedsCredential.value,
);

function buildBody(): DNSDeploymentBody {
  const zones: DNSZone[] = form.zones.map((zone) => {
    const base: DNSZone = { suffix: zone.suffix.trim(), mode: zone.mode };
    if (zone.mode === "forward") base.upstreams = splitList(zone.upstreams);
    if (zone.mode === "static") {
      base.records = zone.records.map<DNSRecord>((r) => ({
        name: r.name.trim(),
        type: r.type,
        value: r.value.trim(),
        ...(r.ttl.trim() ? { ttl: Number(r.ttl) } : {}),
      }));
    }
    return base;
  });

  const body: DNSDeploymentBody = {
    ...(editingId.value ? { id: editingId.value } : {}),
    name: form.name.trim(),
    node_id: form.node_id,
    engine: "coredns",
    listen_port: Number(form.listen_port) || 53,
    enable_udp: form.enable_udp,
    enable_tcp: form.enable_tcp,
    exposure: form.exposure,
    zones,
  };

  if (form.hostname.trim()) {
    body.hostname = form.hostname.trim();
    body.publish_ipv4 = form.publish_ipv4;
    body.publish_ipv6 = form.publish_ipv6;
    if (form.record_ttl.trim()) body.record_ttl = Number(form.record_ttl);
  }
  // Write-only secret: only send when the operator typed a new value.
  if (form.cf_api_token.trim()) body.cf_api_token = form.cf_api_token.trim();
  if (form.ddns_profile_id.trim()) body.ddns_profile_id = form.ddns_profile_id.trim();

  return body;
}

async function submit() {
  if (!canSubmit.value) return;
  saving.value = true;
  try {
    await api.dns.upsert(buildBody());
    toast.success(editingId.value ? t("networking.dns.toastUpdated") : t("networking.dns.toastCreated"));
    dialogOpen.value = false;
    deploymentsQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("networking.dns.toastSaveFailed"));
  } finally {
    saving.value = false;
  }
}

// ── Delete confirm ────────────────────────────────────────────────────────
const deleteTarget = ref<DNSDeploymentView | undefined>(undefined);
const deleting = ref(false);

async function confirmDelete() {
  if (!deleteTarget.value) return;
  deleting.value = true;
  try {
    await api.dns.delete(deleteTarget.value.id);
    toast.success(t("networking.dns.toastDeleted"));
    deleteTarget.value = undefined;
    deploymentsQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("networking.dns.toastDeleteFailed"));
  } finally {
    deleting.value = false;
  }
}

// ── Publish (direct action, no approval) ──────────────────────────────────
const publishing = ref<string | undefined>(undefined);

async function publish(dep: DNSDeploymentView) {
  if (!canAdmin.value) return;
  publishing.value = dep.id;
  try {
    const res = await api.dns.publish(dep.id);
    toast.success(t("networking.dns.toastPublished", { ipv4: res.ipv4 || "—", ipv6: res.ipv6 || "—" }));
    deploymentsQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("networking.dns.toastPublishFailed"));
  } finally {
    publishing.value = undefined;
  }
}

// ── Plan dialog ───────────────────────────────────────────────────────────
const planDigest = usePlanDigest();
const planning = ref<string | undefined>(undefined);
const planApproval = ref<ApprovalView | undefined>(undefined);
const planSha = ref("");

async function plan(dep: DNSDeploymentView) {
  if (!canPlan.value) return;
  planning.value = dep.id;
  try {
    const approval = await api.dns.plan(dep.id);
    planApproval.value = approval;
    planSha.value = await planDigest.digestFor(approval);
    toast.success(t("networking.shared.toastPlanCreated"));
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("networking.shared.toastPlanFailed"));
  } finally {
    planning.value = undefined;
  }
}

const planBadges = computed(() => {
  const a = planApproval.value;
  if (!a) return [];
  return [
    { label: a.status, variant: "warning" as const },
    { label: `${a.plugin} · ${a.action}`, variant: "outline" as const },
    { label: t("networking.shared.idLabel", { id: shortId(a.id, 12) }), variant: "secondary" as const },
  ];
});

function closePlan(open: boolean) {
  if (!open) {
    planApproval.value = undefined;
    planSha.value = "";
  }
}
</script>

<template>
  <div class="p-6 space-y-6">
    <PageHeader
      :title="$t('networking.dns.title')"
      :description="$t('networking.dns.description')"
    >
      <template #status>
        <FreshnessLabel :last-updated="deploymentsQuery.lastUpdated.value" />
      </template>
      <template #actions>
        <Button
          variant="outline"
          size="sm"
          :disabled="deploymentsQuery.refreshing.value"
          @click="deploymentsQuery.refresh"
        >
          <RefreshCw :class="cn('size-4', deploymentsQuery.refreshing.value && 'animate-spin')" aria-hidden="true" />
          {{ $t('common.actions.refresh') }}
        </Button>
        <Button v-if="canAdmin" size="sm" @click="openCreate">
          <Plus class="size-4" aria-hidden="true" />
          {{ $t('networking.dns.newDeployment') }}
        </Button>
      </template>
    </PageHeader>

    <Card>
      <CardHeader>
        <CardTitle class="flex items-center gap-2">
          <Globe2 class="size-4 text-muted-foreground" aria-hidden="true" />
          {{ $t('networking.dns.cardTitle') }}
        </CardTitle>
        <CardDescription>
          {{ $t('networking.dns.cardDescription') }}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <DataTable
          :columns="columns"
          :rows="sortedDeployments"
          :row-key="(dep) => dep.id"
          :loading="deploymentsQuery.loading.value"
          :error="deploymentsQuery.error.value"
          searchable
          :search-placeholder="$t('common.actions.search')"
          :empty-title="$t('networking.dns.emptyTitle')"
          :empty-description="$t('networking.dns.emptyDescription')"
          :no-match-title="$t('networking.shared.noMatchTitle')"
          :no-match-description="$t('networking.shared.noMatchDescription')"
          :actions-label="$t('networking.dns.colActions')"
          @retry="deploymentsQuery.refresh"
        >
          <template #cell-name="{ row: dep }">
            <div class="font-medium">{{ dep.name }}</div>
            <div class="font-mono text-xs text-muted-foreground">{{ dep.engine }}{{ dep.engine_version ? ` ${dep.engine_version}` : "" }}</div>
          </template>
          <template #cell-node="{ row: dep }">
            <div>{{ nodeLabel(dep) }}</div>
            <div class="font-mono text-xs text-muted-foreground">{{ shortId(dep.node_id, 12) }}</div>
          </template>
          <template #cell-listen="{ row: dep }">
            <span class="font-mono text-xs">
              {{ dep.listen_port }}
              <span class="text-muted-foreground">
                {{ [dep.enable_udp ? "udp" : null, dep.enable_tcp ? "tcp" : null].filter(Boolean).join("/") }}
              </span>
            </span>
          </template>
          <template #cell-exposure="{ row: dep }">
            <Badge :variant="dep.exposure === 'public' ? 'warning' : 'secondary'">{{ dep.exposure }}</Badge>
          </template>
          <template #cell-zones="{ row: dep }">
            <span class="tabular-nums">{{ dep.zones.length }}</span>
          </template>
          <template #cell-hostname="{ row: dep }">
            <span class="font-mono text-xs">{{ dep.hostname || "—" }}</span>
          </template>
          <template #cell-status="{ row: dep }">
            <Badge :variant="statusVariant(dep.status)">{{ dep.status }}</Badge>
            <div v-if="dep.last_error" class="mt-1 max-w-[180px] text-xs text-destructive">{{ dep.last_error }}</div>
          </template>
          <template #cell-credential="{ row: dep }">
            <Badge v-if="dep.has_credential" variant="success">
              <KeyRound class="size-3" aria-hidden="true" /> {{ $t('networking.dns.credSet') }}
            </Badge>
            <Badge v-else variant="outline">{{ $t('networking.dns.credNone') }}</Badge>
          </template>
          <template #cell-published="{ row: dep }">
            <div class="text-xs text-muted-foreground">{{ dep.last_published_at ? formatDateTime(dep.last_published_at) : "—" }}</div>
            <div v-if="dep.last_publish_error" class="mt-1 max-w-[180px] text-xs text-destructive">{{ dep.last_publish_error }}</div>
          </template>
          <template #cell-actions="{ row: dep }">
            <div class="flex flex-wrap items-center justify-end gap-1">
              <Button
                v-if="canPlan"
                variant="outline"
                size="sm"
                :disabled="planning === dep.id"
                @click="plan(dep)"
              >
                <RefreshCw v-if="planning === dep.id" class="size-4 animate-spin" aria-hidden="true" />
                <Play v-else class="size-4" aria-hidden="true" />
                {{ $t('networking.shared.plan') }}
              </Button>
              <Button
                v-if="canAdmin && dep.hostname"
                variant="outline"
                size="sm"
                :disabled="publishing === dep.id"
                @click="publish(dep)"
              >
                <RefreshCw v-if="publishing === dep.id" class="size-4 animate-spin" aria-hidden="true" />
                <UploadCloud v-else class="size-4" aria-hidden="true" />
                {{ $t('common.actions.publish') }}
              </Button>
              <Button
                v-if="canAdmin"
                variant="ghost"
                size="icon-sm"
                :aria-label="$t('common.actions.edit')"
                @click="openEdit(dep)"
              >
                <Pencil class="size-4" />
              </Button>
              <Button
                v-if="canAdmin"
                variant="ghost"
                size="icon-sm"
                :aria-label="$t('common.actions.delete')"
                @click="deleteTarget = dep"
              >
                <Trash2 class="size-4 text-destructive" />
              </Button>
            </div>
          </template>
        </DataTable>
      </CardContent>
    </Card>

    <!-- Create / edit dialog -->
    <Dialog v-model:open="dialogOpen">
      <DialogScrollContent class="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{{ editingId ? $t('networking.dns.editTitle') : $t('networking.dns.newTitle') }}</DialogTitle>
          <DialogDescription>
            {{ $t('networking.dns.dialogDescription') }}
          </DialogDescription>
        </DialogHeader>

        <form class="space-y-5" @submit.prevent="submit">
          <div class="grid gap-3 sm:grid-cols-2">
            <div class="grid gap-2">
              <Label for="dns-name">{{ $t('networking.dns.name') }}</Label>
              <Input id="dns-name" v-model="form.name" placeholder="edge-resolver" required />
            </div>
            <div class="grid gap-2">
              <Label for="dns-node">{{ $t('networking.dns.nodeLabel') }}</Label>
              <Select v-model="form.node_id" :disabled="!!editingId">
                <SelectTrigger id="dns-node" class="w-full">
                  <SelectValue :placeholder="$t('networking.dns.selectNode')" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="node in nodes" :key="node.id" :value="node.id">
                    {{ node.name || node.id }}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div class="grid gap-3 sm:grid-cols-3">
            <div class="grid gap-2">
              <Label for="dns-port">{{ $t('networking.dns.listenPort') }}</Label>
              <Input id="dns-port" v-model="form.listen_port" type="number" min="1" max="65535" />
            </div>
            <div class="grid gap-2">
              <Label>{{ $t('networking.dns.protocols') }}</Label>
              <div class="flex h-9 items-center gap-4 rounded-md border border-input px-3 text-sm">
                <label class="flex items-center gap-1.5">
                  <input v-model="form.enable_udp" type="checkbox" class="size-4 accent-primary" /> UDP
                </label>
                <label class="flex items-center gap-1.5">
                  <input v-model="form.enable_tcp" type="checkbox" class="size-4 accent-primary" /> TCP
                </label>
              </div>
            </div>
            <div class="grid gap-2">
              <Label for="dns-exposure">{{ $t('networking.dns.exposure') }}</Label>
              <Select v-model="form.exposure">
                <SelectTrigger id="dns-exposure" class="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="mesh">mesh</SelectItem>
                  <SelectItem value="public">public</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <!-- Zones editor -->
          <div class="space-y-3">
            <div class="flex items-center justify-between">
              <Label>{{ $t('networking.dns.zones') }}</Label>
              <Button type="button" variant="outline" size="sm" @click="addZone">
                <Plus class="size-4" aria-hidden="true" />
                {{ $t('networking.dns.addZone') }}
              </Button>
            </div>

            <div
              v-for="(zone, zIndex) in form.zones"
              :key="zIndex"
              class="space-y-3 rounded-lg border border-border p-3"
            >
              <div class="flex items-center justify-between">
                <span class="text-xs font-medium text-muted-foreground">{{ $t('networking.dns.zoneLabel', { index: zIndex + 1 }) }}</span>
                <Button type="button" variant="ghost" size="icon-sm" :aria-label="$t('networking.dns.removeZone')" @click="removeZone(zIndex)">
                  <Trash2 class="size-4 text-destructive" />
                </Button>
              </div>

              <div class="grid gap-3 sm:grid-cols-2">
                <div class="grid gap-1.5">
                  <Label class="text-xs">{{ $t('networking.dns.suffix') }}</Label>
                  <Input v-model="zone.suffix" placeholder="internal.example.com" />
                </div>
                <div class="grid gap-1.5">
                  <Label class="text-xs">{{ $t('networking.dns.mode') }}</Label>
                  <Select v-model="zone.mode">
                    <SelectTrigger class="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="forward">forward</SelectItem>
                      <SelectItem value="static">static</SelectItem>
                      <SelectItem value="block">block</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div v-if="zone.mode === 'forward'" class="grid gap-1.5">
                <Label class="text-xs">{{ $t('networking.dns.upstreams') }}</Label>
                <Input v-model="zone.upstreams" placeholder="1.1.1.1, tls://9.9.9.9" />
              </div>

              <div v-else-if="zone.mode === 'static'" class="space-y-2">
                <div class="flex items-center justify-between">
                  <Label class="text-xs">{{ $t('networking.dns.records') }}</Label>
                  <Button type="button" variant="outline" size="sm" @click="addRecord(zone)">
                    <Plus class="size-4" aria-hidden="true" /> {{ $t('networking.dns.addRecord') }}
                  </Button>
                </div>
                <div
                  v-for="(record, rIndex) in zone.records"
                  :key="rIndex"
                  class="grid items-end gap-2 sm:grid-cols-[1.3fr_0.8fr_1.5fr_0.7fr_auto]"
                >
                  <div class="grid gap-1">
                    <Label class="text-[10px] uppercase text-muted-foreground">{{ $t('networking.dns.recordName') }}</Label>
                    <Input v-model="record.name" placeholder="www" />
                  </div>
                  <div class="grid gap-1">
                    <Label class="text-[10px] uppercase text-muted-foreground">{{ $t('networking.dns.recordType') }}</Label>
                    <Select v-model="record.type">
                      <SelectTrigger class="w-full"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="A">A</SelectItem>
                        <SelectItem value="AAAA">AAAA</SelectItem>
                        <SelectItem value="CNAME">CNAME</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div class="grid gap-1">
                    <Label class="text-[10px] uppercase text-muted-foreground">{{ $t('networking.dns.recordValue') }}</Label>
                    <Input v-model="record.value" placeholder="10.0.0.5" />
                  </div>
                  <div class="grid gap-1">
                    <Label class="text-[10px] uppercase text-muted-foreground">{{ $t('networking.dns.recordTtl') }}</Label>
                    <Input v-model="record.ttl" type="number" min="1" max="86400" />
                  </div>
                  <Button type="button" variant="ghost" size="icon-sm" :aria-label="$t('networking.dns.removeRecord')" @click="removeRecord(zone, rIndex)">
                    <Trash2 class="size-4 text-destructive" />
                  </Button>
                </div>
              </div>

              <p v-else class="text-xs text-muted-foreground">{{ $t('networking.dns.blockModeHint') }}</p>
              <p v-if="zoneErrors[zIndex]" class="text-xs text-destructive">{{ zoneErrors[zIndex] }}</p>
            </div>
          </div>

          <!-- Public publishing -->
          <div class="space-y-3 rounded-lg border border-border p-3">
            <div class="flex items-center justify-between">
              <Label>{{ $t('networking.dns.publicPublishing') }}</Label>
            </div>
            <div class="grid gap-3 sm:grid-cols-2">
              <div class="grid gap-1.5">
                <Label class="text-xs">{{ $t('networking.dns.hostname') }}</Label>
                <Input v-model="form.hostname" placeholder="dns.example.com" />
              </div>
              <div class="grid gap-1.5">
                <Label class="text-xs">{{ $t('networking.dns.recordTtlLabel') }}</Label>
                <Input v-model="form.record_ttl" type="number" min="1" max="86400" :disabled="!form.hostname.trim()" />
              </div>
            </div>
            <div class="flex flex-wrap items-center gap-4 text-sm">
              <label class="flex items-center gap-1.5">
                <input v-model="form.publish_ipv4" type="checkbox" class="size-4 accent-primary" :disabled="!form.hostname.trim()" /> {{ $t('networking.dns.publishIpv4') }}
              </label>
              <label class="flex items-center gap-1.5">
                <input v-model="form.publish_ipv6" type="checkbox" class="size-4 accent-primary" :disabled="!form.hostname.trim()" /> {{ $t('networking.dns.publishIpv6') }}
              </label>
            </div>
            <div class="grid gap-3 sm:grid-cols-2">
              <div class="grid gap-1.5">
                <Label class="text-xs">{{ $t('networking.dns.cfApiToken') }}</Label>
                <Input
                  v-model="form.cf_api_token"
                  type="password"
                  autocomplete="off"
                  :placeholder="editingHasCredential ? $t('common.misc.keepBlank') : $t('networking.dns.cfTokenPlaceholder')"
                />
                <p v-if="editingHasCredential" class="text-xs text-muted-foreground">
                  {{ $t('networking.dns.credKeepHint') }}
                </p>
              </div>
              <div class="grid gap-1.5">
                <Label class="text-xs">{{ $t('networking.dns.ddnsProfileId') }}</Label>
                <Input v-model="form.ddns_profile_id" :placeholder="$t('networking.dns.ddnsProfilePlaceholder')" />
              </div>
            </div>
            <p v-if="hostnameNeedsCredential" class="text-xs text-destructive">
              {{ $t('networking.dns.hostnameNeedsCredential') }}
            </p>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" @click="dialogOpen = false">{{ $t('common.actions.cancel') }}</Button>
            <Button type="submit" :disabled="!canSubmit || saving">
              <RefreshCw v-if="saving" class="size-4 animate-spin" aria-hidden="true" />
              {{ editingId ? $t('common.actions.saveChanges') : $t('networking.dns.createDeployment') }}
            </Button>
          </DialogFooter>
        </form>
      </DialogScrollContent>
    </Dialog>

    <!-- Delete confirm dialog -->
    <ConfirmDialog
      :open="!!deleteTarget"
      :title="$t('networking.dns.deleteTitle')"
      :description="`${$t('networking.dns.deleteDescription')} ${deleteTarget?.name ?? ''}? ${$t('networking.dns.deleteIrreversible')}`"
      :confirm-label="$t('common.actions.delete')"
      :cancel-label="$t('common.actions.cancel')"
      :pending="deleting"
      @update:open="(v) => { if (!v) deleteTarget = undefined; }"
      @confirm="confirmDelete"
    />

    <!-- Plan review dialog -->
    <PlanReviewDialog
      :open="!!planApproval"
      :plan-text="planApproval?.plan"
      :digest="planSha"
      :badges="planBadges"
      :title="$t('networking.shared.planCreated')"
      :description="$t('networking.shared.planReviewHint')"
      :plan-label="$t('networking.shared.planLabel')"
      :close-label="$t('common.actions.close')"
      :approvals-label="$t('networking.shared.goToApprovals')"
      approvals-to="/approvals"
      @update:open="closePlan"
    />
  </div>
</template>

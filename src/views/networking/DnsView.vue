<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { RouterLink } from "vue-router";
import { toast } from "vue-sonner";
import {
  ExternalLink,
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
  if (!zone.suffix.trim()) return "suffix is required";
  if (zone.mode === "forward" && splitList(zone.upstreams).length === 0) {
    return "forward zones require at least one upstream";
  }
  if (zone.mode === "static" && zone.records.length === 0) {
    return "static zones require at least one record";
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
    toast.success(editingId.value ? "Deployment updated" : "Deployment created");
    dialogOpen.value = false;
    deploymentsQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "Failed to save deployment");
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
    toast.success("Deployment deleted");
    deleteTarget.value = undefined;
    deploymentsQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "Failed to delete deployment");
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
    toast.success(`published ipv4=${res.ipv4 || "—"} ipv6=${res.ipv6 || "—"}`);
    deploymentsQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "Publish failed");
  } finally {
    publishing.value = undefined;
  }
}

// ── Plan dialog ───────────────────────────────────────────────────────────
const planning = ref<string | undefined>(undefined);
const planApproval = ref<ApprovalView | undefined>(undefined);
const planSha = ref("");

async function plan(dep: DNSDeploymentView) {
  if (!canPlan.value) return;
  planning.value = dep.id;
  try {
    const approval = await api.dns.plan(dep.id);
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
</script>

<template>
  <div class="p-6 space-y-6">
    <PageHeader
      title="Self-host DNS"
      description="Per-node CoreDNS deployments with forward/static/block zones and optional public publishing"
    >
      <template #actions>
        <Button
          variant="outline"
          size="sm"
          :disabled="deploymentsQuery.refreshing.value"
          @click="deploymentsQuery.refresh"
        >
          <RefreshCw :class="cn('size-4', deploymentsQuery.refreshing.value && 'animate-spin')" />
          Refresh
        </Button>
        <Button v-if="canAdmin" size="sm" @click="openCreate">
          <Plus class="size-4" />
          New deployment
        </Button>
      </template>
    </PageHeader>

    <Card>
      <CardHeader>
        <CardTitle class="flex items-center gap-2">
          <Globe2 class="size-4 text-muted-foreground" />
          CoreDNS deployments
        </CardTitle>
        <CardDescription>
          Plan changes go through Approvals; publishing pushes public IPs to Cloudflare directly.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <DataState
          :loading="deploymentsQuery.loading.value"
          :error="deploymentsQuery.error.value"
          :is-empty="deployments.length === 0"
          empty-title="No DNS deployments"
          empty-description="Create a CoreDNS deployment to serve zones from a node."
          @retry="deploymentsQuery.refresh"
        >
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead>
                <tr class="border-b border-border text-left text-xs text-muted-foreground">
                  <th class="py-2 pr-3 font-medium">Name</th>
                  <th class="py-2 pr-3 font-medium">Node</th>
                  <th class="py-2 pr-3 font-medium">Listen</th>
                  <th class="py-2 pr-3 font-medium">Exposure</th>
                  <th class="py-2 pr-3 text-right font-medium">Zones</th>
                  <th class="py-2 pr-3 font-medium">Hostname</th>
                  <th class="py-2 pr-3 font-medium">Status</th>
                  <th class="py-2 pr-3 font-medium">Credential</th>
                  <th class="py-2 pr-3 font-medium">Published</th>
                  <th class="py-2 pl-3 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="dep in sortedDeployments"
                  :key="dep.id"
                  class="border-b border-border last:border-b-0 align-top hover:bg-muted/40"
                >
                  <td class="py-3 pr-3">
                    <div class="font-medium">{{ dep.name }}</div>
                    <div class="font-mono text-xs text-muted-foreground">{{ dep.engine }}{{ dep.engine_version ? ` ${dep.engine_version}` : "" }}</div>
                  </td>
                  <td class="py-3 pr-3">
                    <div>{{ nodeLabel(dep) }}</div>
                    <div class="font-mono text-xs text-muted-foreground">{{ shortId(dep.node_id, 12) }}</div>
                  </td>
                  <td class="py-3 pr-3 font-mono text-xs">
                    {{ dep.listen_port }}
                    <span class="text-muted-foreground">
                      {{ [dep.enable_udp ? "udp" : null, dep.enable_tcp ? "tcp" : null].filter(Boolean).join("/") }}
                    </span>
                  </td>
                  <td class="py-3 pr-3">
                    <Badge :variant="dep.exposure === 'public' ? 'warning' : 'secondary'">{{ dep.exposure }}</Badge>
                  </td>
                  <td class="py-3 pr-3 text-right tabular">{{ dep.zones.length }}</td>
                  <td class="py-3 pr-3 font-mono text-xs">{{ dep.hostname || "—" }}</td>
                  <td class="py-3 pr-3">
                    <Badge :variant="statusVariant(dep.status)">{{ dep.status }}</Badge>
                    <div v-if="dep.last_error" class="mt-1 max-w-[180px] text-xs text-destructive">{{ dep.last_error }}</div>
                  </td>
                  <td class="py-3 pr-3">
                    <Badge v-if="dep.has_credential" variant="success">
                      <KeyRound class="size-3" /> set
                    </Badge>
                    <Badge v-else variant="outline">none</Badge>
                  </td>
                  <td class="py-3 pr-3 text-xs text-muted-foreground">
                    <div>{{ dep.last_published_at ? formatDateTime(dep.last_published_at) : "—" }}</div>
                    <div v-if="dep.last_publish_error" class="mt-1 max-w-[180px] text-destructive">{{ dep.last_publish_error }}</div>
                  </td>
                  <td class="py-3 pl-3">
                    <div class="flex flex-wrap items-center justify-end gap-1">
                      <Button
                        v-if="canPlan"
                        variant="outline"
                        size="sm"
                        :disabled="planning === dep.id"
                        @click="plan(dep)"
                      >
                        <RefreshCw v-if="planning === dep.id" class="size-4 animate-spin" />
                        <Play v-else class="size-4" />
                        Plan
                      </Button>
                      <Button
                        v-if="canAdmin && dep.hostname"
                        variant="outline"
                        size="sm"
                        :disabled="publishing === dep.id"
                        @click="publish(dep)"
                      >
                        <RefreshCw v-if="publishing === dep.id" class="size-4 animate-spin" />
                        <UploadCloud v-else class="size-4" />
                        Publish
                      </Button>
                      <Button
                        v-if="canAdmin"
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Edit"
                        @click="openEdit(dep)"
                      >
                        <Pencil class="size-4" />
                      </Button>
                      <Button
                        v-if="canAdmin"
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Delete"
                        @click="deleteTarget = dep"
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
    <Dialog v-model:open="dialogOpen">
      <DialogScrollContent class="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{{ editingId ? "Edit deployment" : "New deployment" }}</DialogTitle>
          <DialogDescription>
            CoreDNS engine. A public hostname requires a Cloudflare credential.
          </DialogDescription>
        </DialogHeader>

        <form class="space-y-5" @submit.prevent="submit">
          <div class="grid gap-3 sm:grid-cols-2">
            <div class="grid gap-2">
              <Label for="dns-name">Name</Label>
              <Input id="dns-name" v-model="form.name" placeholder="edge-resolver" required />
            </div>
            <div class="grid gap-2">
              <Label for="dns-node">Node</Label>
              <Select v-model="form.node_id" :disabled="!!editingId">
                <SelectTrigger id="dns-node" class="w-full">
                  <SelectValue placeholder="Select a node" />
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
              <Label for="dns-port">Listen port</Label>
              <Input id="dns-port" v-model="form.listen_port" type="number" min="1" max="65535" />
            </div>
            <div class="grid gap-2">
              <Label>Protocols</Label>
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
              <Label for="dns-exposure">Exposure</Label>
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
              <Label>Zones</Label>
              <Button type="button" variant="outline" size="sm" @click="addZone">
                <Plus class="size-4" />
                Add zone
              </Button>
            </div>

            <div
              v-for="(zone, zIndex) in form.zones"
              :key="zIndex"
              class="space-y-3 rounded-lg border border-border p-3"
            >
              <div class="flex items-center justify-between">
                <span class="text-xs font-medium text-muted-foreground">Zone {{ zIndex + 1 }}</span>
                <Button type="button" variant="ghost" size="icon-sm" aria-label="Remove zone" @click="removeZone(zIndex)">
                  <Trash2 class="size-4 text-destructive" />
                </Button>
              </div>

              <div class="grid gap-3 sm:grid-cols-2">
                <div class="grid gap-1.5">
                  <Label class="text-xs">Suffix</Label>
                  <Input v-model="zone.suffix" placeholder="internal.example.com" />
                </div>
                <div class="grid gap-1.5">
                  <Label class="text-xs">Mode</Label>
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
                <Label class="text-xs">Upstreams</Label>
                <Input v-model="zone.upstreams" placeholder="1.1.1.1, tls://9.9.9.9" />
              </div>

              <div v-else-if="zone.mode === 'static'" class="space-y-2">
                <div class="flex items-center justify-between">
                  <Label class="text-xs">Records</Label>
                  <Button type="button" variant="outline" size="sm" @click="addRecord(zone)">
                    <Plus class="size-4" /> Add record
                  </Button>
                </div>
                <div
                  v-for="(record, rIndex) in zone.records"
                  :key="rIndex"
                  class="grid items-end gap-2 sm:grid-cols-[1.3fr_0.8fr_1.5fr_0.7fr_auto]"
                >
                  <div class="grid gap-1">
                    <Label class="text-[10px] uppercase text-muted-foreground">Name</Label>
                    <Input v-model="record.name" placeholder="www" />
                  </div>
                  <div class="grid gap-1">
                    <Label class="text-[10px] uppercase text-muted-foreground">Type</Label>
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
                    <Label class="text-[10px] uppercase text-muted-foreground">Value</Label>
                    <Input v-model="record.value" placeholder="10.0.0.5" />
                  </div>
                  <div class="grid gap-1">
                    <Label class="text-[10px] uppercase text-muted-foreground">TTL</Label>
                    <Input v-model="record.ttl" type="number" min="1" max="86400" />
                  </div>
                  <Button type="button" variant="ghost" size="icon-sm" aria-label="Remove record" @click="removeRecord(zone, rIndex)">
                    <Trash2 class="size-4 text-destructive" />
                  </Button>
                </div>
              </div>

              <p v-else class="text-xs text-muted-foreground">block mode returns NXDOMAIN for this suffix.</p>
              <p v-if="zoneErrors[zIndex]" class="text-xs text-destructive">{{ zoneErrors[zIndex] }}</p>
            </div>
          </div>

          <!-- Public publishing -->
          <div class="space-y-3 rounded-lg border border-border p-3">
            <div class="flex items-center justify-between">
              <Label>Public publishing (optional)</Label>
            </div>
            <div class="grid gap-3 sm:grid-cols-2">
              <div class="grid gap-1.5">
                <Label class="text-xs">Hostname</Label>
                <Input v-model="form.hostname" placeholder="dns.example.com" />
              </div>
              <div class="grid gap-1.5">
                <Label class="text-xs">Record TTL</Label>
                <Input v-model="form.record_ttl" type="number" min="1" max="86400" :disabled="!form.hostname.trim()" />
              </div>
            </div>
            <div class="flex flex-wrap items-center gap-4 text-sm">
              <label class="flex items-center gap-1.5">
                <input v-model="form.publish_ipv4" type="checkbox" class="size-4 accent-primary" :disabled="!form.hostname.trim()" /> Publish IPv4
              </label>
              <label class="flex items-center gap-1.5">
                <input v-model="form.publish_ipv6" type="checkbox" class="size-4 accent-primary" :disabled="!form.hostname.trim()" /> Publish IPv6
              </label>
            </div>
            <div class="grid gap-3 sm:grid-cols-2">
              <div class="grid gap-1.5">
                <Label class="text-xs">Cloudflare API token</Label>
                <Input
                  v-model="form.cf_api_token"
                  type="password"
                  autocomplete="off"
                  :placeholder="editingHasCredential ? 'leave blank to keep current' : 'cf token'"
                />
              </div>
              <div class="grid gap-1.5">
                <Label class="text-xs">DDNS profile id</Label>
                <Input v-model="form.ddns_profile_id" placeholder="optional alternative to token" />
              </div>
            </div>
            <p v-if="hostnameNeedsCredential" class="text-xs text-destructive">
              A hostname requires a Cloudflare credential — provide a token or a DDNS profile id.
            </p>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" @click="dialogOpen = false">Cancel</Button>
            <Button type="submit" :disabled="!canSubmit || saving">
              <RefreshCw v-if="saving" class="size-4 animate-spin" />
              {{ editingId ? "Save changes" : "Create deployment" }}
            </Button>
          </DialogFooter>
        </form>
      </DialogScrollContent>
    </Dialog>

    <!-- Delete confirm dialog -->
    <Dialog :open="!!deleteTarget" @update:open="(v) => { if (!v) deleteTarget = undefined; }">
      <DialogScrollContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete deployment</DialogTitle>
          <DialogDescription>
            Delete the DNS deployment
            <span class="font-medium">{{ deleteTarget?.name }}</span>? This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" @click="deleteTarget = undefined">Cancel</Button>
          <Button type="button" variant="destructive" :disabled="deleting" @click="confirmDelete">
            <RefreshCw v-if="deleting" class="size-4 animate-spin" />
            <Trash2 v-else class="size-4" />
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
              <ExternalLink class="size-4" />
              Go to Approvals
            </RouterLink>
          </Button>
        </DialogFooter>
      </DialogScrollContent>
    </Dialog>
  </div>
</template>

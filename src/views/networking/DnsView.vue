<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import {
  ChevronDown,
  Eye,
  Globe2,
  KeyRound,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  ShieldAlert,
  Trash2,
  UploadCloud,
} from "lucide-vue-next";
import {
  api,
  unwrap,
  type ApprovalView,
  type DNSDeploymentBody,
  type DNSDeploymentView,
  type DNSListener,
  type DNSRecord,
  type DNSZone,
  type GuardLintFinding,
} from "@/lib/api";
import {
  canPlanDeployment,
  DNS_COLUMN_SIZING,
  buildExternalDnsBody,
  canPublishDeployment,
  certDate,
  certExpiry,
  dnsHostnameSizing,
  dnsVisibleColumns,
  driftTone,
  externalHostnameProblem,
  isObservedEngine,
  isObservedOnlyTable,
  listenSummary,
  listenerProcesses,
} from "./dnsExternalModel";
import { ApiError } from "@/lib/api/client";
import { useAsyncData } from "@/composables/useAsyncData";
import { usePlanDigest } from "@/composables/usePlanDigest";
import { useAuthStore } from "@/stores/auth";
import { formatDateTime, shortId } from "@/lib/format";
import { fieldNumber } from "@/lib/formValue";
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
import { Checkbox } from "@/components/ui/checkbox";
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
  (signal) => api.dns.deployments({ signal }).then((r) => unwrap(r, "deployments")),
  { pollInterval: 15000 },
);
const nodesQuery = useAsyncData((signal) => api.nodes.list({ signal }).then((r) => unwrap(r, "nodes")), {
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

function statusVariant(status: string): "success" | "destructive" | "warning" | "secondary" | "outline" {
  switch (status) {
    case "running":
      return "success";
    // Observed is not a health claim: it says Lattice watches this daemon and
    // never touched it. A green badge would read as "Lattice has it running".
    case "observed":
      return "outline";
    case "failed":
      return "destructive";
    case "pending":
    case "applying":
      return "warning";
    default:
      return "secondary";
  }
}

/** The certificate line in the Reality column: how long is left, and when. */
function certLabel(dep: DNSDeploymentView): string {
  const expiry = certExpiry(dep.cert_not_after, new Date());
  if (expiry.tone === "unknown") return t("networking.dns.certUnknown");
  const date = certDate(dep.cert_not_after);
  if (expiry.tone === "expired") return t("networking.dns.certExpired", { date });
  return t("networking.dns.certDays", { days: expiry.days, date });
}

function certToneClass(dep: DNSDeploymentView): string {
  switch (certExpiry(dep.cert_not_after, new Date()).tone) {
    case "expired":
      return "text-destructive";
    case "warn":
      return "text-warning";
    default:
      return "text-muted-foreground";
  }
}

/**
 * Whether the table is showing nothing but daemons Lattice watches. Two of the
 * eleven columns describe an intent Lattice holds, and an observed record
 * holds neither, so on such a table they are two columns of "·" charging the
 * hostname beside them about ninety pixels each.
 */
const observedOnly = computed(() => isObservedOnlyTable(sortedDeployments.value));

const columns = computed<DataTableColumn<DNSDeploymentView>[]>(() => [
  { key: "name", label: t("networking.dns.colName"), sortable: true, searchable: true },
  {
    key: "node",
    label: t("networking.dns.colNode"),
    sortable: true,
    searchable: true,
    value: (dep) => nodeLabel(dep),
    class: DNS_COLUMN_SIZING.node,
  },
  {
    key: "listen",
    label: t("networking.dns.colListen"),
    sortable: true,
    searchable: true,
    value: (dep) => listenSummary(dep),
  },
  { key: "exposure", label: t("networking.dns.colExposure"), sortable: true },
  { key: "zones", label: t("networking.dns.colZones"), align: "right", sortable: true, value: (dep) => dep.zones.length },
  {
    key: "hostname",
    label: t("networking.dns.colHostname"),
    sortable: true,
    searchable: true,
    class: dnsHostnameSizing(observedOnly.value),
  },
  { key: "status", label: t("networking.dns.colStatus"), sortable: true },
  {
    key: "reality",
    label: t("networking.dns.colReality"),
    sortable: true,
    value: (dep) => dep.drift?.status ?? "",
    class: DNS_COLUMN_SIZING.reality,
  },
  { key: "credential", label: t("networking.dns.colCredential"), sortable: true, value: (dep) => (dep.has_credential ? 1 : 0) },
  { key: "published", label: t("networking.dns.colPublished"), sortable: true, value: (dep) => dep.last_published_at ?? "" },
  { key: "actions", label: t("networking.dns.colActions"), align: "right" },
]);

/** The columns actually rendered: the intent pair leaves an observed-only table. */
const visibleColumns = computed(() => dnsVisibleColumns(columns.value, observedOnly.value));

/**
 * Observed records whose drift findings are open.
 *
 * The findings are sentences, and a table column is the one place a sentence
 * cannot be given room: auto layout hands width to whatever cannot wrap, so
 * the prose column loses to the mono ones every time. The verdict and the
 * certificate countdown stay in the row because they are short and are what
 * the operator scans for; the sentences that explain a verdict open under the
 * row at the table's full width.
 */
const openDrift = ref<Set<string>>(new Set());

function driftFindings(dep: DNSDeploymentView): string[] {
  return dep.drift?.findings ?? [];
}

function isDriftOpen(dep: DNSDeploymentView): boolean {
  return openDrift.value.has(dep.id);
}

function toggleDrift(dep: DNSDeploymentView) {
  const next = new Set(openDrift.value);
  if (next.has(dep.id)) next.delete(dep.id);
  else next.add(dep.id);
  openDrift.value = next;
}

// ── Zone / record editor drafts ───────────────────────────────────────────
type ZoneMode = "forward" | "static" | "block";

interface RecordDraft {
  name: string;
  type: string;
  value: string;
  /** Bound to a numeric input, so Vue hands back a number once edited. */
  ttl: string | number;
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

/**
 * One socket the operator claims the observed daemon owns. Bound to number
 * inputs, so Vue hands the port back as a number once it has been edited.
 */
interface ListenerDraft {
  protocol: "tcp" | "udp";
  port: string | number;
}

function emptyListener(): ListenerDraft {
  return { protocol: "udp", port: "53" };
}

interface DnsForm {
  /**
   * `coredns` is a daemon Lattice installs and configures through an approved
   * plan. `external` is one the operator already runs and Lattice only
   * watches, so the whole apply half of this form is off for it.
   */
  engine: "coredns" | "external";
  listeners: ListenerDraft[];
  /** Date input value, `YYYY-MM-DD`; sent as an instant at midnight UTC. */
  cert_not_after: string;
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
  /** Bound to a numeric input, so Vue hands back a number once edited. */
  record_ttl: string | number;
  cf_api_token: string;
  ddns_profile_id: string;
}

const dialogOpen = ref(false);
const editingId = ref<string | undefined>(undefined);
/**
 * The record being edited, kept whole.
 *
 * The observed branch of this form does not show exposure or zones, and a DNS
 * upsert replaces the stored record rather than merging into it. So the record
 * has to be carried across the save, or the fields the form never showed are
 * the fields the save destroys.
 */
const editingRecord = ref<DNSDeploymentView | undefined>(undefined);
const editingHasCredential = ref(false);
const saving = ref(false);
const form = reactive<DnsForm>(emptyForm());

// Snapshot of the form at open time, drives the unsaved-changes (dirty) guard.
// The dialog carries a Cloudflare token, so an accidental Escape must not throw
// it away silently.
const formSnapshot = ref("");
function snapshotForm(): string {
  return JSON.stringify(form);
}
const isDirty = computed(() => dialogOpen.value && snapshotForm() !== formSnapshot.value);
const discardConfirmOpen = ref(false);

/** Intercept dialog close: when dirty, ask before discarding. */
function requestCloseDialog() {
  if (isDirty.value && !saving.value) {
    discardConfirmOpen.value = true;
    return;
  }
  dialogOpen.value = false;
}

function onDialogOpenChange(open: boolean) {
  if (open) {
    dialogOpen.value = true;
    return;
  }
  requestCloseDialog();
}

function confirmDiscard() {
  discardConfirmOpen.value = false;
  dialogOpen.value = false;
}

function emptyForm(): DnsForm {
  return {
    engine: "coredns",
    listeners: [emptyListener()],
    cert_not_after: "",
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
  editingRecord.value = undefined;
  editingHasCredential.value = false;
  Object.assign(form, emptyForm());
  formSnapshot.value = snapshotForm();
  dialogOpen.value = true;
}

function openEdit(dep: DNSDeploymentView) {
  editingId.value = dep.id;
  editingRecord.value = dep;
  editingHasCredential.value = dep.has_credential;
  Object.assign(form, {
    engine: isObservedEngine(dep.engine) ? "external" : "coredns",
    listeners: dep.listeners?.length ? dep.listeners.map(listenerToDraft) : [emptyListener()],
    cert_not_after: certDateValue(dep.cert_not_after),
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
  formSnapshot.value = snapshotForm();
  dialogOpen.value = true;
}

function listenerToDraft(listener: DNSListener): ListenerDraft {
  return {
    protocol: listener.protocol === "tcp" ? "tcp" : "udp",
    port: String(listener.port),
  };
}

/** The `YYYY-MM-DD` a date input wants, or "" for an unknown or zero expiry. */
function certDateValue(value: string | undefined): string {
  const raw = (value ?? "").trim();
  if (!raw || raw.startsWith("0001")) return "";
  const at = new Date(raw);
  return Number.isNaN(at.getTime()) ? "" : at.toISOString().slice(0, 10);
}

function addListener() {
  form.listeners.push(emptyListener());
}
function removeListener(index: number) {
  form.listeners.splice(index, 1);
}

/** The form is describing a daemon Lattice only watches. */
const isExternalForm = computed(() => form.engine === "external");

/** A listener draft that could not be sent, keyed by position. */
const listenerErrors = computed(() =>
  form.listeners.map((listener) => {
    const port = Number(listener.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return t("networking.dns.errListenerPort");
    }
    return undefined;
  }),
);
const hasListenerErrors = computed(() => listenerErrors.value.some((e) => e !== undefined));

/**
 * An observed record has to name the hostname the daemon answers at, and that
 * hostname has to be a fully qualified domain: the server refuses anything
 * else, and it is the only handle the certificate watch can be pointed at.
 */
const externalHostnameValid = computed(() => externalHostnameProblem(form.hostname) === undefined);

/**
 * What to tell the operator, once they have typed something.
 *
 * An empty field is not an error yet: it is a field they have not reached.
 * A single label is, and saying so is the whole point, because the hint under
 * this input describes what the field is for and turning it red says nothing
 * about what to type instead.
 */
const externalHostnameError = computed(() =>
  externalHostnameProblem(form.hostname) === "not_fqdn" ? t("networking.dns.errExternalHostname") : undefined,
);

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

const canSubmit = computed(() => {
  if (!canAdmin.value || !form.name.trim() || !form.node_id) return false;
  if (isExternalForm.value) {
    return externalHostnameValid.value && form.listeners.length > 0 && !hasListenerErrors.value;
  }
  return form.zones.length > 0 && !hasZoneErrors.value && !hostnameNeedsCredential.value;
});

function buildBody(): DNSDeploymentBody {
  if (isExternalForm.value) return buildExternalBody();
  const zones: DNSZone[] = form.zones.map((zone) => {
    const base: DNSZone = { suffix: zone.suffix.trim(), mode: zone.mode };
    if (zone.mode === "forward") base.upstreams = splitList(zone.upstreams);
    if (zone.mode === "static") {
      base.records = zone.records.map<DNSRecord>((r) => ({
        name: r.name.trim(),
        type: r.type,
        value: r.value.trim(),
        ...(fieldNumber(r.ttl) === undefined ? {} : { ttl: fieldNumber(r.ttl) }),
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
    const recordTtl = fieldNumber(form.record_ttl);
    if (recordTtl !== undefined) body.record_ttl = recordTtl;
  }
  // Write-only secret: only send when the operator typed a new value.
  if (form.cf_api_token.trim()) body.cf_api_token = form.cf_api_token.trim();
  if (form.ddns_profile_id.trim()) body.ddns_profile_id = form.ddns_profile_id.trim();

  return body;
}

/**
 * The observed body carries no publishing and no credential, and hands back
 * the exposure and the zones the record already held. The two fields are not
 * on this form and the server replaces rather than merges, so leaving them out
 * is not neutral: it publishes a mesh-only resolver and drops its zones.
 */
function buildExternalBody(): DNSDeploymentBody {
  return buildExternalDnsBody(
    {
      id: editingId.value,
      name: form.name,
      node_id: form.node_id,
      hostname: form.hostname,
      listeners: form.listeners,
      cert_not_after: form.cert_not_after,
    },
    editingRecord.value,
  );
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
//
// Publishing writes public DNS for a live deployment the moment it is clicked,
// so it goes through a confirmation that names the hostname and its zones.
const publishing = ref<string | undefined>(undefined);
const publishTarget = ref<DNSDeploymentView | undefined>(undefined);

/** Zone suffixes of the pending publish target, for the confirmation copy. */
const publishZones = computed(() => {
  const dep = publishTarget.value;
  if (!dep) return "";
  const suffixes = dep.zones.map((zone) => zone.suffix).filter(Boolean);
  return suffixes.length ? suffixes.join(", ") : t("common.misc.none");
});

async function confirmPublish() {
  const dep = publishTarget.value;
  if (!dep || !canAdmin.value) return;
  publishing.value = dep.id;
  try {
    const res = await api.dns.publish(dep.id);
    const none = t("common.misc.none");
    toast.success(t("networking.dns.toastPublished", { ipv4: res.ipv4 || none, ipv6: res.ipv6 || none }));
    publishTarget.value = undefined;
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

/** Lint findings the server returned with the plan, blocking ones first. */
const planFindings = ref<GuardLintFinding[]>([]);

/**
 * A DNS plan replaces the node's whole lattice_guard input chain, and that
 * chain is default-drop. When the server can see that the composed ruleset
 * would leave no way back into the node it refuses the plan with 409 and the
 * findings, and the operator has to accept the risk on purpose. This holds the
 * refused deployment until they do or back out.
 */
const blockedDep = ref<DNSDeploymentView | undefined>(undefined);
const blockedFindings = ref<GuardLintFinding[]>([]);
const acceptLockoutRisk = ref(false);

/** Blocking findings first: they decide whether the plan can be filed at all. */
function sortFindings(findings: GuardLintFinding[]): GuardLintFinding[] {
  const rank = (f: GuardLintFinding) => (f.severity === "block" ? 0 : f.severity === "warn" ? 1 : 2);
  return [...findings].sort((a, b) => rank(a) - rank(b) || a.code.localeCompare(b.code));
}

async function plan(dep: DNSDeploymentView, acceptRisk = false) {
  if (!canPlan.value) return;
  planning.value = dep.id;
  try {
    const res = await api.dns.plan(dep.id, acceptRisk);
    planApproval.value = res.approval;
    planFindings.value = sortFindings(res.findings ?? []);
    planSha.value = await planDigest.digestFor(res.approval);
    blockedDep.value = undefined;
    blockedFindings.value = [];
    acceptLockoutRisk.value = false;
    toast.success(t("networking.shared.toastPlanCreated"));
  } catch (error) {
    const findings =
      error instanceof ApiError && error.status === 409
        ? ((error.body as { findings?: GuardLintFinding[] } | undefined)?.findings ?? [])
        : [];
    if (findings.length) {
      blockedDep.value = dep;
      blockedFindings.value = sortFindings(findings);
      acceptLockoutRisk.value = false;
      return;
    }
    toast.error(error instanceof Error ? error.message : t("networking.shared.toastPlanFailed"));
  } finally {
    planning.value = undefined;
  }
}

function closeBlocked(open: boolean) {
  if (!open) {
    blockedDep.value = undefined;
    blockedFindings.value = [];
    acceptLockoutRisk.value = false;
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
    planFindings.value = [];
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
          state-key="deployments"
          :columns="visibleColumns"
          :rows="sortedDeployments"
          :row-key="(dep) => dep.id"
          :row-expanded="isDriftOpen"
          :loading="deploymentsQuery.loading.value"
          :error="deploymentsQuery.error.value"
          searchable
          :search-placeholder="$t('common.actions.search')"
          :empty-title="$t('networking.dns.emptyTitle')"
          :empty-description="$t('networking.dns.emptyDescription')"
          :no-match-title="$t('networking.shared.noMatchTitle')"
          :no-match-description="$t('networking.shared.noMatchDescription')"
          @retry="deploymentsQuery.refresh"
        >
          <template #cell-name="{ row: dep }">
            <div class="flex items-center gap-1.5">
              <Eye
                v-if="isObservedEngine(dep.engine)"
                class="size-3.5 shrink-0 text-muted-foreground"
                :aria-label="$t('networking.dns.observedAria')"
              />
              <span class="font-medium">{{ dep.name }}</span>
            </div>
            <div class="font-mono text-xs text-muted-foreground">
              {{ dep.engine }}{{ dep.engine_version ? ` ${dep.engine_version}` : "" }}
              <template v-if="listenerProcesses(dep.listeners).length">
                · {{ listenerProcesses(dep.listeners).join(", ") }}
              </template>
            </div>
          </template>
          <template #cell-node="{ row: dep }">
            <div class="truncate" :title="nodeLabel(dep)">{{ nodeLabel(dep) }}</div>
            <div class="truncate font-mono text-xs text-muted-foreground">{{ shortId(dep.node_id, 12) }}</div>
          </template>
          <template #cell-listen="{ row: dep }">
            <span class="font-mono text-xs">{{ listenSummary(dep) }}</span>
          </template>
          <!--
            Credential and publish history describe an intent Lattice holds,
            and an observed record holds neither, so those print nothing rather
            than a "none" that reads as a fact about the operator's daemon.

            Exposure and zones are different: the server keeps both on an
            observed record, as the operator's own documentation of what the
            daemon serves and who can reach it. They are printed in a neutral
            tone, because on an observed row they are a note and not something
            Lattice arranged, and they are printed at all because a field no
            cell ever shows is a field a save can destroy unnoticed.
          -->
          <template #cell-exposure="{ row: dep }">
            <Badge
              v-if="!isObservedEngine(dep.engine)"
              :variant="dep.exposure === 'public' ? 'warning' : 'secondary'"
            >
              {{ dep.exposure }}
            </Badge>
            <Badge v-else-if="dep.exposure" variant="outline">{{ dep.exposure }}</Badge>
            <span v-else class="text-muted-foreground">·</span>
          </template>
          <template #cell-zones="{ row: dep }">
            <span v-if="!isObservedEngine(dep.engine) || dep.zones.length" class="tabular-nums">
              {{ dep.zones.length }}
            </span>
            <span v-else class="text-muted-foreground">·</span>
          </template>
          <!--
            Truncation is the ceiling's other half: once the column reserves
            its width there is nothing left to clip, and a hostname printed in
            full is the point. A tooltip was the only recovery before, and a
            keyboard or touch reader has no way to open one.
          -->
          <template #cell-hostname="{ row: dep }">
            <div
              :class="observedOnly ? 'font-mono text-xs' : 'truncate font-mono text-xs'"
              :title="dep.hostname || ''"
            >{{ dep.hostname || $t('common.misc.none') }}</div>
          </template>
          <template #cell-status="{ row: dep }">
            <Badge :variant="statusVariant(dep.status)">{{ dep.status }}</Badge>
            <div v-if="dep.last_error" class="mt-1 max-w-[180px] truncate text-xs text-destructive" :title="dep.last_error">{{ dep.last_error }}</div>
          </template>
          <!--
            The observed half of the page. A record Lattice deploys has an
            intent to compare against; a record it only watches has nothing but
            the node's own report, so this column is the whole verdict: when
            the certificate lapses, and whether the sockets are still where the
            operator said they were.
          -->
          <template #cell-reality="{ row: dep }">
            <div v-if="isObservedEngine(dep.engine)" class="space-y-1">
              <div class="flex flex-wrap items-center gap-1.5">
                <Badge :variant="driftTone(dep.drift?.status)">
                  <ShieldAlert v-if="dep.drift?.status === 'drift'" class="size-3" aria-hidden="true" />
                  {{ $t(`networking.dns.drift.${dep.drift?.status ?? 'unknown'}`) }}
                </Badge>
              </div>
              <div :class="certToneClass(dep)" class="text-xs">{{ certLabel(dep) }}</div>
              <Button
                v-if="driftFindings(dep).length"
                variant="ghost"
                size="sm"
                class="-ms-2 h-6 px-2 text-xs"
                :aria-expanded="isDriftOpen(dep)"
                @click="toggleDrift(dep)"
              >
                <ChevronDown
                  :class="cn('size-3.5 transition-transform', isDriftOpen(dep) && 'rotate-180')"
                  aria-hidden="true"
                />
                {{ $t('networking.dns.driftFindingsToggle', driftFindings(dep).length) }}
              </Button>
            </div>
            <span v-else class="text-xs text-muted-foreground">{{ $t('networking.dns.realityNotObserved') }}</span>
          </template>
          <!--
            The findings, at the table's width instead of a column's. Named by
            the record they belong to, because a panel under a row still has to
            say which row it came from once it is scrolled past.
          -->
          <template #row-detail="{ row: dep }">
            <div class="space-y-1.5 rounded-md border border-border bg-background p-3">
              <p class="text-xs font-medium">
                {{ $t('networking.dns.driftFindingsTitle', { name: dep.name }) }}
              </p>
              <ul class="space-y-1">
                <li
                  v-for="(finding, index) in driftFindings(dep)"
                  :key="index"
                  class="text-xs leading-relaxed text-muted-foreground"
                >
                  {{ finding }}
                </li>
              </ul>
              <p v-if="dep.drift?.reality_collected_at" class="text-xs text-muted-foreground">
                {{ $t('networking.dns.realityCollected', { time: formatDateTime(dep.drift.reality_collected_at) }) }}
              </p>
            </div>
          </template>
          <template #cell-credential="{ row: dep }">
            <span v-if="isObservedEngine(dep.engine)" class="text-muted-foreground">·</span>
            <Badge v-else-if="dep.has_credential" variant="success">
              <KeyRound class="size-3" aria-hidden="true" /> {{ $t('networking.dns.credSet') }}
            </Badge>
            <Badge v-else variant="outline">{{ $t('networking.dns.credNone') }}</Badge>
          </template>
          <template #cell-published="{ row: dep }">
            <span v-if="isObservedEngine(dep.engine)" class="text-muted-foreground">·</span>
            <div v-else class="text-xs text-muted-foreground">{{ dep.last_published_at ? formatDateTime(dep.last_published_at) : $t('common.misc.none') }}</div>
            <div v-if="dep.last_publish_error" class="mt-1 max-w-[180px] truncate text-xs text-destructive" :title="dep.last_publish_error">{{ dep.last_publish_error }}</div>
          </template>
          <template #cell-actions="{ row: dep }">
            <div class="flex flex-wrap items-center justify-end gap-1">
              <span v-if="isObservedEngine(dep.engine)" class="mr-1 text-xs text-muted-foreground">
                {{ $t('networking.dns.observedNoActions') }}
              </span>
              <Button
                v-if="canPlan && canPlanDeployment(dep)"
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
                v-if="canAdmin && canPublishDeployment(dep)"
                variant="outline"
                size="sm"
                :disabled="publishing === dep.id"
                @click="publishTarget = dep"
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
    <Dialog :open="dialogOpen" @update:open="onDialogOpenChange">
      <DialogScrollContent class="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{{ editingId ? $t('networking.dns.editTitle') : $t('networking.dns.newTitle') }}</DialogTitle>
          <DialogDescription>
            {{ isExternalForm ? $t('networking.dns.dialogDescriptionExternal') : $t('networking.dns.dialogDescription') }}
          </DialogDescription>
        </DialogHeader>

        <form class="space-y-5" @submit.prevent="submit">
          <!--
            The engine is the first choice because it decides what the rest of
            this form means. Deploying writes a Corefile and a packet filter on
            the node through an approved plan; observing writes a row on this
            server and nothing else, ever. The engine cannot be changed on an
            existing record: the two kinds do not convert into each other.
          -->
          <div class="grid gap-2">
            <Label for="dns-engine">{{ $t('networking.dns.engine') }}</Label>
            <Select v-model="form.engine" :disabled="!!editingId">
              <SelectTrigger id="dns-engine" class="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="coredns">{{ $t('networking.dns.engineCoredns') }}</SelectItem>
                <SelectItem value="external">{{ $t('networking.dns.engineExternal') }}</SelectItem>
              </SelectContent>
            </Select>
            <p class="text-xs text-muted-foreground">
              {{ isExternalForm ? $t('networking.dns.engineExternalHint') : $t('networking.dns.engineCorednsHint') }}
            </p>
          </div>

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

          <!-- Observed engine: the sockets the daemon holds, and its certificate. -->
          <div v-if="isExternalForm" class="space-y-4">
            <div class="grid gap-2">
              <Label for="dns-external-hostname">{{ $t('networking.dns.hostname') }}</Label>
              <Input
                id="dns-external-hostname"
                v-model="form.hostname"
                placeholder="dns.example.com"
                :aria-invalid="!!externalHostnameError"
                :aria-describedby="externalHostnameError ? 'dns-external-hostname-error' : undefined"
                required
              />
              <p class="text-xs text-muted-foreground">
                {{ $t('networking.dns.externalHostnameHint') }}
              </p>
              <p
                v-if="externalHostnameError"
                id="dns-external-hostname-error"
                role="alert"
                class="text-xs text-destructive"
              >
                {{ externalHostnameError }}
              </p>
            </div>

            <div class="space-y-3 rounded-lg border border-border p-3">
              <div class="flex items-center justify-between">
                <Label>{{ $t('networking.dns.listeners') }}</Label>
                <Button type="button" variant="outline" size="sm" @click="addListener">
                  <Plus class="size-4" aria-hidden="true" />
                  {{ $t('networking.dns.addListener') }}
                </Button>
              </div>
              <p class="text-xs text-muted-foreground">{{ $t('networking.dns.listenersHint') }}</p>
              <div
                v-for="(listener, lIndex) in form.listeners"
                :key="lIndex"
                class="grid items-end gap-2 sm:grid-cols-[1fr_1fr_auto]"
              >
                <div class="grid gap-1">
                  <Label class="text-[10px] uppercase text-muted-foreground">{{ $t('networking.dns.listenerProtocol') }}</Label>
                  <Select v-model="listener.protocol">
                    <SelectTrigger class="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="udp">udp</SelectItem>
                      <SelectItem value="tcp">tcp</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div class="grid gap-1">
                  <Label class="text-[10px] uppercase text-muted-foreground">{{ $t('networking.dns.listenerPort') }}</Label>
                  <Input v-model="listener.port" type="number" min="1" max="65535" />
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  :disabled="form.listeners.length < 2"
                  :aria-label="$t('networking.dns.removeListener')"
                  @click="removeListener(lIndex)"
                >
                  <Trash2 class="size-4 text-destructive" />
                </Button>
                <p v-if="listenerErrors[lIndex]" class="text-xs text-destructive sm:col-span-3">
                  {{ listenerErrors[lIndex] }}
                </p>
              </div>
            </div>

            <div class="grid gap-2">
              <Label for="dns-cert">{{ $t('networking.dns.certNotAfter') }}</Label>
              <Input id="dns-cert" v-model="form.cert_not_after" type="date" class="w-full sm:w-56" />
              <p class="text-xs text-muted-foreground">{{ $t('networking.dns.certNotAfterHint') }}</p>
            </div>
          </div>

          <div v-if="!isExternalForm" class="grid gap-3 sm:grid-cols-3">
            <div class="grid gap-2">
              <Label for="dns-port">{{ $t('networking.dns.listenPort') }}</Label>
              <Input id="dns-port" v-model="form.listen_port" type="number" min="1" max="65535" />
            </div>
            <div class="grid gap-2">
              <Label>{{ $t('networking.dns.protocols') }}</Label>
              <div class="flex h-9 items-center gap-4 rounded-md border border-input px-3 text-sm">
                <label class="flex cursor-pointer items-center gap-1.5">
                  <Checkbox v-model="form.enable_udp" /> UDP
                </label>
                <label class="flex cursor-pointer items-center gap-1.5">
                  <Checkbox v-model="form.enable_tcp" /> TCP
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
          <div v-if="!isExternalForm" class="space-y-3">
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
          <div v-if="!isExternalForm" class="space-y-3 rounded-lg border border-border p-3">
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
                <Input
                  v-model="form.record_ttl"
                  type="number"
                  min="1"
                  max="86400"
                  :disabled="!form.hostname.trim()"
                  :title="!form.hostname.trim() ? $t('networking.dns.publishNeedsHostname') : undefined"
                />
              </div>
            </div>
            <div class="flex flex-wrap items-center gap-4 text-sm">
              <label
                class="flex cursor-pointer items-center gap-1.5"
                :title="!form.hostname.trim() ? $t('networking.dns.publishNeedsHostname') : undefined"
              >
                <Checkbox v-model="form.publish_ipv4" :disabled="!form.hostname.trim()" /> {{ $t('networking.dns.publishIpv4') }}
              </label>
              <label
                class="flex cursor-pointer items-center gap-1.5"
                :title="!form.hostname.trim() ? $t('networking.dns.publishNeedsHostname') : undefined"
              >
                <Checkbox v-model="form.publish_ipv6" :disabled="!form.hostname.trim()" /> {{ $t('networking.dns.publishIpv6') }}
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
            <Button type="button" variant="outline" @click="requestCloseDialog">{{ $t('common.actions.cancel') }}</Button>
            <Button type="submit" :disabled="!canSubmit || saving">
              <RefreshCw v-if="saving" class="size-4 animate-spin" aria-hidden="true" />
              {{ editingId ? $t('common.actions.saveChanges') : $t('networking.dns.createDeployment') }}
            </Button>
          </DialogFooter>
        </form>
      </DialogScrollContent>
    </Dialog>

    <!-- Publish confirm: this writes public DNS immediately, with no approval. -->
    <ConfirmDialog
      :open="!!publishTarget"
      variant="default"
      :title="$t('networking.dns.publishTitle')"
      :description="$t('networking.dns.publishDescription', {
        hostname: publishTarget?.hostname ?? '',
        zones: publishZones,
      })"
      :confirm-label="$t('common.actions.publish')"
      :cancel-label="$t('common.actions.cancel')"
      :pending="!!publishing"
      @update:open="(v) => { if (!v) publishTarget = undefined; }"
      @confirm="confirmPublish"
    />

    <!-- Unsaved-changes (dirty) guard: the form carries a Cloudflare token. -->
    <ConfirmDialog
      :open="discardConfirmOpen"
      variant="destructive"
      :title="$t('networking.shared.discardTitle')"
      :description="$t('networking.shared.discardDescription')"
      :confirm-label="$t('networking.shared.discardConfirm')"
      :cancel-label="$t('common.actions.cancel')"
      @update:open="(v) => { if (!v) discardConfirmOpen = false; }"
      @confirm="confirmDiscard"
    />

    <!-- Delete confirm dialog -->
    <ConfirmDialog
      :open="!!deleteTarget"
      :title="$t('networking.dns.deleteTitle')"
      :description="`${$t('networking.dns.deleteDescription')} ${deleteTarget?.name ?? ''}? ${
        deleteTarget && isObservedEngine(deleteTarget.engine)
          ? $t('networking.dns.deleteObserved')
          : $t('networking.dns.deleteIrreversible')
      }`"
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
    >
      <!--
        The badges slot carries the findings too. A filed plan can still hold
        warnings (an assumed management port, an unverifiable apply), and the
        reviewer needs them next to the plan text rather than lost in a toast.
      -->
      <template #badges>
        <div class="flex w-full flex-col gap-2">
          <div class="flex flex-wrap items-center gap-2">
            <Badge v-for="(badge, index) in planBadges" :key="index" :variant="badge.variant">
              {{ badge.label }}
            </Badge>
          </div>
          <ul v-if="planFindings.length" class="space-y-1">
            <li v-for="finding in planFindings" :key="finding.code" class="flex items-start gap-2 text-xs">
              <Badge class="mt-px shrink-0" :variant="finding.severity === 'block' ? 'destructive' : 'warning'">
                {{ finding.severity }}
              </Badge>
              <span class="min-w-0">
                <code class="font-mono">{{ finding.code }}</code>
                <span class="ml-1 text-muted-foreground">{{ finding.message }}</span>
              </span>
            </li>
          </ul>
        </div>
      </template>
    </PlanReviewDialog>

    <!--
      Refused plan. The node-side apply cannot catch this class on its own: its
      post-commit selfcheck is an outbound call, which a default-drop input
      ruleset still lets through. So the refusal is the last line, and getting
      past it is a deliberate, audited act.
    -->
    <Dialog :open="!!blockedDep" @update:open="closeBlocked">
      <DialogScrollContent class="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{{ $t('networking.dns.lockout.title') }}</DialogTitle>
          <DialogDescription>
            {{ $t('networking.dns.lockout.description', { name: blockedDep?.name ?? '', node: blockedDep?.node_name || blockedDep?.node_id || '' }) }}
          </DialogDescription>
        </DialogHeader>

        <ul class="space-y-2">
          <li v-for="finding in blockedFindings" :key="finding.code" class="flex items-start gap-2 text-sm">
            <Badge class="mt-px shrink-0" :variant="finding.severity === 'block' ? 'destructive' : 'warning'">
              {{ finding.severity }}
            </Badge>
            <span class="min-w-0">
              <code class="font-mono text-xs">{{ finding.code }}</code>
              <span class="ml-1 text-muted-foreground">{{ finding.message }}</span>
            </span>
          </li>
        </ul>

        <p class="text-sm text-muted-foreground">{{ $t('networking.dns.lockout.remedy') }}</p>

        <label class="flex items-start gap-3 text-sm">
          <Checkbox
            class="mt-0.5"
            :model-value="acceptLockoutRisk"
            @update:model-value="(v) => (acceptLockoutRisk = v === true)"
          />
          <span class="space-y-1">
            <span class="block font-medium">{{ $t('networking.dns.lockout.accept') }}</span>
            <span class="block text-muted-foreground">{{ $t('networking.dns.lockout.acceptHint') }}</span>
          </span>
        </label>

        <DialogFooter>
          <Button variant="outline" @click="closeBlocked(false)">{{ $t('common.actions.cancel') }}</Button>
          <Button
            variant="destructive"
            :disabled="!acceptLockoutRisk || planning === blockedDep?.id"
            @click="blockedDep && plan(blockedDep, true)"
          >
            <RefreshCw v-if="planning === blockedDep?.id" class="size-4 animate-spin" aria-hidden="true" />
            {{ $t('networking.dns.lockout.planAnyway') }}
          </Button>
        </DialogFooter>
      </DialogScrollContent>
    </Dialog>
  </div>
</template>

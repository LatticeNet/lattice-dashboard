<script setup lang="ts">
/**
 * Self-host DNS (design 23, section 4.4): the resolvers on the fleet, the
 * CoreDNS ones Lattice deploys and the ones it only watches.
 *
 * The head counts them and what is wrong (a failed apply or publish, drift,
 * a certificate that lapses); attention names each with its proof. With no
 * resolver the page is a checklist read from live state, with the two ways
 * in. A row opens the resolver in the sheet on `?open=`, which holds what
 * the eleven columns used to (zones, exposure, publish history, drift
 * findings); Plan, Publish, Edit and Delete sit in one row menu.
 *
 * Publish writes public DNS at once (design 23, 3.8, outside-breaking): its
 * confirm previews the records and asks for the resolver's name. Deleting a
 * CoreDNS record leaves CoreDNS running on the node and published records
 * published ("leaves config on a node"), so that confirm names the node and
 * what keeps running and asks for the name too; deleting a watched record
 * only stops the watch.
 */
import { computed, reactive, ref } from "vue";
import { RouterLink } from "vue-router";
import { useI18n } from "vue-i18n";
import { toast } from "@/lib/toast";
import { useNow } from "@vueuse/core";
import {
  Eye,
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
  type DNSListener,
  type DNSRecord,
  type DNSZone,
  type GuardLintFinding,
  type MonitorView,
} from "@/lib/api";
import {
  canPlanDeployment,
  buildExternalDnsBody,
  canPublishDeployment,
  certDate,
  certVerdict,
  externalHostnameProblem,
  isObservedEngine,
  listenSummary,
  listenerProcesses,
  lookupCertWatch,
  type CertWatchLookup,
} from "./dnsExternalModel";
import { ApiError } from "@/lib/api/client";
import { useAsyncData } from "@/composables/useAsyncData";
import { usePlanDigest } from "@/composables/usePlanDigest";
import { useAuthStore } from "@/stores/auth";
import { formatDateTime, shortId } from "@/lib/format";
import { fieldNumber } from "@/lib/formValue";
import { cn } from "@/lib/utils";

import { useProof } from "@/composables/useProof";
import { useRouteOpen } from "@/composables/useRouteOpen";
import { provideNodeDirectory } from "@/composables/useNodeDirectory";
import { describeNodeStatus } from "@/lib/nodeStatus";
import { proofReason } from "@/components/common/proofModel";
import PageHeader from "@/components/common/PageHeader.vue";
import ProofLine, { type ProofSegment } from "@/components/common/ProofLine.vue";
import AttentionList, { type AttentionItem } from "@/components/common/AttentionList.vue";
import NodeLabel from "@/components/common/NodeLabel.vue";
import ObjectSheet from "@/components/common/ObjectSheet.vue";
import RowMenu, { type RowMenuItem } from "@/components/common/RowMenu.vue";
import SetupChecklist, { type SetupItem } from "@/components/networking/SetupChecklist.vue";
import ConfirmDialog from "@/components/common/ConfirmDialog.vue";
import PlanReviewDialog from "@/components/common/PlanReviewDialog.vue";
import DataTable, { type DataTableColumn } from "@/components/common/DataTable.vue";
import { Button } from "@/components/ui/button";
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

const { t, te } = useI18n();
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

/**
 * The certificate watches, so this page can name the one that owns each
 * expiry instead of holding an opinion of its own.
 *
 * A token without monitor:read gets no list and no claim: the row then says
 * nothing about watches rather than reporting "no certificate watch", which
 * it has no way to know.
 */
const canReadMonitors = computed(() => auth.can("monitor:read"));
const monitorsQuery = useAsyncData(
  (signal) => api.monitors.list({ signal }).then((r) => unwrap(r, "monitors")),
  { pollInterval: 60000, immediate: canReadMonitors.value },
);
const certWatches = computed<MonitorView[] | undefined>(() =>
  canReadMonitors.value ? monitorsQuery.data.value : undefined,
);

function certWatch(dep: DNSDeploymentView): CertWatchLookup {
  return lookupCertWatch(dep.hostname, certWatches.value);
}

const deployments = computed(() => deploymentsQuery.data.value ?? []);
const nodes = computed(() => nodesQuery.data.value ?? []);

const sortedDeployments = computed(() =>
  [...deployments.value].sort((a, b) => a.name.localeCompare(b.name)),
);

function nodeLabel(dep: DNSDeploymentView): string {
  return dep.node_name || dep.node_id;
}

/** The certificate line in the Reality column: how long is left, and when. */
function certLabel(dep: DNSDeploymentView): string {
  const expiry = certVerdict(dep.cert_not_after, new Date(), certWatch(dep));
  if (expiry.tone === "unknown") return t("networking.dns.certUnknown");
  const date = certDate(dep.cert_not_after);
  if (expiry.tone === "expired") return t("networking.dns.certExpired", { date });
  return t("networking.dns.certDays", { days: expiry.days, date });
}

/**
 * The tone the countdown is printed in. It follows the watch's threshold, so
 * this row turns amber at the moment the watch starts failing and not a day
 * earlier or later. With no watch there is no threshold and no verdict, and
 * the row carries the "no certificate watch" line instead, which is the thing
 * actually worth acting on.
 */
function certToneClass(dep: DNSDeploymentView): string {
  switch (certVerdict(dep.cert_not_after, new Date(), certWatch(dep)).tone) {
    case "expired":
      return "text-destructive";
    case "warn":
      return "text-warning";
    default:
      return "text-muted-foreground";
  }
}

const columns = computed<DataTableColumn<DNSDeploymentView>[]>(() => [
  { key: "name", label: t("networking.dns.colName"), sortable: true, searchable: true },
  { key: "node", label: t("networking.dns.colNode"), sortable: true, searchable: true, value: (dep) => nodeLabel(dep) },
  { key: "listen", label: t("networking.dns.colListen"), searchable: true, value: (dep) => listenSummary(dep) },
  { key: "hostname", label: t("networking.dns.colHostname"), sortable: true, searchable: true },
  { key: "status", label: t("networking.dns.colStatus"), sortable: true },
  { key: "reality", label: t("networking.dns.colReality"), sortable: true, value: (dep) => dep.drift?.status ?? "" },
  { key: "actions", label: "", class: "w-12", pin: "end" },
]);

function driftFindings(dep: DNSDeploymentView): string[] {
  return dep.drift?.findings ?? [];
}

/* ------------------------------------------------------------------ */
/* Head: proof line and attention (design 23, section 4.4)             */
/* ------------------------------------------------------------------ */

provideNodeDirectory(computed(() => nodesQuery.data.value));
const proof = useProof(deploymentsQuery);
const sheet = useRouteOpen();
const now = useNow({ interval: 60_000 });

function certTone(dep: DNSDeploymentView) {
  return certVerdict(dep.cert_not_after, now.value, certWatch(dep)).tone;
}

const counts = computed(() => {
  const out = { watched: 0, deployed: 0, drift: 0, failing: 0, certExpired: 0, certSoon: 0 };
  for (const dep of deployments.value) {
    if (isObservedEngine(dep.engine)) out.watched += 1;
    else out.deployed += 1;
    if (dep.drift?.status === "drift") out.drift += 1;
    if (dep.last_error || dep.last_publish_error || dep.status === "failed") out.failing += 1;
    const tone = certTone(dep);
    if (tone === "expired") out.certExpired += 1;
    else if (tone === "warn") out.certSoon += 1;
  }
  return out;
});

const proofSegments = computed<ProofSegment[]>(() => {
  const n = deployments.value.length;
  const parts: ProofSegment[] = [{ key: "resolvers", text: t("networking.dnsPage.proof.resolvers", { n }, n) }];
  if (n === 0) return parts;
  const c = counts.value;
  if (c.watched) parts.push({ key: "watched", text: t("networking.dnsPage.proof.watched", { n: c.watched }) });
  if (c.deployed) parts.push({ key: "deployed", text: t("networking.dnsPage.proof.deployed", { n: c.deployed }) });
  if (c.failing) parts.push({ key: "failing", text: t("networking.dnsPage.proof.failing", { n: c.failing }), tone: "destructive" });
  if (c.drift) parts.push({ key: "drift", text: t("networking.dnsPage.proof.drift", { n: c.drift }), tone: "warning" });
  if (c.certExpired) parts.push({ key: "expired", text: t("networking.dnsPage.proof.certExpired", { n: c.certExpired }), tone: "destructive" });
  if (c.certSoon) parts.push({ key: "soon", text: t("networking.dnsPage.proof.certSoon", { n: c.certSoon }), tone: "warning" });
  if (canReadMonitors.value && monitorsQuery.error.value) {
    parts.push({ key: "watches", text: t("networking.dnsPage.proof.watchesUnread", { reason: proofReason(monitorsQuery.error.value) }), tone: "warning" });
  }
  return parts;
});

function refreshAll(): void {
  void deploymentsQuery.refresh();
  void nodesQuery.refresh();
  if (canReadMonitors.value) void monitorsQuery.refresh();
}

function firstLine(text: string): string {
  const line = text.split("\n")[0]?.trim() ?? "";
  return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}

const attention = computed<AttentionItem[]>(() => {
  const items: AttentionItem[] = [];
  for (const dep of sortedDeployments.value) {
    const open = { label: t("networking.dnsPage.attention.open"), run: () => sheet.open(dep.id) };
    if (dep.last_error || dep.status === "failed") {
      items.push({
        key: `failed:${dep.id}`,
        tone: "danger",
        claim: t("networking.dnsPage.attention.failedClaim", { name: dep.name, node: nodeLabel(dep) }),
        proof: firstLine(dep.last_error ?? dep.status),
        action: open,
      });
    }
    if (dep.last_publish_error) {
      items.push({
        key: `publish:${dep.id}`,
        tone: "danger",
        claim: t("networking.dnsPage.attention.publishClaim", { name: dep.name, hostname: dep.hostname ?? "" }),
        proof: firstLine(dep.last_publish_error),
        action: open,
      });
    }
    const tone = certTone(dep);
    if (tone === "expired" || tone === "warn") {
      const watch = certWatch(dep);
      items.push({
        key: `cert:${dep.id}`,
        tone: tone === "expired" ? "danger" : "warning",
        claim: t(`networking.dnsPage.attention.${tone === "expired" ? "certExpiredClaim" : "certSoonClaim"}`, { name: dep.name }),
        proof: `${certLabel(dep)} · ${dep.hostname ?? ""}`,
        action: open,
      });
      if (watch.state === "unwatched") {
        items.push({
          key: `unwatched:${dep.id}`,
          tone: "warning",
          claim: t("networking.dnsPage.attention.unwatchedClaim", { hostname: dep.hostname ?? dep.name }),
          proof: t("networking.dnsPage.attention.unwatchedProof"),
          action: { label: t("networking.dns.certWatchSetUp"), to: { name: "monitoring" } },
        });
      }
    }
    if (dep.drift?.status === "drift") {
      items.push({
        key: `drift:${dep.id}`,
        tone: "warning",
        claim: t("networking.dnsPage.attention.driftClaim", { name: dep.name, node: nodeLabel(dep) }),
        proof: firstLine(driftFindings(dep)[0] ?? ""),
        action: open,
      });
    }
  }
  return items;
});

/* ------------------------------------------------------------------ */
/* Empty state: what a resolver needs, read live                       */
/* ------------------------------------------------------------------ */

const listEmpty = computed(() => deploymentsQuery.data.value !== undefined && deployments.value.length === 0);

const setupItems = computed<SetupItem[]>(() => {
  const nodesRead = nodesQuery.data.value !== undefined;
  const online = nodes.value.filter((node) => describeNodeStatus(node).reporting).length;
  return [
    {
      key: "node",
      label: t("networking.dnsPage.setup.node"),
      ready: nodesRead ? online > 0 : null,
      detail: nodesRead
        ? t("networking.dnsPage.setup.nodeDetail", { online, total: nodes.value.length })
        : nodesQuery.error.value
          ? t("networking.setup.notRead", { reason: proofReason(nodesQuery.error.value) })
          : undefined,
    },
    {
      key: "plan",
      label: t("networking.dnsPage.setup.plan"),
      ready: canPlan.value,
      detail: canPlan.value ? t("networking.dnsPage.setup.planHeld") : t("networking.dnsPage.setup.planMissing"),
    },
    {
      key: "watch",
      label: t("networking.dnsPage.setup.watch"),
      ready: canReadMonitors.value && monitorsQuery.data.value !== undefined ? tlsWatchCount.value > 0 : null,
      detail:
        canReadMonitors.value && monitorsQuery.data.value !== undefined
          ? t("networking.dnsPage.setup.watchDetail", { n: tlsWatchCount.value }, tlsWatchCount.value)
          : t("networking.dnsPage.setup.watchUnread"),
      action: { label: t("networking.dns.certWatchSetUp"), to: { name: "monitoring" } },
    },
  ];
});

const tlsWatchCount = computed(() => (monitorsQuery.data.value ?? []).filter((monitor) => monitor.type === "tls").length);

/* ------------------------------------------------------------------ */
/* Sheet and row menu                                                  */
/* ------------------------------------------------------------------ */

const openDep = computed(() => deployments.value.find((dep) => dep.id === sheet.openId.value));
const sheetState = computed(() => {
  if (!sheet.openId.value) return "ready" as const;
  if (openDep.value) return deploymentsQuery.error.value ? ("stale" as const) : ("ready" as const);
  if (deploymentsQuery.data.value === undefined) return deploymentsQuery.error.value ? ("gone" as const) : ("loading" as const);
  return "gone" as const;
});

const STATUS_TONE: Record<string, string> = {
  failed: "text-destructive",
  pending: "text-warning-text",
  applying: "text-warning-text",
};

function statusText(dep: DNSDeploymentView): string {
  const key = `networking.dnsPage.status.${dep.status}`;
  return te(key) ? t(key) : dep.status;
}

function menuFor(dep: DNSDeploymentView): RowMenuItem[] {
  const observed = isObservedEngine(dep.engine);
  return [
    {
      key: "plan",
      label: t("networking.shared.plan"),
      icon: Play,
      hidden: observed || !canAdmin.value,
      disabled: !canPlan.value || planning.value === dep.id,
      reason: !canPlan.value ? t("networking.dnsPage.setup.planMissing") : undefined,
      run: () => void plan(dep),
    },
    {
      key: "publish",
      label: t("common.actions.publish"),
      icon: UploadCloud,
      hidden: !canAdmin.value || !canPublishDeployment(dep),
      disabled: publishing.value === dep.id,
      run: () => (publishTarget.value = dep),
    },
    { key: "edit", label: t("common.actions.edit"), icon: Pencil, hidden: !canAdmin.value, run: () => openEdit(dep) },
    { key: "delete", label: t("common.actions.delete"), icon: Trash2, danger: true, hidden: !canAdmin.value, run: () => (deleteTarget.value = dep) },
  ];
}

/** What a publish writes, one line per record (design 23, 3.8: a run shows what goes out). */
const publishPreview = computed(() => {
  const dep = publishTarget.value;
  if (!dep?.hostname) return [];
  const node = nodes.value.find((entry) => entry.id === dep.node_id);
  const unknown = t("networking.dnsPage.publish.unknownAddress");
  const lines: string[] = [];
  if (dep.publish_ipv4) {
    lines.push(t("networking.dnsPage.publish.record", { host: dep.hostname, type: "A", value: node?.public_ip || unknown, was: dep.last_ipv4 || t("networking.dnsPage.publish.nothing") }));
  }
  if (dep.publish_ipv6) {
    lines.push(t("networking.dnsPage.publish.record", { host: dep.hostname, type: "AAAA", value: node?.public_ipv6 || unknown, was: dep.last_ipv6 || t("networking.dnsPage.publish.nothing") }));
  }
  return lines;
});

/** Delete: a watched resolver loses its watch; a deployed one keeps running on the node. */
const deleteImpact = computed(() => {
  const dep = deleteTarget.value;
  if (!dep) return [];
  if (isObservedEngine(dep.engine)) {
    return [t("networking.dnsPage.delete.observedImpact", { node: nodeLabel(dep) })];
  }
  const lines = [t("networking.dnsPage.delete.corednsImpact", { node: nodeLabel(dep) })];
  if (dep.hostname && dep.last_published_at) lines.push(t("networking.dnsPage.delete.publishedImpact", { hostname: dep.hostname }));
  lines.push(t("networking.dnsPage.delete.noRemoval"));
  return lines;
});

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

function openCreate(engine?: DnsForm["engine"]) {
  editingId.value = undefined;
  editingRecord.value = undefined;
  editingHasCredential.value = false;
  Object.assign(form, emptyForm());
  if (engine) form.engine = engine;
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
  <div class="space-y-5 p-4 sm:p-6">
    <PageHeader :title="$t('networking.dns.title')">
      <template #description>
        <p class="text-sm text-muted-foreground">{{ $t('networking.dns.description') }}</p>
        <ProofLine v-bind="proof" :segments="proofSegments" @retry="refreshAll" />
      </template>
      <template #actions>
        <Button variant="outline" size="sm" :disabled="deploymentsQuery.refreshing.value" @click="refreshAll">
          <RefreshCw :class="cn('size-4', deploymentsQuery.refreshing.value && 'animate-spin')" aria-hidden="true" />
          {{ $t('common.actions.refresh') }}
        </Button>
        <Button v-if="canAdmin && !listEmpty && deploymentsQuery.data.value !== undefined" size="sm" @click="openCreate()">
          <Plus class="size-4" aria-hidden="true" />
          {{ $t('networking.dnsPage.register') }}
        </Button>
      </template>
    </PageHeader>

    <AttentionList :items="attention" />

    <SetupChecklist
      v-if="listEmpty"
      :title="$t('networking.dns.emptyTitle')"
      :description="$t('networking.dnsPage.emptyDescription')"
      :items="setupItems"
    >
      <template v-if="canAdmin">
        <Button size="sm" variant="outline" type="button" @click="openCreate('external')">
          <Eye aria-hidden="true" />
          {{ $t('networking.dnsPage.watchExisting') }}
        </Button>
        <Button size="sm" variant="outline" type="button" :disabled="!canPlan" :title="!canPlan ? $t('networking.dnsPage.setup.planMissing') : undefined" @click="openCreate('coredns')">
          <Plus aria-hidden="true" />
          {{ $t('networking.dnsPage.deployCoredns') }}
        </Button>
      </template>
    </SetupChecklist>

    <DataTable
      v-else
      state-key="deployments"
      :columns="columns"
      :rows="sortedDeployments"
      :row-key="(dep) => dep.id"
      :loading="deploymentsQuery.loading.value"
      :error="deploymentsQuery.error.value"
      :has-data="deploymentsQuery.data.value !== undefined"
      searchable
      :expression-filter="false"
      :search-placeholder="$t('networking.dnsPage.searchPlaceholder')"
      :row-click="(dep, el) => sheet.open(dep.id, el)"
      :active-row-id="sheet.openId.value"
      :show-summary="false"
      :empty-title="$t('networking.dns.emptyTitle')"
      :empty-description="$t('networking.dns.emptyDescription')"
      :no-match-title="$t('networking.shared.noMatchTitle')"
      :no-match-description="$t('networking.shared.noMatchDescription')"
      @retry="refreshAll"
    >
      <template #cell-name="{ row: dep }">
        <div class="flex items-center gap-1.5">
          <Eye v-if="isObservedEngine(dep.engine)" class="size-3.5 shrink-0 text-muted-foreground" :aria-label="$t('networking.dns.observedAria')" />
          <span class="font-medium">{{ dep.name }}</span>
        </div>
        <div class="font-mono text-xs text-muted-foreground">
          {{ dep.engine }}{{ dep.engine_version ? ` ${dep.engine_version}` : "" }}
        </div>
      </template>
      <template #cell-node="{ row: dep }">
        <NodeLabel :id="dep.node_id" class="text-sm" />
      </template>
      <template #cell-listen="{ row: dep }">
        <span class="whitespace-nowrap font-mono text-xs">{{ listenSummary(dep) }}</span>
      </template>
      <template #cell-hostname="{ row: dep }">
        <span class="whitespace-nowrap font-mono text-xs">{{ dep.hostname || $t('common.misc.none') }}</span>
      </template>
      <template #cell-status="{ row: dep }">
        <span :class="cn('whitespace-nowrap text-xs', STATUS_TONE[dep.status] ?? 'text-muted-foreground')">{{ statusText(dep) }}</span>
      </template>
      <template #cell-reality="{ row: dep }">
        <div v-if="isObservedEngine(dep.engine)" class="space-y-0.5 text-xs">
          <div :class="dep.drift?.status === 'drift' ? 'text-warning-text' : 'text-muted-foreground'" class="whitespace-nowrap">
            {{ $t(`networking.dns.drift.${dep.drift?.status ?? 'unknown'}`) }}
          </div>
          <div :class="certToneClass(dep)" class="whitespace-nowrap">{{ certLabel(dep) }}</div>
        </div>
        <span v-else class="text-xs text-muted-foreground">{{ $t('networking.dns.realityNotObserved') }}</span>
      </template>
      <template #cell-actions="{ row: dep }">
        <RowMenu v-if="canAdmin" :name="dep.name" :items="menuFor(dep)" />
      </template>
    </DataTable>

    <ObjectSheet
      :open="!!sheet.openId.value"
      :title="openDep ? openDep.name : (sheet.openId.value ?? '')"
      :subtitle="openDep ? `${openDep.engine}${openDep.engine_version ? ` ${openDep.engine_version}` : ''}` : undefined"
      :state="sheetState"
      :error="deploymentsQuery.error.value ? proofReason(deploymentsQuery.error.value) : null"
      :read-only="!canAdmin"
      :return-focus="sheet.returnFocus"
      :gone-title="$t('networking.dnsPage.goneTitle')"
      :gone-description="$t('networking.dnsPage.goneDescription')"
      @close="sheet.close"
    >
      <div v-if="openDep" class="space-y-5 text-sm">
        <p v-if="isObservedEngine(openDep.engine)" class="text-muted-foreground">{{ $t('networking.dnsPage.sheet.observed') }}</p>
        <pre
          v-if="openDep.last_error"
          class="whitespace-pre-wrap break-words rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 font-mono text-xs text-foreground"
        >{{ openDep.last_error }}</pre>
        <dl class="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
          <div class="min-w-0">
            <dt class="text-xs text-muted-foreground">{{ $t('networking.dns.colNode') }}</dt>
            <dd><NodeLabel :id="openDep.node_id" link /></dd>
          </div>
          <div>
            <dt class="text-xs text-muted-foreground">{{ $t('networking.dns.colStatus') }}</dt>
            <dd :class="STATUS_TONE[openDep.status]">{{ statusText(openDep) }}</dd>
          </div>
          <div class="min-w-0">
            <dt class="text-xs text-muted-foreground">{{ $t('networking.dns.colListen') }}</dt>
            <dd class="font-mono text-xs">{{ listenSummary(openDep) }}</dd>
            <dd v-if="listenerProcesses(openDep.listeners).length" class="text-xs text-muted-foreground">
              {{ listenerProcesses(openDep.listeners).join(", ") }}
            </dd>
          </div>
          <div>
            <dt class="text-xs text-muted-foreground">{{ $t('networking.dns.colExposure') }}</dt>
            <dd>{{ openDep.exposure || $t('common.misc.none') }}</dd>
          </div>
          <div class="min-w-0">
            <dt class="text-xs text-muted-foreground">{{ $t('networking.dns.colHostname') }}</dt>
            <dd class="break-all font-mono text-xs">{{ openDep.hostname || $t('common.misc.none') }}</dd>
          </div>
          <div v-if="!isObservedEngine(openDep.engine)">
            <dt class="text-xs text-muted-foreground">{{ $t('networking.dns.colPublished') }}</dt>
            <dd class="text-xs">
              {{ openDep.last_published_at ? formatDateTime(openDep.last_published_at) : $t('common.misc.never') }}
              <span class="text-muted-foreground">· {{ openDep.has_credential ? $t('networking.dnsPage.sheet.credentialSet') : $t('networking.dnsPage.sheet.credentialNone') }}</span>
            </dd>
            <dd v-if="openDep.last_publish_error" class="text-xs text-destructive">{{ openDep.last_publish_error }}</dd>
          </div>
        </dl>

        <section v-if="isObservedEngine(openDep.engine)" class="space-y-1.5">
          <h3 class="text-xs font-medium text-muted-foreground">{{ $t('networking.dns.colReality') }}</h3>
          <p class="text-sm">
            <span :class="openDep.drift?.status === 'drift' ? 'text-warning-text' : ''">{{ $t(`networking.dns.drift.${openDep.drift?.status ?? 'unknown'}`) }}</span>
            <span :class="certToneClass(openDep)"> · {{ certLabel(openDep) }}</span>
          </p>
          <RouterLink
            v-if="certWatch(openDep).state === 'watched'"
            :to="{ name: 'monitor-detail', params: { id: certWatch(openDep).monitor?.id } }"
            class="block text-xs text-muted-foreground underline-offset-2 hover:underline"
          >
            {{ $t('networking.dns.certWatched', { days: certWatch(openDep).thresholdDays }) }}
          </RouterLink>
          <RouterLink
            v-else-if="certWatch(openDep).state === 'unwatched'"
            :to="{ name: 'monitoring' }"
            class="block text-xs text-warning-text underline-offset-2 hover:underline"
          >
            {{ $t('networking.dns.certUnwatched') }}
          </RouterLink>
          <ul v-if="driftFindings(openDep).length" class="space-y-1 rounded-md border border-border p-3">
            <li v-for="(finding, index) in driftFindings(openDep)" :key="index" class="text-xs leading-relaxed text-muted-foreground">{{ finding }}</li>
          </ul>
          <p v-if="openDep.drift?.reality_collected_at" class="text-xs text-muted-foreground">
            {{ $t('networking.dns.realityCollected', { time: formatDateTime(openDep.drift.reality_collected_at) }) }}
          </p>
        </section>

        <section v-if="openDep.zones.length" class="space-y-1.5">
          <h3 class="text-xs font-medium text-muted-foreground">{{ $t('networking.dnsPage.sheet.zones', { n: openDep.zones.length }, openDep.zones.length) }}</h3>
          <ul class="divide-y divide-border rounded-md border border-border">
            <li v-for="zone in openDep.zones" :key="zone.suffix" class="flex flex-wrap items-baseline gap-x-2 px-3 py-2 text-xs">
              <span class="font-mono text-foreground">{{ zone.suffix }}</span>
              <span class="text-muted-foreground">{{ zone.mode }}</span>
              <span v-if="zone.upstreams?.length" class="font-mono text-muted-foreground">{{ zone.upstreams.join(", ") }}</span>
              <span v-if="zone.records?.length" class="text-muted-foreground">{{ $t('networking.dnsPage.sheet.records', { n: zone.records.length }, zone.records.length) }}</span>
            </li>
          </ul>
        </section>
      </div>
      <template v-if="openDep" #actions>
        <Button
          v-if="!isObservedEngine(openDep.engine)"
          variant="outline"
          size="sm"
          type="button"
          :disabled="!canPlan || planning === openDep.id"
          :title="!canPlan ? $t('networking.dnsPage.setup.planMissing') : undefined"
          @click="plan(openDep)"
        >
          <RefreshCw v-if="planning === openDep.id" class="animate-spin" aria-hidden="true" />
          <Play v-else aria-hidden="true" />
          {{ $t('networking.shared.plan') }}
        </Button>
        <Button v-if="canPublishDeployment(openDep)" variant="outline" size="sm" type="button" @click="publishTarget = openDep">
          <UploadCloud aria-hidden="true" />
          {{ $t('common.actions.publish') }}
        </Button>
        <Button variant="outline" size="sm" type="button" @click="openEdit(openDep)">
          <Pencil aria-hidden="true" />
          {{ $t('common.actions.edit') }}
        </Button>
        <RowMenu :name="openDep.name" :items="menuFor(openDep).filter((item) => item.key === 'delete')" />
      </template>
    </ObjectSheet>

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

          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
                class="grid grid-cols-1 items-end gap-2 sm:grid-cols-[1fr_1fr_auto]"
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
              <p class="text-xs text-muted-foreground">
                {{ $t('networking.dns.certNotAfterHint') }}
                <RouterLink :to="{ name: 'monitoring' }" class="underline underline-offset-2">
                  {{ $t('networking.dns.certWatchSetUp') }}
                </RouterLink>
              </p>
            </div>
          </div>

          <div v-if="!isExternalForm" class="grid grid-cols-1 gap-3 sm:grid-cols-3">
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

              <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
                  class="grid grid-cols-1 items-end gap-2 sm:grid-cols-[1.3fr_0.8fr_1.5fr_0.7fr_auto]"
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
            <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
            <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
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

    <!-- Publish writes public DNS at once (design 23, 3.8, outside-breaking): preview and typed name. -->
    <ConfirmDialog
      :open="!!publishTarget"
      :title="$t('networking.dnsPage.publish.title', { hostname: publishTarget?.hostname ?? '' })"
      :description="$t('networking.dnsPage.publish.description', { zones: publishZones })"
      :impact="publishPreview"
      :impact-title="$t('networking.dnsPage.publish.impactTitle')"
      :typed-confirm="publishTarget?.name"
      :confirm-label="$t('networking.dnsPage.publish.confirm')"
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

    <!-- Delete: a deployed resolver keeps running on its node; a watched one only loses its watch. -->
    <ConfirmDialog
      :open="!!deleteTarget"
      :title="$t('networking.dnsPage.delete.title', { name: deleteTarget?.name ?? '' })"
      :description="deleteTarget && isObservedEngine(deleteTarget.engine) ? $t('networking.dnsPage.delete.observedDescription') : $t('networking.dnsPage.delete.corednsDescription')"
      :impact="deleteImpact"
      :impact-title="$t(deleteTarget && isObservedEngine(deleteTarget.engine) ? 'networking.dnsPage.delete.observedImpactTitle' : 'networking.dnsPage.delete.impactTitle')"
      :typed-confirm="deleteTarget && !isObservedEngine(deleteTarget.engine) ? deleteTarget.name : undefined"
      :confirm-label="$t('networking.dnsPage.delete.confirm')"
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

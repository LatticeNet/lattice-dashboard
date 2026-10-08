<script setup lang="ts">
/**
 * DDNS (design 23, section 4.4): does every name point at its node's address.
 *
 * The head says how many profiles are current, failing and stale (ddnsModel
 * says what stale can mean against a server that only writes on change), the
 * attention list names each one with its proof, and the collection groups the
 * profiles under their node with the node's own status on the group row. A
 * row opens the profile in the sheet on `?open=`; the subset is `?show=`, the
 * grouping `?group=`.
 *
 * "Run now" writes public DNS at once, so it has its own icon (the play icon
 * means "create a plan" on the other networking pages) and the outside-
 * breaking confirm: the records it writes, and the profile's name typed.
 */
import { computed, nextTick, reactive, ref } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "@/lib/toast";
import { useNow } from "@vueuse/core";
import { CloudUpload, Pencil, Plus, RefreshCw, Trash2 } from "lucide-vue-next";

import { api, ApiError, unwrap, type DDNSUpsertRequest, type DDNSView, type Node } from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { useProof } from "@/composables/useProof";
import { useOwnedRoute } from "@/composables/useOwnedRoute";
import { useQueryParam } from "@/composables/useQueryParam";
import { useRouteOpen } from "@/composables/useRouteOpen";
import { provideNodeDirectory } from "@/composables/useNodeDirectory";
import { useAuthStore } from "@/stores/auth";
import { formatAge, formatDateTime } from "@/lib/format";
import { describeNodeStatus } from "@/lib/nodeStatus";
import { cn } from "@/lib/utils";
import { proofReason } from "@/components/common/proofModel";

import PageHeader from "@/components/common/PageHeader.vue";
import ProofLine, { type ProofSegment } from "@/components/common/ProofLine.vue";
import AttentionList, { type AttentionItem } from "@/components/common/AttentionList.vue";
import ConfirmDialog from "@/components/common/ConfirmDialog.vue";
import DataTable, { type DataTableColumn } from "@/components/common/DataTable.vue";
import EmptyState from "@/components/common/EmptyState.vue";
import NodeLabel from "@/components/common/NodeLabel.vue";
import NodePicker from "@/components/common/NodePicker.vue";
import ObjectSheet from "@/components/common/ObjectSheet.vue";
import RowMenu, { type RowMenuItem } from "@/components/common/RowMenu.vue";
import StatusDot from "@/components/common/StatusDot.vue";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogScrollContent,
  DialogTitle,
} from "@/components/ui/dialog";

import {
  assessDdns,
  ddnsCommentMode,
  ddnsCounts,
  ddnsErrorText,
  ddnsMatchesShow,
  ddnsRunPreview,
  ddnsTemplateProblem,
  DDNS_COMMENT_MAX_CHARS,
  DDNS_COMMENT_MODES,
  DDNS_COMMENT_PLACEHOLDERS,
  DDNS_COMMENT_TEMPLATE_MAX_BYTES,
  DDNS_DEFAULT_COMMENT_TEMPLATE,
  DDNS_SHOWS,
  insertDdnsPlaceholder,
  parseDdnsShow,
  renderDdnsComment,
  type DdnsAssessment,
  type DdnsCommentMode,
  type DdnsShow,
  type DdnsState,
} from "./ddnsModel";

type Provider = "cloudflare" | "webhook";
type Grouping = "node" | "none";

const { t, locale } = useI18n();
const auth = useAuthStore();
const canAdmin = computed(() => auth.can("ddns:admin"));
const now = useNow({ interval: 15_000 });

// BARE ARRAY endpoint: do NOT unwrap.
const profilesQuery = useAsyncData((signal) => api.ddns.list({ signal }), { pollInterval: 15000 });
const nodesQuery = useAsyncData((signal) => api.nodes.list({ signal }).then((r) => unwrap(r, "nodes")), {
  pollInterval: 15000,
});

const profiles = computed(() => profilesQuery.data.value ?? []);
const nodes = computed(() => nodesQuery.data.value ?? []);
provideNodeDirectory(computed(() => nodesQuery.data.value));

const nodeById = computed(() => new Map(nodes.value.map((node) => [node.id, node])));

function nodeDown(node: Node): boolean {
  return !describeNodeStatus(node).reporting;
}

/**
 * Each profile's state against the node list. Without the list there is no
 * address to compare with, so a profile that has not failed is unchecked,
 * never a guessed "current" or "stale".
 */
const assessments = computed(() => {
  const out = new Map<string, DdnsAssessment>();
  for (const profile of profiles.value) {
    const node = nodeById.value.get(profile.node_id);
    const input = node ? { public_ip: node.public_ip, public_ipv6: node.public_ipv6, down: nodeDown(node) } : undefined;
    out.set(profile.id, assessDdns(profile, input, now.value.getTime()));
  }
  return out;
});

function assessmentOf(profile: DDNSView): DdnsAssessment {
  return assessments.value.get(profile.id) ?? assessDdns(profile, undefined, now.value.getTime());
}

const counts = computed(() => ddnsCounts([...assessments.value.values()]));

function nameOf(profile: DDNSView): string {
  return profile.name || profile.id;
}

function nodeNameOf(id: string): string {
  return nodeById.value.get(id)?.name ?? id;
}

function age(ms: number): string {
  return formatAge(ms, locale.value);
}

function ageSince(ms: number | null): string {
  return ms === null ? "" : age(now.value.getTime() - ms);
}

function intervalText(seconds: number): string {
  return age(seconds * 1000);
}

/* ------------------------------------------------------------------ */
/* Proof line                                                          */
/* ------------------------------------------------------------------ */

const proof = useProof(profilesQuery);
const owned = useOwnedRoute();

/** A link to a subset that keeps the grouping and search the operator chose. */
function showTo(show: DdnsShow) {
  const query = { ...owned.query() };
  delete query.open;
  return { query: { ...query, show } };
}

const proofSegments = computed<ProofSegment[]>(() => {
  const c = counts.value;
  const parts: ProofSegment[] = [{ key: "profiles", text: t("networking.ddns.proof.profiles", { n: c.total }, c.total) }];
  const nodesRead = nodesQuery.data.value !== undefined;
  if (c.total === 0) return parts;
  if (nodesRead) parts.push({ key: "current", text: t("networking.ddns.proof.current", { n: c.current }) });
  if (c.failing) parts.push({ key: "failing", text: t("networking.ddns.proof.failing", { n: c.failing }), tone: "destructive", to: showTo("failing") });
  if (nodesRead) {
    if (c.stale) parts.push({ key: "stale", text: t("networking.ddns.proof.stale", { n: c.stale }), tone: "warning", to: showTo("stale") });
    if (c.waiting) parts.push({ key: "waiting", text: t("networking.ddns.proof.waiting", { n: c.waiting }) });
    if (c.nodeDown) parts.push({ key: "down", text: t("networking.ddns.proof.down", { n: c.nodeDown }, c.nodeDown), tone: "warning", to: showTo("down") });
  } else if (nodesQuery.error.value) {
    parts.push({ key: "nodes", text: t("networking.ddns.proof.nodesUnread", { reason: proofReason(nodesQuery.error.value) }), tone: "warning" });
  }
  return parts;
});

function refreshAll(): void {
  void profilesQuery.refresh();
  void nodesQuery.refresh();
}

/* ------------------------------------------------------------------ */
/* Attention                                                           */
/* ------------------------------------------------------------------ */

const sheet = useRouteOpen();

function firstLine(text: string): string {
  const line = text.split("\n")[0]?.trim() ?? "";
  return line.length > 240 ? `${line.slice(0, 237)}...` : line;
}

function staleProof(profile: DDNSView, assessment: DdnsAssessment): string {
  const move = assessment.moved[0];
  if (move) {
    return t("networking.ddns.attention.staleMoved", {
      published: move.published || t("networking.ddns.nothingWritten"),
      current: move.current,
      age: assessment.lastRunMs === null ? t("networking.ddns.neverRun") : t("networking.ddns.ago", { age: ageSince(assessment.lastRunMs) }),
      interval: intervalText(assessment.intervalS),
    });
  }
  if (assessment.noAddress) return t("networking.ddns.attention.staleNoAddress", { node: nodeNameOf(profile.node_id) });
  return t("networking.ddns.attention.staleNever", { interval: intervalText(assessment.intervalS) });
}

const attention = computed<AttentionItem[]>(() => {
  const items: AttentionItem[] = [];
  const ordered = [...profiles.value].sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  for (const profile of ordered) {
    const assessment = assessmentOf(profile);
    const open = { label: t("networking.ddns.attention.open"), run: () => sheet.open(profile.id) };
    if (assessment.state === "failing") {
      items.push({
        key: `failing:${profile.id}`,
        tone: "danger",
        claim: t("networking.ddns.attention.failingClaim", { name: nameOf(profile) }),
        proof: t("networking.ddns.attention.failingProof", {
          error: firstLine(ddnsErrorText(profile.last_error)),
          age: assessment.lastRunMs === null ? t("networking.ddns.neverRun") : t("networking.ddns.ago", { age: ageSince(assessment.lastRunMs) }),
        }),
        action: open,
      });
    } else if (assessment.state === "stale") {
      items.push({
        key: `stale:${profile.id}`,
        tone: "warning",
        claim: t("networking.ddns.attention.staleClaim", { name: nameOf(profile) }),
        proof: staleProof(profile, assessment),
        action: open,
      });
    }
  }
  // One item per node that is not reporting, naming the profiles it holds:
  // three profiles on one dead node are one problem, not three.
  const byDownNode = new Map<string, DDNSView[]>();
  for (const profile of ordered) {
    if (!assessmentOf(profile).nodeDown) continue;
    const list = byDownNode.get(profile.node_id) ?? [];
    list.push(profile);
    byDownNode.set(profile.node_id, list);
  }
  for (const [nodeId, held] of byDownNode) {
    const node = nodeById.value.get(nodeId);
    const info = node ? describeNodeStatus(node) : undefined;
    const since = node?.status_since ? Date.parse(node.status_since) : Number.NaN;
    const named = { node: nodeNameOf(nodeId), status: info ? t(info.labelKey) : "", n: held.length };
    items.push({
      key: `down:${nodeId}`,
      tone: "warning",
      claim: Number.isNaN(since)
        ? t("networking.ddns.attention.downClaim", named, held.length)
        : t("networking.ddns.attention.downClaimSince", { ...named, age: age(now.value.getTime() - since) }, held.length),
      proof: t("networking.ddns.attention.downProof", { names: held.map(nameOf).join(", ") }),
      action: { label: t("networking.ddns.attention.show"), to: showTo("down") },
    });
  }
  return items;
});

/* ------------------------------------------------------------------ */
/* Collection                                                          */
/* ------------------------------------------------------------------ */

const show = useQueryParam<DdnsShow>("show", {
  parse: parseDdnsShow,
  format: (value) => (value === "all" ? undefined : value),
});

const grouping = useQueryParam<Grouping>("group", {
  parse: (raw) => (raw === "none" ? "none" : "node"),
  format: (value) => (value === "none" ? "none" : undefined),
});

const showCounts = computed<Record<DdnsShow, number>>(() => ({
  all: counts.value.total,
  failing: counts.value.failing,
  stale: counts.value.stale,
  down: counts.value.nodeDown,
}));

/** Every subset but All shows only when it holds something, or is the one selected. */
const showOptions = computed(() =>
  DDNS_SHOWS.filter((value) => value === "all" || showCounts.value[value] > 0 || show.value === value),
);

const rows = computed(() =>
  [...profiles.value]
    .filter((profile) => ddnsMatchesShow(assessmentOf(profile), show.value))
    .sort((a, b) => nameOf(a).localeCompare(nameOf(b))),
);

const columns = computed<DataTableColumn<DDNSView>[]>(() => {
  const cols: DataTableColumn<DDNSView>[] = [
    { key: "name", label: t("networking.ddns.colName"), sortable: true, searchable: true, value: nameOf },
    { key: "state", label: t("networking.ddns.colState"), sortable: true, value: (p) => STATE_ORDER[assessmentOf(p).state] },
    { key: "domains", label: t("networking.ddns.colDomains"), searchable: true, value: (p) => (p.domains ?? []).join(" ") },
    {
      key: "published",
      label: t("networking.ddns.colPublished"),
      searchable: true,
      value: (p) => [p.last_ipv4, p.last_ipv6].filter(Boolean).join(" "),
    },
    { key: "last_run", label: t("networking.ddns.colLastRun"), sortable: true, value: (p) => assessmentOf(p).lastRunMs ?? 0 },
  ];
  if (grouping.value === "none") {
    cols.splice(2, 0, { key: "node", label: t("networking.ddns.colNode"), sortable: true, searchable: true, value: (p) => nodeNameOf(p.node_id) });
  }
  cols.push({ key: "actions", label: "", class: "w-12", pin: "end" });
  return cols;
});

const STATE_ORDER: Record<DdnsState, number> = { failing: 0, stale: 1, waiting: 2, unchecked: 3, current: 4 };
const STATE_TONE: Record<DdnsState, string> = {
  failing: "text-destructive",
  stale: "text-warning-text",
  waiting: "text-muted-foreground",
  unchecked: "text-muted-foreground",
  current: "text-muted-foreground",
};

/** Groups by node name; a node the list does not hold sorts by its id. */
const groupOrder = computed(() =>
  [...new Set(profiles.value.map((profile) => profile.node_id))].sort((a, b) => nodeNameOf(a).localeCompare(nodeNameOf(b))),
);
/** Collapsed node groups; kept across a flip to the flat list and back. */
const collapsedNodes = ref(new Set<string>());

function groupSummary(nodeId: string, members: DDNSView[]) {
  const node = nodeById.value.get(nodeId);
  const info = node ? describeNodeStatus(node) : undefined;
  const failing = members.filter((profile) => assessmentOf(profile).state === "failing").length;
  const since = node?.status_since ? Date.parse(node.status_since) : Number.NaN;
  return {
    info,
    failing,
    since: info && !info.reporting && !Number.isNaN(since) ? age(now.value.getTime() - since) : "",
  };
}

function nodeStatusTone(tone: string | undefined): string {
  switch (tone) {
    case "warning":
      return "text-warning-text";
    case "destructive":
      return "text-destructive";
    default:
      return "text-muted-foreground";
  }
}

const listEmpty = computed(() => profilesQuery.data.value !== undefined && profiles.value.length === 0);

/* ------------------------------------------------------------------ */
/* Sheet                                                               */
/* ------------------------------------------------------------------ */

const openProfile = computed(() => profiles.value.find((profile) => profile.id === sheet.openId.value));
const openAssessment = computed(() => (openProfile.value ? assessmentOf(openProfile.value) : undefined));
const openNode = computed(() => (openProfile.value ? nodeById.value.get(openProfile.value.node_id) : undefined));
const sheetState = computed(() => {
  if (!sheet.openId.value) return "ready" as const;
  if (profilesQuery.data.value === undefined) return profilesQuery.error.value ? ("gone" as const) : ("loading" as const);
  if (!openProfile.value) return "gone" as const;
  return profilesQuery.error.value ? ("stale" as const) : ("ready" as const);
});

function stateSentence(profile: DDNSView, assessment: DdnsAssessment): string {
  const interval = intervalText(assessment.intervalS);
  switch (assessment.state) {
    case "failing":
      return t("networking.ddns.stateLine.failing", {
        age: assessment.lastRunMs === null ? t("networking.ddns.neverRun") : t("networking.ddns.ago", { age: ageSince(assessment.lastRunMs) }),
        interval,
      });
    case "stale":
      return t("networking.ddns.stateLine.stale", { detail: staleProof(profile, assessment) });
    case "waiting":
      return assessment.moved.length
        ? t("networking.ddns.stateLine.waiting", { interval })
        : t("networking.ddns.stateLine.waitingFirst");
    case "unchecked":
      return t("networking.ddns.stateLine.unchecked");
    default:
      return t("networking.ddns.stateLine.current");
  }
}

interface RecordLine {
  domain: string;
  type: "A" | "AAAA";
  value: string;
  current: string;
}

/** What each name holds, as far as this profile last wrote it, beside what the node reports now. */
const openRecords = computed<RecordLine[]>(() => {
  const profile = openProfile.value;
  if (!profile) return [];
  const out: RecordLine[] = [];
  for (const domain of profile.domains ?? []) {
    if (profile.enable_ipv4) out.push({ domain, type: "A", value: profile.last_ipv4 ?? "", current: openNode.value?.public_ip ?? "" });
    if (profile.enable_ipv6) out.push({ domain, type: "AAAA", value: profile.last_ipv6 ?? "", current: openNode.value?.public_ipv6 ?? "" });
  }
  return out;
});

/* ------------------------------------------------------------------ */
/* Row menu                                                            */
/* ------------------------------------------------------------------ */

function runBlockedReason(profile: DDNSView): string | undefined {
  const assessment = assessmentOf(profile);
  if (assessment.nodeUnknown && nodesQuery.data.value !== undefined) return t("networking.ddns.runNodeUnknown");
  if (assessment.noAddress) return t("networking.ddns.runNoAddress", { node: nodeNameOf(profile.node_id) });
  return undefined;
}

function menuFor(profile: DDNSView): RowMenuItem[] {
  const blocked = runBlockedReason(profile);
  return [
    { key: "edit", label: t("networking.ddns.edit"), icon: Pencil, hidden: !canAdmin.value, run: () => openEdit(profile) },
    {
      key: "run",
      label: t("networking.ddns.runNow"),
      icon: CloudUpload,
      hidden: !canAdmin.value,
      disabled: !!blocked,
      reason: blocked,
      run: () => (runTarget.value = profile),
    },
    { key: "delete", label: t("common.actions.delete"), icon: Trash2, danger: true, hidden: !canAdmin.value, run: () => (deleteTarget.value = profile) },
  ];
}

// ── Create dialog ───────────────────────────────────────────────────────────
const formOpen = ref(false);
const saving = ref(false);

/**
 * Id of the profile being edited, or undefined while creating.
 *
 * The server treats an id in the body as "edit this one", so this single value
 * decides create vs update for the whole dialog: title, submit label, whether a
 * blank credential is allowed, and which toast fires.
 */
const editingId = ref<string | undefined>();
const isEditing = computed(() => !!editingId.value);
/** Whether the profile being edited already has a stored credential. */
const editingHasCredential = ref(false);

const form = reactive({
  name: "",
  node_id: "",
  provider: "cloudflare" as Provider,
  domains: "",
  enable_ipv4: true,
  enable_ipv6: false,
  ttl: 60,
  max_retries: 3,
  interval_seconds: 300,
  cf_api_token: "",
  comment_mode: "default" as DdnsCommentMode,
  record_comment: "",
  webhook_url: "",
  webhook_method: "POST",
  webhook_body: "",
  webhook_headers: "",
});

/**
 * What the last save warned about. A save with warnings keeps the dialog open
 * on them, now editing the saved profile, so the operator reads them before
 * the form goes away.
 */
const saveWarnings = ref<string[]>([]);
/** The last published addresses of the profile being edited, for #old_ip#. */
const editingPublished = ref({ v4: "", v6: "" });

function resetForm() {
  editingId.value = undefined;
  editingHasCredential.value = false;
  saveWarnings.value = [];
  editingPublished.value = { v4: "", v6: "" };
  form.comment_mode = "default";
  form.record_comment = "";
  form.name = "";
  form.node_id = "";
  form.provider = "cloudflare";
  form.domains = "";
  form.enable_ipv4 = true;
  form.enable_ipv6 = false;
  form.ttl = 60;
  form.max_retries = 3;
  form.interval_seconds = 300;
  form.cf_api_token = "";
  form.webhook_url = "";
  form.webhook_method = "POST";
  form.webhook_body = "";
  form.webhook_headers = "";
}

function openCreate() {
  if (!canAdmin.value) return;
  resetForm();
  formOpen.value = true;
}

/**
 * Load an existing profile into the form.
 *
 * Credentials are deliberately not populated: the list view never returns
 * them, so there is nothing to prefill. A blank field on submit means "keep
 * what is stored", which is why the token is not required when editing a
 * profile that already has one.
 */
function openEdit(profile: DDNSView) {
  if (!canAdmin.value) return;
  resetForm();
  editingId.value = profile.id;
  editingHasCredential.value = profile.has_credential;
  form.name = profile.name;
  form.node_id = profile.node_id;
  form.provider = (profile.provider as Provider) || "cloudflare";
  form.domains = (profile.domains ?? []).join(", ");
  form.enable_ipv4 = profile.enable_ipv4;
  form.enable_ipv6 = profile.enable_ipv6;
  form.ttl = profile.ttl || 60;
  form.max_retries = profile.max_retries || 3;
  form.interval_seconds = profile.interval_seconds || 300;
  form.webhook_url = profile.webhook_url ?? "";
  form.webhook_method = profile.webhook_method || "POST";
  form.comment_mode = ddnsCommentMode(profile.comment_mode);
  form.record_comment = profile.record_comment ?? "";
  editingPublished.value = { v4: profile.last_ipv4 ?? "", v6: profile.last_ipv6 ?? "" };
  formOpen.value = true;
}

/**
 * The form holds a Cloudflare token or a webhook body, so an Escape or an
 * overlay click must not discard typed credentials without asking.
 */
const isDirty = computed(
  () =>
    isEditing.value ||
    !!form.name.trim() ||
    !!form.node_id ||
    !!form.domains.trim() ||
    !!form.cf_api_token.trim() ||
    form.comment_mode !== "default" ||
    !!form.record_comment.trim() ||
    !!form.webhook_url.trim() ||
    !!form.webhook_body.trim() ||
    !!form.webhook_headers.trim(),
);
const discardOpen = ref(false);

function onFormOpenChange(next: boolean) {
  if (next) {
    formOpen.value = true;
    return;
  }
  if (isDirty.value && !saving.value) {
    discardOpen.value = true;
    return;
  }
  formOpen.value = false;
}

/**
 * The one way the dialog closes.
 *
 * Resetting before closing matters: `isDirty` is true for the whole of an edit,
 * so leaving the form state in place while the open flag flips lets the close
 * re-enter the discard guard and stay open, with the title flipping back to the
 * create wording on the way. Clearing first makes the guard a no-op.
 */
function closeForm() {
  discardOpen.value = false;
  resetForm();
  formOpen.value = false;
}

function confirmDiscard() {
  closeForm();
}

/**
 * Offered cadences. A residential address is worth a few minutes; a machine
 * that has held the same IP for a year is not, and the same value spaces out
 * retries when a provider keeps rejecting the write.
 */
const intervalOptions = [
  { value: 60, label: "1 min" },
  { value: 300, label: "5 min" },
  { value: 900, label: "15 min" },
  { value: 3600, label: "1 h" },
  { value: 21600, label: "6 h" },
  { value: 43200, label: "12 h" },
  { value: 86400, label: "24 h" },
];

const parsedDomains = computed(() =>
  form.domains
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean),
);

/* ── Record comment ────────────────────────────────────────────────── */

const COMMENT_INPUT_ID = "ddns-comment-template";

const commentTemplate = computed(() =>
  form.comment_mode === "custom" ? form.record_comment : DDNS_DEFAULT_COMMENT_TEMPLATE,
);

const templateProblem = computed(() =>
  form.provider === "cloudflare" && form.comment_mode === "custom" ? ddnsTemplateProblem(form.record_comment) : null,
);

const templateProblemText = computed(() => {
  const problem = templateProblem.value;
  if (!problem) return "";
  switch (problem.kind) {
    case "empty":
      return t("networking.ddns.comment.problem.empty");
    case "lineBreak":
      return t("networking.ddns.comment.problem.lineBreak");
    case "tooLong":
      return t("networking.ddns.comment.problem.tooLong", { bytes: problem.bytes, max: DDNS_COMMENT_TEMPLATE_MAX_BYTES });
    default:
      return t("networking.ddns.comment.problem.unknown", { placeholder: problem.placeholder });
  }
});

/**
 * The comment the first record would get, rendered here the way the server
 * renders it: for the chosen node and the first domain. A value the form does
 * not have yet shows as its placeholder rather than as nothing.
 */
const commentPreview = computed(() => {
  const node = nodeById.value.get(form.node_id);
  const v4 = form.enable_ipv4 || !form.enable_ipv6;
  const ip = (v4 ? node?.public_ip : node?.public_ipv6) ?? "";
  return renderDdnsComment(commentTemplate.value, {
    node: node?.name || form.node_id || "#node#",
    node_id: form.node_id || "#node_id#",
    profile: form.name.trim() || "#profile#",
    domain: parsedDomains.value[0] ?? "#domain#",
    type: v4 ? "A" : "AAAA",
    ip: ip || "#ip#",
    old_ip: v4 ? editingPublished.value.v4 : editingPublished.value.v6,
    lattice: typeof window === "undefined" ? "" : window.location.hostname,
    now: now.value.getTime(),
  });
});

const previewTarget = computed(() => ({
  node: nodeById.value.get(form.node_id)?.name || form.node_id || "#node#",
  domain: parsedDomains.value[0] ?? "#domain#",
}));

function insertPlaceholder(placeholder: string) {
  const el = document.getElementById(COMMENT_INPUT_ID) as HTMLInputElement | null;
  const next = insertDdnsPlaceholder(form.record_comment, placeholder, el?.selectionStart, el?.selectionEnd);
  form.record_comment = next.value;
  void nextTick(() => {
    el?.focus();
    el?.setSelectionRange(next.caret, next.caret);
  });
}

function commentSummary(profile: DDNSView): string {
  const mode = ddnsCommentMode(profile.comment_mode);
  if (mode === "none") return t("networking.ddns.comment.sheetNone");
  if (mode === "custom" && profile.record_comment) return t("networking.ddns.comment.sheetCustom", { template: profile.record_comment });
  return t("networking.ddns.comment.sheetDefault", { template: DDNS_DEFAULT_COMMENT_TEMPLATE });
}

const canSubmit = computed(() => {
  if (!form.name.trim() || !form.node_id || parsedDomains.value.length === 0) return false;
  if (templateProblem.value) return false;
  // A blank credential is only acceptable when editing a profile that already
  // has one stored, because the client is never given the value to send back.
  const credentialKept = isEditing.value && editingHasCredential.value;
  if (form.provider === "cloudflare") return credentialKept || !!form.cf_api_token.trim();
  return !!form.webhook_url.trim();
});

async function submitForm() {
  if (!canSubmit.value || !canAdmin.value) return;
  saving.value = true;
  try {
    const req: DDNSUpsertRequest = {
      name: form.name.trim(),
      node_id: form.node_id,
      provider: form.provider,
      domains: parsedDomains.value,
      enable_ipv4: form.enable_ipv4,
      enable_ipv6: form.enable_ipv6,
      ttl: Number(form.ttl),
      max_retries: Number(form.max_retries),
      interval_seconds: Number(form.interval_seconds),
      // Sent for both providers so switching the provider back and forth
      // keeps the stored setting; the webhook provider ignores them.
      comment_mode: form.comment_mode,
      record_comment: form.record_comment,
    };
    if (editingId.value) req.id = editingId.value;
    if (form.provider === "cloudflare") {
      // Blank means keep; only send the field when the operator typed one.
      if (form.cf_api_token.trim()) req.cf_api_token = form.cf_api_token.trim();
    } else {
      req.webhook_url = form.webhook_url.trim();
      req.webhook_method = form.webhook_method.trim() || "POST";
      if (form.webhook_body.trim()) req.webhook_body = form.webhook_body;
      if (form.webhook_headers.trim()) req.webhook_headers = form.webhook_headers;
    }
    const editing = isEditing.value;
    const saved = await api.ddns.save(req);
    void profilesQuery.refresh();
    const warnings = saved.warnings ?? [];
    if (warnings.length > 0) {
      // Saved. Stay open on the warnings, now editing what was saved, so a
      // second save updates it instead of creating a duplicate.
      saveWarnings.value = warnings;
      editingId.value = saved.id;
      editingHasCredential.value = saved.has_credential;
      form.cf_api_token = "";
      toast.warning(t("networking.ddns.toastSavedWithWarnings"));
      return;
    }
    toast.success(t(editing ? "networking.ddns.toastUpdated" : "networking.ddns.toastCreated"));
    closeForm();
  } catch (error) {
    const fallback = isEditing.value
      ? "networking.ddns.toastUpdateFailed"
      : "networking.ddns.toastCreateFailed";
    toast.error(error instanceof Error ? error.message : t(fallback));
  } finally {
    saving.value = false;
  }
}

// ── Delete: irreversible inside Lattice (design 23, section 3.8) ────────────
const deleteTarget = ref<DDNSView | undefined>();
const deleting = ref(false);

const deleteImpact = computed(() => {
  const profile = deleteTarget.value;
  if (!profile) return [];
  const lines = [
    t("networking.ddns.deleteImpactFollow", {
      domains: (profile.domains ?? []).join(", ") || t("common.misc.none"),
      node: nodeNameOf(profile.node_id),
    }),
  ];
  const kept = [profile.last_ipv4, profile.last_ipv6].filter(Boolean).join(", ");
  lines.push(kept ? t("networking.ddns.deleteImpactKept", { ip: kept }) : t("networking.ddns.deleteImpactNever"));
  return lines;
});

async function confirmDelete() {
  const profile = deleteTarget.value;
  if (!profile) return;
  deleting.value = true;
  try {
    await api.ddns.delete(profile.id);
    toast.success(t("networking.ddns.toastDeleted"));
    deleteTarget.value = undefined;
    if (sheet.openId.value === profile.id) sheet.close();
    void profilesQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("networking.ddns.toastDeleteFailed"));
  } finally {
    deleting.value = false;
  }
}

// ── Run now: breaks something outside Lattice (design 23, section 3.8) ──────
//
// A run publishes the node's current public IP to live public DNS, so the
// confirm lists every record it writes and asks for the profile's name.
const running = ref(false);
const runTarget = ref<DDNSView | undefined>();

const runPreview = computed(() => {
  const profile = runTarget.value;
  if (!profile) return [];
  const node = nodeById.value.get(profile.node_id);
  return ddnsRunPreview({ ...profile, domains: profile.domains ?? [] }, node).map((record) =>
    record.previous && record.previous !== record.value
      ? t("networking.ddns.runRecordChanged", { ...record })
      : t("networking.ddns.runRecord", { ...record }),
  );
});

async function confirmRun() {
  const profile = runTarget.value;
  if (!profile || !canAdmin.value) return;
  running.value = true;
  try {
    await api.ddns.run(profile.id);
    runTarget.value = undefined;
    toast.success(t("networking.ddns.toastRunSuccess"));
    void profilesQuery.refresh();
  } catch (error) {
    if (error instanceof ApiError && error.status === 502) {
      toast.error(t("networking.ddns.toastRunBadGateway"));
    } else {
      toast.error(error instanceof Error ? error.message : t("networking.ddns.toastRunFailed"));
    }
    // A failed write is recorded on the profile; show it.
    void profilesQuery.refresh();
  } finally {
    running.value = false;
  }
}
</script>

<template>
  <div class="space-y-5 p-4 sm:p-6">
    <PageHeader :title="$t('networking.ddns.title')">
      <template #description>
        <p class="text-sm text-muted-foreground">{{ $t('networking.ddns.description') }}</p>
        <ProofLine v-bind="proof" :segments="proofSegments" @retry="refreshAll" />
      </template>
      <template #actions>
        <Button variant="outline" size="sm" :disabled="profilesQuery.refreshing.value" @click="refreshAll">
          <RefreshCw :class="cn('size-4', profilesQuery.refreshing.value && 'animate-spin')" aria-hidden="true" />
          {{ $t('common.actions.refresh') }}
        </Button>
        <Button v-if="canAdmin && !listEmpty" size="sm" @click="openCreate">
          <Plus class="size-4" aria-hidden="true" />
          {{ $t('networking.ddns.newProfile') }}
        </Button>
      </template>
    </PageHeader>

    <AttentionList :items="attention" />

    <DataTable
      state-key="profiles"
      :columns="columns"
      :rows="rows"
      :row-key="(profile) => profile.id"
      :loading="profilesQuery.loading.value"
      :error="profilesQuery.error.value"
      :has-data="profilesQuery.data.value !== undefined"
      searchable
      :expression-filter="false"
      :search-placeholder="$t('networking.ddns.searchPlaceholder')"
      :row-click="(profile, el) => sheet.open(profile.id, el)"
      :active-row-id="sheet.openId.value"
      :group-key="grouping === 'node' ? (profile) => profile.node_id : undefined"
      :group-order="groupOrder"
      v-model:collapsed-groups="collapsedNodes"
      :show-summary="false"
      :empty-title="$t('networking.ddns.emptyTitle')"
      :empty-description="$t('networking.ddns.emptyDescription')"
      :no-match-title="$t('networking.shared.noMatchTitle')"
      :no-match-description="$t('networking.shared.noMatchDescription')"
      @retry="refreshAll"
    >
      <template v-if="profilesQuery.data.value !== undefined && !listEmpty" #toolbar>
        <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
          <div class="flex flex-wrap items-center gap-1" role="group" :aria-label="$t('networking.ddns.showLabel')">
            <Button
              v-for="value in showOptions"
              :key="value"
              size="sm"
              type="button"
              :variant="show === value ? 'secondary' : 'ghost'"
              :aria-pressed="show === value"
              @click="show = value"
            >
              {{ $t(`networking.ddns.show.${value}`) }}
              <span class="font-mono text-xs tabular text-muted-foreground">{{ showCounts[value] }}</span>
            </Button>
          </div>
          <div class="flex items-center gap-1" role="group" :aria-label="$t('networking.ddns.groupLabel')">
            <span class="text-xs text-muted-foreground">{{ $t('networking.ddns.groupLabel') }}</span>
            <Button
              v-for="value in (['node', 'none'] as const)"
              :key="value"
              size="sm"
              type="button"
              :variant="grouping === value ? 'secondary' : 'ghost'"
              :aria-pressed="grouping === value"
              @click="grouping = value"
            >
              {{ $t(`networking.ddns.group.${value}`) }}
            </Button>
          </div>
        </div>
      </template>

      <template #empty>
        <EmptyState
          v-if="show === 'all'"
          :title="$t('networking.ddns.emptyTitle')"
          :description="$t('networking.ddns.emptyDescription')"
        >
          <Button v-if="canAdmin" size="sm" type="button" @click="openCreate">
            <Plus aria-hidden="true" />
            {{ $t('networking.ddns.newProfile') }}
          </Button>
        </EmptyState>
        <EmptyState
          v-else
          :title="$t('networking.ddns.showEmpty', { show: $t(`networking.ddns.show.${show}`) })"
          :description="$t('networking.ddns.showEmptyDescription')"
        >
          <Button variant="outline" size="sm" type="button" @click="show = 'all'">{{ $t('networking.ddns.showAll') }}</Button>
        </EmptyState>
      </template>

      <template #group="{ group }">
        <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
          <StatusDot
            v-if="groupSummary(group.key, group.rows).info"
            :status="groupSummary(group.key, group.rows).info!.health"
          />
          <span class="text-sm font-medium text-foreground">{{ nodeNameOf(group.key) }}</span>
          <span
            v-if="groupSummary(group.key, group.rows).info"
            :class="nodeStatusTone(groupSummary(group.key, group.rows).info!.tone)"
          >
            {{ $t(groupSummary(group.key, group.rows).info!.labelKey) }}
            <template v-if="groupSummary(group.key, group.rows).since">{{ $t('networking.ddns.groupSince', { age: groupSummary(group.key, group.rows).since }) }}</template>
          </span>
          <span v-else-if="nodesQuery.data.value !== undefined" class="text-warning-text">{{ $t('networking.ddns.nodeNotListed') }}</span>
          <span aria-hidden="true" class="text-muted-foreground/50">·</span>
          <span class="text-muted-foreground">{{ $t('networking.ddns.groupProfiles', { n: group.rows.length }, group.rows.length) }}</span>
          <template v-if="groupSummary(group.key, group.rows).failing">
            <span aria-hidden="true" class="text-muted-foreground/50">·</span>
            <span class="text-destructive">{{ $t('networking.ddns.proof.failing', { n: groupSummary(group.key, group.rows).failing }) }}</span>
          </template>
        </div>
      </template>

      <template #cell-name="{ row: profile }">
        <span class="font-medium">{{ nameOf(profile) }}</span>
      </template>
      <template #cell-state="{ row: profile }">
        <div class="flex min-w-0 flex-col gap-0.5 text-xs">
          <span :class="cn('whitespace-nowrap', STATE_TONE[assessmentOf(profile).state])">
            {{ $t(`networking.ddns.state.${assessmentOf(profile).state}`) }}
          </span>
          <span
            v-if="assessmentOf(profile).state === 'failing' && profile.last_error"
            class="line-clamp-3 max-w-[26rem] min-w-[14rem] whitespace-normal break-words text-muted-foreground"
            :title="ddnsErrorText(profile.last_error)"
          >{{ ddnsErrorText(profile.last_error) }}</span>
        </div>
      </template>
      <template #cell-node="{ row: profile }">
        <NodeLabel :id="profile.node_id" class="text-xs" />
      </template>
      <template #cell-domains="{ row: profile }">
        <div class="flex flex-col font-mono text-xs">
          <span v-for="domain in profile.domains" :key="domain" class="whitespace-nowrap">{{ domain }}</span>
        </div>
      </template>
      <template #cell-published="{ row: profile }">
        <div class="flex flex-col font-mono text-xs text-muted-foreground">
          <span v-if="profile.enable_ipv4" class="whitespace-nowrap">{{ profile.last_ipv4 || $t('networking.ddns.nothingWritten') }}</span>
          <span v-if="profile.enable_ipv6" class="whitespace-nowrap">{{ profile.last_ipv6 || $t('networking.ddns.nothingWritten') }}</span>
          <span
            v-for="move in assessmentOf(profile).moved"
            :key="move.family"
            class="whitespace-nowrap text-warning-text"
          >{{ $t('networking.ddns.nodeNow', { ip: move.current }) }}</span>
        </div>
      </template>
      <template #cell-last_run="{ row: profile }">
        <div class="flex flex-col text-xs">
          <span
            class="whitespace-nowrap"
            :title="profile.last_run_at && assessmentOf(profile).lastRunMs ? formatDateTime(profile.last_run_at) : undefined"
          >
            {{ assessmentOf(profile).lastRunMs === null ? $t('networking.ddns.neverRun') : $t('networking.ddns.ago', { age: ageSince(assessmentOf(profile).lastRunMs) }) }}
          </span>
          <span class="whitespace-nowrap text-muted-foreground">{{ $t('networking.ddns.every', { interval: intervalText(assessmentOf(profile).intervalS) }) }}</span>
        </div>
      </template>
      <template #cell-actions="{ row: profile }">
        <RowMenu :name="nameOf(profile)" :items="menuFor(profile)" />
      </template>
    </DataTable>

    <ObjectSheet
      :open="!!sheet.openId.value"
      :title="openProfile ? nameOf(openProfile) : (sheet.openId.value ?? '')"
      :subtitle="openProfile ? (openProfile.domains ?? []).join(', ') : undefined"
      :state="sheetState"
      :error="profilesQuery.error.value ? proofReason(profilesQuery.error.value) : null"
      :read-only="!canAdmin"
      :return-focus="sheet.returnFocus"
      :gone-title="$t('networking.ddns.goneTitle')"
      :gone-description="$t('networking.ddns.goneDescription')"
      @close="sheet.close"
    >
      <div v-if="openProfile && openAssessment" class="space-y-5 text-sm">
        <p :class="cn('font-medium', STATE_TONE[openAssessment.state] === 'text-muted-foreground' ? 'text-foreground' : STATE_TONE[openAssessment.state])">
          {{ $t(`networking.ddns.state.${openAssessment.state}`) }}:
          <span class="font-normal">{{ stateSentence(openProfile, openAssessment) }}</span>
        </p>

        <section v-if="openProfile.last_error" class="space-y-1.5">
          <h3 class="text-xs font-medium text-muted-foreground">{{ $t('networking.ddns.sheet.lastError') }}</h3>
          <p class="whitespace-pre-wrap break-words rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-foreground">{{ ddnsErrorText(openProfile.last_error) }}</p>
        </section>

        <section class="space-y-1.5">
          <h3 class="text-xs font-medium text-muted-foreground">{{ $t('networking.ddns.sheet.records') }}</h3>
          <ul class="divide-y divide-border rounded-md border border-border">
            <li
              v-for="record in openRecords"
              :key="`${record.domain}-${record.type}`"
              class="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 py-2 font-mono text-xs"
            >
              <span class="min-w-0 break-all text-foreground">{{ record.domain }}</span>
              <span class="text-muted-foreground">{{ record.type }}</span>
              <span>{{ record.value || $t('networking.ddns.nothingWritten') }}</span>
              <span v-if="record.current && record.current !== record.value" class="text-warning-text">
                {{ $t('networking.ddns.nodeNow', { ip: record.current }) }}
              </span>
            </li>
          </ul>
        </section>

        <dl class="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
          <div class="min-w-0">
            <dt class="text-xs text-muted-foreground">{{ $t('networking.ddns.sheet.node') }}</dt>
            <dd class="flex min-w-0 items-center gap-2">
              <StatusDot v-if="openNode" :status="describeNodeStatus(openNode).health" />
              <NodeLabel :id="openProfile.node_id" link />
              <span v-if="openNode" :class="cn('text-xs', nodeStatusTone(describeNodeStatus(openNode).tone))">{{ $t(describeNodeStatus(openNode).labelKey) }}</span>
            </dd>
            <dd v-if="openNode && openAssessment.noAddress" class="text-xs text-warning-text">{{ $t('networking.ddns.sheet.noAddress') }}</dd>
          </div>
          <div>
            <dt class="text-xs text-muted-foreground">{{ $t('networking.ddns.sheet.schedule') }}</dt>
            <dd>
              {{ $t('networking.ddns.every', { interval: intervalText(openAssessment.intervalS) }) }}
              <span class="text-muted-foreground">
                · {{ openAssessment.lastRunMs === null ? $t('networking.ddns.neverRun') : $t('networking.ddns.sheet.lastRun', { when: formatDateTime(openProfile.last_run_at) }) }}
              </span>
            </dd>
          </div>
          <div>
            <dt class="text-xs text-muted-foreground">{{ $t('networking.ddns.sheet.provider') }}</dt>
            <dd>
              {{ openProfile.provider === 'cloudflare' ? 'Cloudflare' : 'Webhook' }}
              <span class="text-muted-foreground">
                · {{ openProfile.has_credential ? $t('networking.ddns.sheet.credentialSet') : $t('networking.ddns.sheet.credentialNone') }}
              </span>
            </dd>
            <dd v-if="openProfile.webhook_url" class="break-all font-mono text-xs text-muted-foreground">
              {{ openProfile.webhook_method || 'POST' }} {{ openProfile.webhook_url }}
            </dd>
          </div>
          <div>
            <dt class="text-xs text-muted-foreground">{{ $t('networking.ddns.sheet.perRecord') }}</dt>
            <dd>{{ $t('networking.ddns.sheet.recordLine', { ttl: openProfile.ttl, retries: openProfile.max_retries }) }}</dd>
          </div>
          <div v-if="openProfile.provider === 'cloudflare'" class="min-w-0 sm:col-span-2">
            <dt class="text-xs text-muted-foreground">{{ $t('networking.ddns.sheet.comment') }}</dt>
            <dd class="break-words">{{ commentSummary(openProfile) }}</dd>
          </div>
        </dl>
      </div>
      <template v-if="openProfile" #actions>
        <Button variant="outline" size="sm" type="button" @click="openEdit(openProfile)">
          <Pencil aria-hidden="true" />
          {{ $t('networking.ddns.edit') }}
        </Button>
        <Button
          variant="outline"
          size="sm"
          type="button"
          :disabled="!!runBlockedReason(openProfile)"
          :title="runBlockedReason(openProfile)"
          @click="runTarget = openProfile"
        >
          <CloudUpload aria-hidden="true" />
          {{ $t('networking.ddns.runNow') }}
        </Button>
        <RowMenu :name="nameOf(openProfile)" :items="menuFor(openProfile).filter((item) => item.key === 'delete')" />
      </template>
    </ObjectSheet>

    <!-- Create dialog -->
    <Dialog :open="formOpen" @update:open="onFormOpenChange">
      <DialogScrollContent class="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {{ isEditing ? $t('networking.ddns.editProfileTitle') : $t('networking.ddns.newProfileTitle') }}
          </DialogTitle>
          <DialogDescription>
            {{ isEditing ? $t('networking.ddns.editDialogDescription') : $t('networking.ddns.dialogDescription') }}
          </DialogDescription>
        </DialogHeader>

        <form class="space-y-4" @submit.prevent="submitForm">
          <div
            v-if="saveWarnings.length"
            role="status"
            class="rounded-md border border-warning/50 bg-warning/10 px-3 py-2.5 text-sm"
          >
            <p class="font-medium text-warning-text">{{ $t('networking.ddns.warningsTitle', { n: saveWarnings.length }, saveWarnings.length) }}</p>
            <ul class="mt-1.5 list-disc space-y-1 pl-4 text-xs text-foreground">
              <li v-for="warning in saveWarnings" :key="warning" class="break-words">{{ warning }}</li>
            </ul>
          </div>

          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div class="grid gap-2">
              <Label for="ddns-name">{{ $t('networking.ddns.name') }}</Label>
              <Input id="ddns-name" v-model="form.name" required placeholder="edge-ddns" />
            </div>
            <NodePicker
              id="ddns-node"
              v-model="form.node_id"
              :label="$t('networking.ddns.nodeLabel')"
              :placeholder="$t('networking.ddns.selectNode')"
            />
          </div>

          <div class="grid gap-2">
            <Label for="ddns-domains">{{ $t('networking.ddns.domains') }}</Label>
            <Input id="ddns-domains" v-model="form.domains" required placeholder="a.example.com, b.example.com" />
            <p class="text-xs text-muted-foreground">{{ $t('networking.ddns.domainsHint') }}</p>
          </div>

          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div class="grid gap-2">
              <Label for="ddns-provider">{{ $t('networking.ddns.provider') }}</Label>
              <Select v-model="form.provider">
                <SelectTrigger id="ddns-provider" class="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="cloudflare">Cloudflare</SelectItem>
                  <SelectItem value="webhook">Webhook</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div class="flex flex-wrap items-end gap-4 pb-1">
              <label class="flex cursor-pointer items-center gap-2 text-sm">
                <Checkbox v-model="form.enable_ipv4" />
                IPv4 (A)
              </label>
              <label class="flex cursor-pointer items-center gap-2 text-sm">
                <Checkbox v-model="form.enable_ipv6" />
                IPv6 (AAAA)
              </label>
            </div>
          </div>

          <div class="grid gap-2">
            <Label for="ddns-interval">{{ $t('networking.ddns.intervalLabel') }}</Label>
            <Select v-model="form.interval_seconds">
              <SelectTrigger id="ddns-interval" class="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="opt in intervalOptions" :key="opt.value" :value="opt.value">
                  {{ opt.label }}
                </SelectItem>
              </SelectContent>
            </Select>
            <p class="text-xs text-muted-foreground">{{ $t('networking.ddns.intervalHint') }}</p>
          </div>

          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div class="grid gap-2">
              <Label for="ddns-ttl">{{ $t('networking.ddns.ttlSeconds') }}</Label>
              <Input id="ddns-ttl" v-model.number="form.ttl" type="number" min="1" />
            </div>
            <div class="grid gap-2">
              <Label for="ddns-retries">{{ $t('networking.ddns.maxRetries') }}</Label>
              <Input id="ddns-retries" v-model.number="form.max_retries" type="number" min="0" />
            </div>
          </div>

          <!-- Cloudflare -->
          <div v-if="form.provider === 'cloudflare'" class="grid gap-2">
            <Label for="ddns-cf-token">{{ $t('networking.ddns.cfApiToken') }}</Label>
            <Input
              id="ddns-cf-token"
              v-model="form.cf_api_token"
              type="password"
              autocomplete="off"
              :placeholder="$t('networking.ddns.cfTokenPlaceholder')"
            />
            <p class="text-xs text-muted-foreground">
              {{ isEditing && editingHasCredential
                ? $t('networking.ddns.cfTokenKeepHint')
                : $t('networking.ddns.cfTokenHint') }}
            </p>
          </div>

          <!-- Record comment: Cloudflare only; a webhook has nowhere to put one. -->
          <fieldset v-if="form.provider === 'cloudflare'" class="grid gap-2">
            <legend class="mb-2 text-sm font-medium">{{ $t('networking.ddns.comment.label') }}</legend>
            <div class="flex flex-wrap gap-x-5 gap-y-1 text-sm">
              <label v-for="mode in DDNS_COMMENT_MODES" :key="mode" class="flex cursor-pointer items-center gap-2 pointer-coarse:min-h-11">
                <input v-model="form.comment_mode" type="radio" name="ddns-comment-mode" :value="mode" class="size-4 accent-primary" />
                {{ $t(`networking.ddns.comment.mode.${mode}`) }}
              </label>
            </div>

            <template v-if="form.comment_mode === 'custom'">
              <Label :for="COMMENT_INPUT_ID" class="sr-only">{{ $t('networking.ddns.comment.templateLabel') }}</Label>
              <Input
                :id="COMMENT_INPUT_ID"
                v-model="form.record_comment"
                class="font-mono text-xs"
                autocomplete="off"
                spellcheck="false"
                :placeholder="DDNS_DEFAULT_COMMENT_TEMPLATE"
                :aria-invalid="templateProblem && templateProblem.kind !== 'empty' ? true : undefined"
                aria-describedby="ddns-comment-help"
              />
              <div class="flex flex-wrap gap-1.5" role="group" :aria-label="$t('networking.ddns.comment.placeholders')">
                <button
                  v-for="placeholder in DDNS_COMMENT_PLACEHOLDERS"
                  :key="placeholder"
                  type="button"
                  class="rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[11px] text-foreground transition-colors hover:border-primary/50 hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring pointer-coarse:min-h-9 pointer-coarse:px-2.5"
                  :aria-label="$t('networking.ddns.comment.insert', { placeholder })"
                  @click="insertPlaceholder(placeholder)"
                >{{ placeholder }}</button>
              </div>
              <!-- An empty template only needs saying, not flagging, before anything is typed. -->
              <p
                v-if="templateProblemText"
                id="ddns-comment-help"
                :class="cn('text-xs', templateProblem?.kind === 'empty' ? 'text-muted-foreground' : 'text-destructive')"
                aria-live="polite"
              >{{ templateProblemText }}</p>
              <p v-else id="ddns-comment-help" class="text-xs text-muted-foreground">
                {{ $t('networking.ddns.comment.customHint', { max: DDNS_COMMENT_TEMPLATE_MAX_BYTES }) }}
              </p>
            </template>
            <p v-else-if="form.comment_mode === 'default'" class="text-xs text-muted-foreground">
              {{ $t('networking.ddns.comment.defaultHint') }}
              <code class="font-mono">{{ DDNS_DEFAULT_COMMENT_TEMPLATE }}</code>
            </p>
            <p v-else class="text-xs text-muted-foreground">{{ $t('networking.ddns.comment.noneHint') }}</p>

            <div v-if="form.comment_mode !== 'none'" class="rounded-md border border-border bg-muted/30 px-3 py-2">
              <div class="flex items-baseline justify-between gap-3 text-xs text-muted-foreground">
                <span class="min-w-0 truncate">{{ $t('networking.ddns.comment.previewFor', previewTarget) }}</span>
                <span
                  :class="cn('shrink-0 font-mono tabular', commentPreview.fullChars > DDNS_COMMENT_MAX_CHARS && 'text-warning-text')"
                >{{ $t('networking.ddns.comment.counter', { n: commentPreview.chars, max: DDNS_COMMENT_MAX_CHARS }) }}</span>
              </div>
              <p class="mt-1 break-all font-mono text-xs text-foreground" aria-live="polite">{{ commentPreview.text }}</p>
              <p v-if="commentPreview.fullChars > DDNS_COMMENT_MAX_CHARS" class="mt-1 text-xs text-warning-text">
                {{ $t('networking.ddns.comment.cut', { max: DDNS_COMMENT_MAX_CHARS, n: commentPreview.fullChars - commentPreview.chars }) }}
              </p>
              <p class="mt-1 text-[11px] text-muted-foreground">{{ $t('networking.ddns.comment.previewHint') }}</p>
            </div>
          </fieldset>

          <!-- Webhook -->
          <template v-else>
            <div class="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_140px]">
              <div class="grid gap-2">
                <Label for="ddns-wh-url">{{ $t('networking.ddns.webhookUrl') }}</Label>
                <Input id="ddns-wh-url" v-model="form.webhook_url" placeholder="https://example.com/ddns" />
              </div>
              <div class="grid gap-2">
                <Label for="ddns-wh-method">{{ $t('networking.ddns.method') }}</Label>
                <Input id="ddns-wh-method" v-model="form.webhook_method" placeholder="POST" />
              </div>
            </div>
            <div class="grid gap-2">
              <Label for="ddns-wh-body">{{ $t('networking.ddns.webhookBody') }}</Label>
              <Textarea
                id="ddns-wh-body"
                v-model="form.webhook_body"
                rows="3"
                placeholder='{"ip":"#ip#","domain":"#domain#","type":"#type#"}'
                class="font-mono text-xs"
              />
              <p class="text-xs text-muted-foreground">
                {{ $t('networking.ddns.webhookBodyHint') }}
                <code class="font-mono">#ip#</code>, <code class="font-mono">#domain#</code>,
                <code class="font-mono">#type#</code>.
              </p>
            </div>
            <div class="grid gap-2">
              <Label for="ddns-wh-headers">{{ $t('networking.ddns.webhookHeaders') }}</Label>
              <Textarea
                id="ddns-wh-headers"
                v-model="form.webhook_headers"
                rows="2"
                placeholder="Authorization: Bearer xxx&#10;Content-Type: application/json"
                class="font-mono text-xs"
              />
              <p class="text-xs text-muted-foreground">{{ $t('networking.ddns.webhookHeadersHint') }}</p>
            </div>
          </template>

          <DialogFooter>
            <Button v-if="saveWarnings.length" type="button" variant="outline" @click="closeForm">
              {{ $t('networking.ddns.done') }}
            </Button>
            <Button v-else type="button" variant="outline" @click="onFormOpenChange(false)">
              {{ $t('common.actions.cancel') }}
            </Button>
            <Button type="submit" :disabled="saving || !canSubmit">
              <RefreshCw v-if="saving" class="size-4 animate-spin" aria-hidden="true" />
              <Pencil v-else-if="isEditing" class="size-4" aria-hidden="true" />
              <Plus v-else class="size-4" aria-hidden="true" />
              {{ isEditing ? $t('networking.ddns.saveChanges') : $t('common.actions.create') }}
            </Button>
          </DialogFooter>
        </form>
      </DialogScrollContent>
    </Dialog>

    <!-- Run now writes public DNS: the outside-breaking class. -->
    <ConfirmDialog
      :open="!!runTarget"
      :title="$t('networking.ddns.runTitle', { name: runTarget ? nameOf(runTarget) : '' })"
      :description="$t('networking.ddns.runDescription')"
      :impact-title="$t('networking.ddns.runImpactTitle')"
      :impact="runPreview"
      :typed-confirm="runTarget ? nameOf(runTarget) : undefined"
      :confirm-label="$t('networking.ddns.runConfirm')"
      :cancel-label="$t('common.actions.cancel')"
      :pending="running"
      @update:open="(v) => { if (!v) runTarget = undefined; }"
      @confirm="confirmRun"
    />

    <!-- Unsaved-changes guard: the form carries a Cloudflare token. -->
    <ConfirmDialog
      :open="discardOpen"
      variant="destructive"
      :title="$t('networking.shared.discardTitle')"
      :description="$t('networking.shared.discardDescription')"
      :confirm-label="$t('networking.shared.discardConfirm')"
      :cancel-label="$t('common.actions.cancel')"
      @update:open="(v) => { if (!v) discardOpen = false; }"
      @confirm="confirmDiscard"
    />

    <!-- Delete: irreversible inside Lattice, and the records stay as written. -->
    <ConfirmDialog
      :open="!!deleteTarget"
      :title="$t('networking.ddns.deleteTitle')"
      :description="$t('networking.ddns.deleteDescription', { name: deleteTarget ? nameOf(deleteTarget) : '' })"
      :impact-title="$t('networking.ddns.deleteImpactTitle')"
      :impact="deleteImpact"
      :confirm-label="$t('common.actions.delete')"
      :cancel-label="$t('common.actions.cancel')"
      :pending="deleting"
      @update:open="(v) => { if (!v) deleteTarget = undefined; }"
      @confirm="confirmDelete"
    />
  </div>
</template>

<script setup lang="ts">
/**
 * Network Policy (design 23, section 4.4): who reaches whom, and what each
 * node enforces.
 *
 * Two layers on `?view=`. Overview is the group matrix, the page's one
 * picture: a cell click writes the rule for that pair. Policies is the
 * per-node collection; a row opens the node's policy in the sheet on
 * `?open=<node id>`, and the sheet lists the node-to-node edges the server
 * draws for it, when there are any. The old Graph tab is gone: 34 spokes
 * and no edges said nothing, and names cut to 8 characters made all 13
 * `[Metix]-` nodes read the same. An old `?tab=` link lands on its layer.
 *
 * NetGuard also writes nftables, so the overview says so and links to it.
 * Deleting a policy leaves its ruleset on the node (design 23, section 3.8,
 * "leaves config on a node"): the confirm names the node and what keeps
 * running, and asks for the node's name.
 */
import { computed, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { toast } from "@/lib/toast";
import { AlertTriangle, FolderTree, Pencil, Play, Plus, RefreshCw, Trash2 } from "lucide-vue-next";
import {
  api,
  unwrap,
  type ApprovalView,
  type GroupPolicyPlanResult,
  type GroupPolicyUpsertRequest,
  type GroupPolicyView,
  type MatrixGroup,
  type NetEndpointKind,
  type NetPolicyMatrix,
  type NetPolicyUpsertRequest,
  type NetPolicyView,
  type NetRule,
  type NetRuleAction,
  type NetRuleDirection,
  type NetRuleProtocol,
} from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { useLayer } from "@/composables/useLayer";
import { useOwnedRoute } from "@/composables/useOwnedRoute";
import { usePlanDigest } from "@/composables/usePlanDigest";
import { usePluginContributions } from "@/composables/usePluginContributions";
import { useProof } from "@/composables/useProof";
import { useRouteOpen } from "@/composables/useRouteOpen";
import { provideNodeDirectory } from "@/composables/useNodeDirectory";
import { useAuthStore } from "@/stores/auth";
import { formatAge, formatDateTime, shortId } from "@/lib/format";
import { cn } from "@/lib/utils";
import { proofReason } from "@/components/common/proofModel";
import { NETGUARD_PLUGIN_ID, pluginPagePath } from "@/views/platform/pluginsModel";

import PageHeader from "@/components/common/PageHeader.vue";
import ProofLine, { type ProofSegment } from "@/components/common/ProofLine.vue";
import AttentionList, { type AttentionItem } from "@/components/common/AttentionList.vue";
import LayerTabs, { type LayerTab } from "@/components/common/LayerTabs.vue";
import DataState from "@/components/common/DataState.vue";
import EmptyState from "@/components/common/EmptyState.vue";
import ConfirmDialog from "@/components/common/ConfirmDialog.vue";
import PlanReviewDialog from "@/components/common/PlanReviewDialog.vue";
import DataTable, { type DataTableColumn } from "@/components/common/DataTable.vue";
import NodeLabel from "@/components/common/NodeLabel.vue";
import ObjectSheet from "@/components/common/ObjectSheet.vue";
import RowMenu, { type RowMenuItem } from "@/components/common/RowMenu.vue";
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
import PolicyMatrix from "@/components/networking/PolicyMatrix.vue";
import PolicyCellEditor from "@/components/networking/PolicyCellEditor.vue";

/**
 * Go's `omitempty` does not drop a zero time.Time, so a policy that was never
 * applied arrives as "0001-01-01T00:00:00Z" and formats into a real-looking
 * year-1 date rather than falling through to "never".
 */
function hasRealTime(value?: string): boolean {
  return !!value && !value.startsWith("0001");
}

const { t, locale } = useI18n();
const router = useRouter();
const auth = useAuthStore();
const canRead = computed(() => auth.can("netpolicy:read"));
const canAdmin = computed(() => auth.can("netpolicy:admin"));

const LAYERS = ["overview", "policies"] as const;
type Layer = (typeof LAYERS)[number];
const layer = useLayer<Layer>(() => LAYERS, () => "overview");

const policiesQuery = useAsyncData((signal) => api.netpolicy.list({ signal }).then((r) => unwrap(r, "policies")), {
  pollInterval: 15000,
});
const nodesQuery = useAsyncData((signal) => api.nodes.list({ signal }).then((r) => unwrap(r, "nodes")), {
  pollInterval: 0,
});
const graphQuery = useAsyncData((signal) => api.netpolicy.graph({ signal }), { immediate: false });

const policies = computed(() => policiesQuery.data.value ?? []);
const nodes = computed(() => nodesQuery.data.value ?? []);
provideNodeDirectory(computed(() => nodesQuery.data.value));

// ── Reachability matrix (the overview picture) ─────────────────────────────────────
const matrixDirection = ref<NetRuleDirection>("egress");
const matrixQuery = useAsyncData((signal) => api.netpolicy.matrix(matrixDirection.value, { signal }), {
  pollInterval: 0,
});
const groupPoliciesQuery = useAsyncData(
  (signal) => api.groupPolicy.list({ signal }).then((r) => unwrap(r, "policies")),
  { pollInterval: 0 },
);
const matrix = computed<NetPolicyMatrix | undefined>(() => matrixQuery.data.value);
const groupPolicies = computed<GroupPolicyView[]>(() => groupPoliciesQuery.data.value ?? []);
const matrixGroups = computed<MatrixGroup[]>(() => matrix.value?.groups ?? []);
const hasGroups = computed(() => matrixGroups.value.length > 0);
const hasGroupPolicies = computed(() => groupPolicies.value.length > 0);

function setMatrixDirection(value: NetRuleDirection) {
  matrixDirection.value = value;
  matrixQuery.refresh();
}

function refreshMatrix() {
  matrixQuery.refresh();
  groupPoliciesQuery.refresh();
}

function goToGroups() {
  router.push("/groups");
}

// ── Group-policy cell editor (source group to dest group) ──────────────────
const cellEditorOpen = ref(false);
const cellSource = ref<MatrixGroup | undefined>(undefined);
const cellDest = ref<MatrixGroup | undefined>(undefined);
const savingCell = ref(false);

const cellSourcePolicy = computed<GroupPolicyView | undefined>(() =>
  cellSource.value
    ? groupPolicies.value.find((p) => p.scope_group_id === cellSource.value!.id)
    : undefined,
);

function openCellEditor(source: MatrixGroup, dest: MatrixGroup) {
  if (!canAdmin.value) return;
  cellSource.value = source;
  cellDest.value = dest;
  cellEditorOpen.value = true;
}

async function saveCell(payload: GroupPolicyUpsertRequest) {
  savingCell.value = true;
  try {
    await api.groupPolicy.upsert(payload);
    toast.success(t("networking.matrix.toastSaved"));
    cellEditorOpen.value = false;
    refreshMatrix();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("networking.matrix.toastSaveFailed"));
  } finally {
    savingCell.value = false;
  }
}

// ── Group-policy plan (expand to per-node approvals) ───────────────────────
const planResult = ref<GroupPolicyPlanResult | undefined>(undefined);
const planResultOpen = ref(false);
const planningGroups = ref(false);
const planSelectorRiskAccepted = ref(false);

const planSelectorImpacts = computed(() => planResult.value?.selector_impacts ?? []);
const planRequiresSelectorConfirmation = computed(() => planSelectorImpacts.value.length > 0);
const canOpenPlanApprovals = computed(
  () => !planRequiresSelectorConfirmation.value || planSelectorRiskAccepted.value,
);

async function planGroupPolicies() {
  if (!canAdmin.value) return;
  planningGroups.value = true;
  try {
    const result = await api.groupPolicy.plan();
    planResult.value = result;
    planSelectorRiskAccepted.value = false;
    planResultOpen.value = true;
    // The server plans node by node and routes the ones it could not expand into
    // `conflicts` while still answering 200. A green "Planned" toast over a run
    // where half the fleet produced no plan is the failure mode this console is
    // supposed to make impossible.
    if (result.conflicts.length) {
      toast.warning(
        t("networking.matrix.toastPlannedPartial", {
          n: result.affected.length,
          c: result.conflicts.length,
        }),
      );
    } else {
      toast.success(t("networking.matrix.toastPlanned", { n: result.affected.length }));
    }
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("networking.shared.toastPlanFailed"));
  } finally {
    planningGroups.value = false;
  }
}

function setPlanResultOpen(value: boolean) {
  planResultOpen.value = value;
  if (!value) planSelectorRiskAccepted.value = false;
}

function openPlanApprovals() {
  if (!canOpenPlanApprovals.value) return;
  planResultOpen.value = false;
  router.push("/approvals");
}

const sortedPolicies = computed(() =>
  [...policies.value].sort((a, b) =>
    (a.target_node_name || a.target_node_id).localeCompare(b.target_node_name || b.target_node_id),
  ),
);

function policyNodeLabel(p: NetPolicyView): string {
  return p.target_node_name || nodeName(p.target_node_id);
}

function nodeName(id: string): string {
  return nodes.value.find((n) => n.id === id)?.name || id;
}

function nodeNameList(ids: string[], limit = 6): string {
  const names = ids.slice(0, limit).map((id) => nodeName(id));
  const remaining = ids.length - limit;
  return remaining > 0 ? `${names.join(", ")} +${remaining}` : names.join(", ");
}

function selectorUseLabel(use: string): string {
  if (use === "scope") return t("networking.matrix.selectorImpactUseScope");
  if (use === "remote") return t("networking.matrix.selectorImpactUseRemote");
  return use;
}

function activeRuleCount(p: NetPolicyView): number {
  return p.rules.filter((r) => !r.disabled).length;
}

const policyColumns = computed<DataTableColumn<NetPolicyView>[]>(() => [
  {
    key: "target",
    label: t("networking.policy.colTargetNode"),
    sortable: true,
    searchable: true,
    value: (p) => policyNodeLabel(p),
  },
  { key: "state", label: t("networking.policyPage.colState"), sortable: true, value: (p) => policyStateOrder(p) },
  { key: "rules", label: t("networking.policy.colRules"), align: "right", sortable: true, value: (p) => p.rules.length },
  { key: "last_applied", label: t("networking.policy.colLastApplied"), sortable: true, value: (p) => (hasRealTime(p.last_applied_at) ? p.last_applied_at : "") },
  { key: "actions", label: "", class: "w-12", pin: "end" },
]);

/* ------------------------------------------------------------------ */
/* Policy state                                                        */
/* ------------------------------------------------------------------ */

type PolicyState = "failing" | "unapplied" | "applied" | "disabled";

/**
 * What a node's policy amounts to on the node. A failed apply is the only
 * red; an enabled policy that never applied is not enforced yet; a disabled
 * one is the operator's choice and stays quiet.
 */
function policyState(p: NetPolicyView): PolicyState {
  if (p.last_error) return "failing";
  if (!p.enabled) return "disabled";
  return hasRealTime(p.last_applied_at) ? "applied" : "unapplied";
}

const STATE_ORDER: Record<PolicyState, number> = { failing: 0, unapplied: 1, applied: 2, disabled: 3 };
const STATE_TONE: Record<PolicyState, string> = {
  failing: "text-destructive",
  unapplied: "text-warning-text",
  applied: "text-muted-foreground",
  disabled: "text-muted-foreground",
};

function policyStateOrder(p: NetPolicyView): number {
  return STATE_ORDER[policyState(p)];
}

function ago(value?: string): string {
  if (!hasRealTime(value)) return t("common.misc.never");
  const ms = Date.parse(value!);
  if (Number.isNaN(ms)) return t("common.misc.never");
  return t("networking.policyPage.ago", { age: formatAge(Date.now() - ms, locale.value) });
}

const counts = computed(() => {
  const out = { failing: 0, unapplied: 0, applied: 0, disabled: 0 };
  for (const p of policies.value) out[policyState(p)] += 1;
  return out;
});

/* ------------------------------------------------------------------ */
/* Head: proof line and attention                                      */
/* ------------------------------------------------------------------ */

const proof = useProof(policiesQuery);

const proofSegments = computed<ProofSegment[]>(() => {
  const parts: ProofSegment[] = [];
  if (matrixQuery.data.value !== undefined) {
    parts.push({ key: "groups", text: t("networking.policyPage.proof.groups", { n: matrixGroups.value.length }, matrixGroups.value.length) });
  }
  if (groupPoliciesQuery.data.value !== undefined) {
    parts.push({ key: "group-policies", text: t("networking.policyPage.proof.groupPolicies", { n: groupPolicies.value.length }, groupPolicies.value.length) });
  }
  const n = policies.value.length;
  parts.push({ key: "policies", text: t("networking.policyPage.proof.nodePolicies", { n }, n), to: { query: { view: "policies" } } });
  const c = counts.value;
  if (c.applied) parts.push({ key: "applied", text: t("networking.policyPage.proof.applied", { n: c.applied }) });
  if (c.unapplied) parts.push({ key: "unapplied", text: t("networking.policyPage.proof.unapplied", { n: c.unapplied }), tone: "warning" });
  if (c.failing) parts.push({ key: "failing", text: t("networking.policyPage.proof.failing", { n: c.failing }), tone: "destructive" });
  return parts;
});

function refreshAll(): void {
  void policiesQuery.refresh();
  void matrixQuery.refresh();
  void groupPoliciesQuery.refresh();
  void nodesQuery.refresh();
  if (graphQuery.data.value !== undefined || graphQuery.error.value) void graphQuery.refresh();
}

const sheet = useRouteOpen();

const owned = useOwnedRoute();

/**
 * Open a policy from the overview's attention list: the collection layer and
 * the sheet in one entry. useLayer and useRouteOpen each own the route
 * separately, so two writes in one tick would each build on the same query
 * and the second would drop the first's key.
 */
function openPolicy(p: NetPolicyView): void {
  if (layer.value === "policies") {
    sheet.open(p.target_node_id);
    return;
  }
  owned.push({ ...owned.query(), view: "policies", open: p.target_node_id });
}

function firstLine(text: string): string {
  const line = text.split("\n")[0]?.trim() ?? "";
  return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}

const attention = computed<AttentionItem[]>(() => {
  const items: AttentionItem[] = [];
  for (const p of sortedPolicies.value) {
    const state = policyState(p);
    const action = { label: t("networking.policyPage.attention.open"), run: () => openPolicy(p) };
    if (state === "failing") {
      items.push({
        key: `failing:${p.target_node_id}`,
        tone: "danger",
        claim: t("networking.policyPage.attention.failingClaim", { node: policyNodeLabel(p) }),
        proof: firstLine(p.last_error ?? ""),
        action,
      });
    } else if (state === "unapplied") {
      items.push({
        key: `unapplied:${p.target_node_id}`,
        tone: "warning",
        claim: t("networking.policyPage.attention.unappliedClaim", { node: policyNodeLabel(p) }),
        proof: p.last_plan_sha
          ? t("networking.policyPage.attention.unappliedPlanned", { sha: shortId(p.last_plan_sha, 12) })
          : t("networking.policyPage.attention.unappliedNever"),
        action,
      });
    }
  }
  return items;
});

/* ------------------------------------------------------------------ */
/* Layers                                                              */
/* ------------------------------------------------------------------ */

const layerTabs = computed<LayerTab<Layer>[]>(() => [
  { value: "overview", label: t("networking.policyPage.layers.overview") },
  {
    value: "policies",
    label: t("networking.policyPage.layers.policies"),
    count: policiesQuery.data.value !== undefined ? policies.value.length : undefined,
  },
]);

/** NetGuard writes nftables too; the overview names it and links to its page. */
const { findPlugin } = usePluginContributions();
const netguard = computed(() => findPlugin(NETGUARD_PLUGIN_ID));
const netguardTo = computed(() => {
  const plugin = netguard.value;
  if (!plugin) return null;
  return pluginPagePath(plugin) ?? { path: "/platform/plugins", query: { open: plugin.id } };
});

/* ------------------------------------------------------------------ */
/* Sheet                                                               */
/* ------------------------------------------------------------------ */

const openPolicyRow = computed(() => policies.value.find((p) => p.target_node_id === sheet.openId.value));

const sheetState = computed(() => {
  if (!sheet.openId.value) return "ready" as const;
  if (openPolicyRow.value) return policiesQuery.error.value ? ("stale" as const) : ("ready" as const);
  if (policiesQuery.data.value === undefined) return policiesQuery.error.value ? ("gone" as const) : ("loading" as const);
  return "gone" as const;
});

/** The graph is read when a sheet opens, for the node's edges; never on its own tab. */
watch(
  () => sheet.openId.value,
  (id) => {
    if (id && graphQuery.data.value === undefined && !graphQuery.loading.value) void graphQuery.refresh();
  },
  { immediate: true },
);

interface SheetEdge {
  key: string;
  outbound: boolean;
  peer: string;
  allow: boolean;
  label: string;
}

const openEdges = computed<SheetEdge[]>(() => {
  const id = sheet.openId.value;
  if (!id) return [];
  const out: SheetEdge[] = [];
  for (const edge of graphQuery.data.value?.edges ?? []) {
    if (edge.from !== id && edge.to !== id) continue;
    const outbound = edge.from === id;
    out.push({
      key: `${edge.rule_id}:${edge.from}:${edge.to}`,
      outbound,
      peer: outbound ? edge.to : edge.from,
      allow: edge.action === "allow",
      label: `${edge.protocol}${edge.ports?.length ? `:${edge.ports.join(",")}` : ""}`,
    });
  }
  return out;
});

function remoteText(rule: NetRule): string {
  switch (rule.remote.kind) {
    case "node":
      return rule.remote.node_id ? nodeName(rule.remote.node_id) : t("networking.policyPage.remote.node");
    case "cidr":
      return rule.remote.cidr ?? "";
    case "domain":
      return rule.remote.domain ?? "";
    case "group":
      return rule.remote.group_id ? groupName(rule.remote.group_id) : t("networking.policyPage.remote.group");
    default:
      return t("networking.policyPage.remote.any");
  }
}

function groupName(id: string): string {
  return matrixGroups.value.find((g) => g.id === id)?.name ?? id;
}

function menuFor(p: NetPolicyView): RowMenuItem[] {
  return [
    { key: "plan", label: t("networking.shared.plan"), icon: Play, hidden: !canAdmin.value, disabled: planning.value === p.target_node_id, run: () => void plan(p) },
    { key: "edit", label: t("common.actions.edit"), icon: Pencil, hidden: !canAdmin.value, run: () => openEdit(p) },
    { key: "delete", label: t("common.actions.delete"), icon: Trash2, danger: true, hidden: !canAdmin.value, run: () => (deleteTarget.value = p) },
  ];
}

const deleteImpact = computed(() => {
  const p = deleteTarget.value;
  if (!p) return [];
  return [
    t("networking.policyPage.delete.impactRuleset", { node: policyNodeLabel(p) }),
    t("networking.policyPage.delete.impactNoRemoval"),
  ];
});


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

// Snapshot of the form at open time, drives the unsaved-changes (dirty) guard.
const formSnapshot = ref("");
function snapshotForm(): string {
  return JSON.stringify({
    target_node_id: form.target_node_id,
    enabled: form.enabled,
    rules: form.rules,
  });
}
const isDirty = computed(() => dialogOpen.value && snapshotForm() !== formSnapshot.value);
// Confirm dialog shown when the operator tries to discard unsaved edits.
const discardConfirmOpen = ref(false);

function openCreate() {
  editingId.value = undefined;
  form.target_node_id = "";
  form.enabled = true;
  form.rules = [emptyRule()];
  formSnapshot.value = snapshotForm();
  dialogOpen.value = true;
}

function openEdit(p: NetPolicyView) {
  editingId.value = p.target_node_id;
  form.target_node_id = p.target_node_id;
  form.enabled = p.enabled;
  form.rules = p.rules.length ? p.rules.map(ruleToDraft) : [emptyRule()];
  formSnapshot.value = snapshotForm();
  dialogOpen.value = true;
}

/** Intercept dialog close: when dirty, ask before discarding. */
function requestCloseDialog() {
  if (isDirty.value) {
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

function addRule() {
  form.rules.push(emptyRule());
}

function removeRule(index: number) {
  form.rules.splice(index, 1);
}

/** domain remotes are egress-only; clear protocol ports when protocol=any. */
function ruleError(draft: RuleDraft): string | undefined {
  if (draft.remoteKind === "domain" && draft.direction === "ingress") {
    return t("networking.policy.errDomainEgressOnly");
  }
  if (draft.remoteKind === "node" && !draft.remoteNodeId) return t("networking.policy.errSelectNode");
  if (draft.remoteKind === "cidr" && !draft.remoteCidr.trim()) return t("networking.policy.errEnterCidr");
  if (draft.remoteKind === "domain" && !draft.remoteDomain.trim()) return t("networking.policy.errEnterDomain");
  if (draft.protocol === "any" && parsePorts(draft.ports).length > 0) {
    return t("networking.policy.errAnyNoPorts");
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
    toast.success(editingId.value ? t("networking.policy.toastUpdated") : t("networking.policy.toastCreated"));
    dialogOpen.value = false;
    policiesQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("networking.policy.toastSaveFailed"));
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
    toast.success(t("networking.policy.toastDeleted"));
    deleteTarget.value = undefined;
    policiesQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("networking.policy.toastDeleteFailed"));
  } finally {
    deleting.value = false;
  }
}

// ── Plan dialog ───────────────────────────────────────────────────────────
const planDigest = usePlanDigest();
const planning = ref<string | undefined>(undefined);
const planApproval = ref<ApprovalView | undefined>(undefined);
const planSha = ref("");

async function plan(p: NetPolicyView) {
  if (!canAdmin.value) return;
  planning.value = p.target_node_id;
  try {
    const approval = await api.netpolicy.plan(p.target_node_id);
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
  <div class="space-y-5 p-4 sm:p-6">
    <PageHeader :title="$t('networking.policy.title')">
      <template #description>
        <p class="text-sm text-muted-foreground">{{ $t('networking.policyPage.description') }}</p>
        <ProofLine v-bind="proof" :segments="proofSegments" @retry="refreshAll" />
      </template>
      <template #actions>
        <Button variant="outline" size="sm" :disabled="policiesQuery.refreshing.value" @click="refreshAll">
          <RefreshCw :class="cn('size-4', policiesQuery.refreshing.value && 'animate-spin')" aria-hidden="true" />
          {{ $t('common.actions.refresh') }}
        </Button>
        <Button
          v-if="layer === 'overview' && canAdmin && hasGroupPolicies"
          variant="outline"
          size="sm"
          :disabled="planningGroups"
          @click="planGroupPolicies"
        >
          <RefreshCw v-if="planningGroups" class="size-4 animate-spin" aria-hidden="true" />
          <Play v-else class="size-4" aria-hidden="true" />
          {{ $t('networking.policyPage.planGroups') }}
        </Button>
        <Button v-else-if="layer === 'policies' && canAdmin && policies.length > 0" size="sm" @click="openCreate">
          <Plus class="size-4" aria-hidden="true" />
          {{ $t('networking.policyPage.newNodePolicy') }}
        </Button>
      </template>
    </PageHeader>

    <LayerTabs v-model="layer" :tabs="layerTabs" :label="$t('networking.policyPage.layersLabel')" />

    <AttentionList :items="attention" />

    <!-- Overview: the group matrix is the picture; a cell click writes the rule for that pair. -->
    <section v-if="layer === 'overview'" class="space-y-3" aria-labelledby="policy-matrix-heading">
      <div class="space-y-0.5">
        <h2 id="policy-matrix-heading" class="text-sm font-medium">{{ $t('networking.matrix.title') }}</h2>
        <p class="text-xs text-muted-foreground">
          {{ canAdmin && hasGroups ? $t('networking.policyPage.matrixHintAdmin') : $t('networking.matrix.description') }}
        </p>
      </div>
      <DataState
        :loading="matrixQuery.loading.value"
        :error="matrixQuery.error.value"
        :has-data="matrix !== undefined"
        :is-empty="!hasGroups"
        :empty-title="$t('networking.matrix.emptyGroupsTitle')"
        :empty-description="$t('networking.matrix.emptyGroupsDescription')"
        @retry="refreshMatrix"
      >
        <template #empty>
          <EmptyState
            :icon="FolderTree"
            :title="$t('networking.matrix.emptyGroupsTitle')"
            :description="$t('networking.matrix.emptyGroupsDescription')"
          >
            <Button size="sm" variant="outline" @click="goToGroups">
              <FolderTree class="size-4" aria-hidden="true" />
              {{ $t('networking.matrix.goToGroups') }}
            </Button>
          </EmptyState>
        </template>
        <div class="space-y-2">
          <PolicyMatrix
            v-if="matrix"
            :matrix="matrix"
            :direction="matrixDirection"
            :can-admin="canAdmin"
            @update:direction="setMatrixDirection"
            @edit="openCellEditor"
          />
          <p v-if="matrix && !hasGroupPolicies" class="text-xs text-muted-foreground">
            {{ $t('networking.policyPage.noGroupPolicies') }}
          </p>
        </div>
      </DataState>

      <div class="space-y-1 rounded-md border border-border px-3 py-2.5 text-sm">
        <p v-if="policiesQuery.data.value !== undefined && counts.applied === 0" class="text-foreground">
          {{ $t('networking.policyPage.noneEnforced') }}
        </p>
        <p class="text-muted-foreground">
          {{ netguardTo ? $t('networking.policyPage.netguardNote') : $t('networking.policyPage.netguardAbsent') }}
          <RouterLink v-if="netguardTo" :to="netguardTo" class="whitespace-nowrap text-primary underline-offset-4 hover:underline">
            {{ $t('networking.policyPage.openNetguard') }}
          </RouterLink>
        </p>
      </div>
    </section>

    <!-- Policies: one row per node; a row opens the node's policy in the sheet. -->
    <DataTable
      v-else
      state-key="policies"
      :columns="policyColumns"
      :rows="sortedPolicies"
      :row-key="(p) => p.target_node_id"
      :loading="policiesQuery.loading.value"
      :error="policiesQuery.error.value"
      :has-data="policiesQuery.data.value !== undefined"
      searchable
      :expression-filter="false"
      :search-placeholder="$t('networking.policyPage.searchPlaceholder')"
      :row-click="(p, el) => sheet.open(p.target_node_id, el)"
      :active-row-id="sheet.openId.value"
      :show-summary="false"
      :empty-title="$t('networking.policy.emptyTitle')"
      :empty-description="canRead ? $t('networking.policy.emptyWithRead') : $t('networking.policy.emptyNeedRead')"
      :no-match-title="$t('networking.shared.noMatchTitle')"
      :no-match-description="$t('networking.shared.noMatchDescription')"
      @retry="refreshAll"
    >
      <template #empty>
        <EmptyState
          :title="$t('networking.policy.emptyTitle')"
          :description="canRead ? $t('networking.policy.emptyWithRead') : $t('networking.policy.emptyNeedRead')"
        >
          <Button v-if="canAdmin" size="sm" type="button" @click="openCreate">
            <Plus aria-hidden="true" />
            {{ $t('networking.policyPage.newNodePolicy') }}
          </Button>
        </EmptyState>
      </template>
      <template #cell-target="{ row: p }">
        <NodeLabel :id="p.target_node_id" class="font-medium" />
      </template>
      <template #cell-state="{ row: p }">
        <span :class="cn('whitespace-nowrap text-xs', STATE_TONE[policyState(p)])">
          {{ $t(`networking.policyPage.state.${policyState(p)}`) }}
        </span>
      </template>
      <template #cell-rules="{ row: p }">
        <span class="font-mono text-xs tabular-nums">{{ $t('networking.policyPage.rulesActive', { active: activeRuleCount(p), total: p.rules.length }) }}</span>
      </template>
      <template #cell-last_applied="{ row: p }">
        <span
          class="whitespace-nowrap text-xs text-muted-foreground"
          :title="hasRealTime(p.last_applied_at) ? formatDateTime(p.last_applied_at) : undefined"
        >{{ ago(p.last_applied_at) }}</span>
      </template>
      <template #cell-actions="{ row: p }">
        <RowMenu v-if="canAdmin" :name="policyNodeLabel(p)" :items="menuFor(p)" />
      </template>
    </DataTable>

    <ObjectSheet
      :open="!!sheet.openId.value"
      :title="openPolicyRow ? policyNodeLabel(openPolicyRow) : nodeName(sheet.openId.value ?? '')"
      :subtitle="openPolicyRow ? $t(`networking.policyPage.state.${policyState(openPolicyRow)}`) : undefined"
      :mono-subtitle="false"
      :state="sheetState"
      :error="policiesQuery.error.value ? proofReason(policiesQuery.error.value) : null"
      :page-to="sheet.openId.value ? { name: 'node-detail', params: { id: sheet.openId.value } } : undefined"
      :read-only="!canAdmin"
      :return-focus="sheet.returnFocus"
      :gone-title="$t('networking.policyPage.goneTitle')"
      :gone-description="$t('networking.policyPage.goneDescription')"
      @close="sheet.close"
    >
      <div v-if="openPolicyRow" class="space-y-5 text-sm">
        <p v-if="openPolicyRow.last_error" class="text-destructive">
          {{ $t('networking.policyPage.sheet.failed') }}
        </p>
        <pre
          v-if="openPolicyRow.last_error"
          class="whitespace-pre-wrap break-words rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 font-mono text-xs text-foreground"
        >{{ openPolicyRow.last_error }}</pre>
        <dl class="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
          <div>
            <dt class="text-xs text-muted-foreground">{{ $t('networking.policy.colLastApplied') }}</dt>
            <dd :title="hasRealTime(openPolicyRow.last_applied_at) ? formatDateTime(openPolicyRow.last_applied_at) : undefined">
              {{ ago(openPolicyRow.last_applied_at) }}
            </dd>
          </div>
          <div>
            <dt class="text-xs text-muted-foreground">{{ $t('networking.policy.colLastPlan') }}</dt>
            <dd class="font-mono text-xs">{{ openPolicyRow.last_plan_sha ? shortId(openPolicyRow.last_plan_sha, 12) : $t('networking.policyPage.sheet.neverPlanned') }}</dd>
          </div>
        </dl>

        <section class="space-y-1.5">
          <h3 class="text-xs font-medium text-muted-foreground">
            {{ $t('networking.policyPage.rulesActive', { active: activeRuleCount(openPolicyRow), total: openPolicyRow.rules.length }) }}
          </h3>
          <p v-if="openPolicyRow.rules.length === 0" class="text-xs text-muted-foreground">{{ $t('networking.policy.noRules') }}</p>
          <ol v-else class="divide-y divide-border rounded-md border border-border">
            <li
              v-for="rule in openPolicyRow.rules"
              :key="rule.id"
              :class="cn('flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-3 py-2 text-xs', rule.disabled && 'text-muted-foreground')"
            >
              <span :class="cn('font-medium', rule.action === 'allow' ? 'text-foreground' : 'text-destructive')">
                {{ $t(`networking.policyPage.action.${rule.action}`) }}
              </span>
              <span>{{ $t(`networking.policyPage.direction.${rule.direction}`) }}</span>
              <span class="font-mono">{{ rule.protocol }}{{ rule.ports?.length ? `:${rule.ports.join(',')}` : '' }}</span>
              <span class="min-w-0 break-all font-mono">{{ remoteText(rule) }}</span>
              <span v-if="rule.comment" class="text-muted-foreground">{{ rule.comment }}</span>
              <span v-if="rule.disabled" class="text-muted-foreground">{{ $t('networking.policyPage.ruleDisabled') }}</span>
            </li>
          </ol>
        </section>

        <section v-if="openEdges.length" class="space-y-1.5">
          <h3 class="text-xs font-medium text-muted-foreground">{{ $t('networking.policyPage.sheet.edges', { n: openEdges.length }, openEdges.length) }}</h3>
          <ul class="divide-y divide-border rounded-md border border-border">
            <li v-for="edge in openEdges" :key="edge.key" class="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-3 py-2 text-xs">
              <span class="text-muted-foreground">{{ edge.outbound ? $t('networking.policyPage.sheet.to') : $t('networking.policyPage.sheet.from') }}</span>
              <NodeLabel :id="edge.peer" link />
              <span class="font-mono">{{ edge.label }}</span>
              <span :class="edge.allow ? 'text-muted-foreground' : 'text-destructive'">
                {{ $t(`networking.policyPage.action.${edge.allow ? 'allow' : 'deny'}`) }}
              </span>
            </li>
          </ul>
        </section>
        <p v-else-if="graphQuery.error.value" class="text-xs text-warning-text">
          {{ $t('networking.policyPage.sheet.edgesUnread', { reason: proofReason(graphQuery.error.value) }) }}
        </p>
      </div>
      <template v-if="openPolicyRow" #actions>
        <Button variant="outline" size="sm" type="button" :disabled="planning === openPolicyRow.target_node_id" @click="plan(openPolicyRow)">
          <RefreshCw v-if="planning === openPolicyRow.target_node_id" class="animate-spin" aria-hidden="true" />
          <Play v-else aria-hidden="true" />
          {{ $t('networking.shared.plan') }}
        </Button>
        <Button variant="outline" size="sm" type="button" @click="openEdit(openPolicyRow)">
          <Pencil aria-hidden="true" />
          {{ $t('common.actions.edit') }}
        </Button>
        <RowMenu :name="policyNodeLabel(openPolicyRow)" :items="menuFor(openPolicyRow).filter((item) => item.key === 'delete')" />
      </template>
    </ObjectSheet>

    <!-- Create / edit policy dialog -->
    <Dialog :open="dialogOpen" @update:open="onDialogOpenChange">
      <DialogScrollContent class="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{{ editingId ? $t('networking.policy.editTitle') : $t('networking.policy.newTitle') }}</DialogTitle>
          <DialogDescription>
            {{ $t('networking.policy.dialogDescription') }}
          </DialogDescription>
        </DialogHeader>

        <form class="space-y-5" @submit.prevent="submit">
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div class="grid gap-2">
              <Label for="policy-node">{{ $t('networking.policy.targetNode') }}</Label>
              <Select v-model="form.target_node_id" :disabled="!!editingId">
                <SelectTrigger id="policy-node" class="w-full">
                  <SelectValue :placeholder="$t('networking.policy.selectNode')" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="node in nodes" :key="node.id" :value="node.id">
                    {{ node.name || node.id }}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div class="grid gap-2">
              <Label>{{ $t('networking.policy.policyState') }}</Label>
              <label class="flex h-9 cursor-pointer items-center gap-2 rounded-md border border-input px-3 text-sm">
                <Checkbox v-model="form.enabled" />
                {{ $t('networking.policy.enabled') }}
              </label>
            </div>
          </div>

          <div class="space-y-3">
            <div class="flex items-center justify-between">
              <Label>{{ $t('networking.policy.rules') }}</Label>
              <Button type="button" variant="outline" size="sm" @click="addRule">
                <Plus class="size-4" aria-hidden="true" />
                {{ $t('networking.policy.addRule') }}
              </Button>
            </div>

            <p v-if="form.rules.length === 0" class="rounded-md border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
              {{ $t('networking.policy.noRules') }}
            </p>

            <div
              v-for="(rule, index) in form.rules"
              :key="index"
              class="space-y-3 rounded-lg border border-border p-3"
            >
              <div class="flex items-center justify-between">
                <span class="text-xs font-medium text-muted-foreground">{{ $t('networking.policy.ruleLabel', { index: index + 1 }) }}</span>
                <Button type="button" variant="ghost" size="icon-sm" :aria-label="$t('networking.policy.removeRule')" @click="removeRule(index)">
                  <Trash2 class="size-4 text-destructive" />
                </Button>
              </div>

              <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div class="grid gap-1.5">
                  <Label class="text-xs">{{ $t('networking.policy.action') }}</Label>
                  <Select v-model="rule.action">
                    <SelectTrigger class="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="allow">allow</SelectItem>
                      <SelectItem value="deny">deny</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div class="grid gap-1.5">
                  <Label class="text-xs">{{ $t('networking.policy.direction') }}</Label>
                  <Select v-model="rule.direction">
                    <SelectTrigger class="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="egress">egress</SelectItem>
                      <SelectItem value="ingress">ingress</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div class="grid gap-1.5">
                  <Label class="text-xs">{{ $t('networking.policy.protocol') }}</Label>
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

              <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div class="grid gap-1.5">
                  <Label class="text-xs">{{ $t('networking.policy.ports') }}</Label>
                  <Input
                    v-model="rule.ports"
                    :disabled="rule.protocol === 'any'"
                    :placeholder="$t('networking.policy.portsPlaceholder')"
                  />
                </div>
                <div class="grid gap-1.5">
                  <Label class="text-xs">{{ $t('networking.policy.remoteKind') }}</Label>
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
                <Label class="text-xs">{{ $t('networking.policy.remoteNode') }}</Label>
                <Select v-model="rule.remoteNodeId">
                  <SelectTrigger class="w-full"><SelectValue :placeholder="$t('networking.policy.selectNode')" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem v-for="node in nodes" :key="node.id" :value="node.id">
                      {{ node.name || node.id }}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div v-else-if="rule.remoteKind === 'cidr'" class="grid gap-1.5">
                <Label class="text-xs">{{ $t('networking.policy.remoteCidr') }}</Label>
                <Input v-model="rule.remoteCidr" placeholder="10.0.0.0/24 or 1.2.3.4" />
              </div>
              <div v-else-if="rule.remoteKind === 'domain'" class="grid gap-1.5">
                <Label class="text-xs">{{ $t('networking.policy.remoteDomain') }}</Label>
                <Input v-model="rule.remoteDomain" placeholder="api.example.com" />
              </div>

              <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div class="grid gap-1.5">
                  <Label class="text-xs">{{ $t('networking.policy.comment') }}</Label>
                  <Input v-model="rule.comment" :placeholder="$t('networking.policy.commentPlaceholder')" />
                </div>
                <label class="flex cursor-pointer items-center gap-2 self-end pb-2 text-sm">
                  <Checkbox v-model="rule.disabled" />
                  {{ $t('networking.policy.disabled') }}
                </label>
              </div>

              <p v-if="formErrors[index]" class="text-xs text-destructive">{{ formErrors[index] }}</p>
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" @click="requestCloseDialog">{{ $t('common.actions.cancel') }}</Button>
            <Button type="submit" :disabled="!canSubmit || saving">
              <RefreshCw v-if="saving" class="size-4 animate-spin" aria-hidden="true" />
              {{ editingId ? $t('common.actions.saveChanges') : $t('networking.policy.createPolicy') }}
            </Button>
          </DialogFooter>
        </form>
      </DialogScrollContent>
    </Dialog>

    <!-- Unsaved-changes (dirty) guard -->
    <ConfirmDialog
      :open="discardConfirmOpen"
      variant="destructive"
      :title="$t('networking.policy.discardTitle')"
      :description="$t('networking.policy.discardDescription')"
      :confirm-label="$t('networking.policy.discardConfirm')"
      :cancel-label="$t('common.actions.cancel')"
      @update:open="(v) => { if (!v) discardConfirmOpen = false; }"
      @confirm="confirmDiscard"
    />

    <!-- Delete: the node keeps its ruleset (design 23, 3.8, "leaves config on a node"). -->
    <ConfirmDialog
      :open="!!deleteTarget"
      :title="$t('networking.policyPage.delete.title', { node: deleteTarget ? policyNodeLabel(deleteTarget) : '' })"
      :description="$t('networking.policyPage.delete.description')"
      :impact="deleteImpact"
      :impact-title="$t('networking.policyPage.delete.impactTitle')"
      :typed-confirm="deleteTarget ? policyNodeLabel(deleteTarget) : undefined"
      :confirm-label="$t('networking.policyPage.delete.confirm')"
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

    <!-- Group-policy cell editor (source group to dest group) -->
    <PolicyCellEditor
      v-if="cellSource && cellDest"
      :open="cellEditorOpen"
      :source="cellSource"
      :dest="cellDest"
      :direction="matrixDirection"
      :existing="cellSourcePolicy"
      :saving="savingCell"
      :can-admin="canAdmin"
      @update:open="(v) => (cellEditorOpen = v)"
      @save="saveCell"
    />

    <!-- Group-policy plan summary -->
    <Dialog :open="planResultOpen" @update:open="setPlanResultOpen">
      <DialogScrollContent class="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{{ $t('networking.matrix.planResultTitle') }}</DialogTitle>
          <DialogDescription>{{ $t('networking.matrix.planResultDescription') }}</DialogDescription>
        </DialogHeader>
        <div v-if="planResult" class="space-y-4 text-sm">
          <div class="flex flex-wrap gap-2">
            <Badge variant="success">{{ $t('networking.matrix.planAffected', { n: planResult.affected.length }) }}</Badge>
            <Badge v-if="planResult.conflicts.length" variant="warning">{{ $t('networking.matrix.planConflicts', { n: planResult.conflicts.length }) }}</Badge>
            <Badge v-if="planResult.orphaned.length" variant="secondary">{{ $t('networking.matrix.planOrphaned', { n: planResult.orphaned.length }) }}</Badge>
            <Badge v-if="planSelectorImpacts.length" variant="warning">{{ $t('networking.matrix.planSelectorImpacts', { n: planSelectorImpacts.length }) }}</Badge>
          </div>
          <div
            v-if="planSelectorImpacts.length"
            class="rounded-md border border-warning/40 bg-warning/5 p-3 text-sm text-muted-foreground"
          >
            <p class="flex items-center gap-2 font-medium text-foreground">
              <AlertTriangle class="size-4 text-warning" aria-hidden="true" />
              {{ $t('networking.matrix.selectorImpactTitle') }}
            </p>
            <p class="mt-1">{{ $t('networking.matrix.selectorImpactDescription') }}</p>
            <ul class="mt-3 space-y-2">
              <li
                v-for="impact in planSelectorImpacts"
                :key="impact.group_id"
                class="rounded-md border border-warning/30 bg-background/60 px-2 py-1.5"
              >
                <div class="flex flex-wrap items-center gap-1.5">
                  <span class="font-medium text-foreground">{{ impact.group_name || shortId(impact.group_id, 12) }}</span>
                  <Badge
                    v-for="use in impact.uses"
                    :key="use"
                    variant="outline"
                  >
                    {{ selectorUseLabel(use) }}
                  </Badge>
                  <span class="text-xs text-muted-foreground">
                    {{ $t('networking.matrix.selectorImpactDynamicMembers', { n: impact.selector_member_ids.length }) }}
                  </span>
                </div>
                <p v-if="impact.selector_member_ids.length" class="mt-1 text-xs">
                  {{ nodeNameList(impact.selector_member_ids) }}
                </p>
                <p v-else class="mt-1 text-xs">
                  {{ $t('networking.matrix.selectorImpactNoDynamicMembers') }}
                </p>
              </li>
            </ul>
            <label class="mt-3 flex cursor-pointer items-start gap-2 rounded-md border border-warning/30 bg-background/60 p-2 text-xs text-foreground">
              <Checkbox v-model="planSelectorRiskAccepted" class="mt-0.5 shrink-0" />
              <span>{{ $t('networking.matrix.selectorImpactConfirm') }}</span>
            </label>
          </div>
          <div v-if="planResult.affected.length" class="space-y-1">
            <p class="text-xs font-medium uppercase text-muted-foreground">{{ $t('networking.matrix.planAffectedNodes') }}</p>
            <ul class="space-y-1">
              <li
                v-for="a in planResult.affected"
                :key="a.approval_id"
                class="flex items-center justify-between gap-2 rounded-md border border-border px-2 py-1.5"
              >
                <span class="truncate" :title="nodeName(a.node_id)">{{ nodeName(a.node_id) }}</span>
                <span class="font-mono text-xs text-muted-foreground">{{ shortId(a.plan_sha, 10) }}</span>
              </li>
            </ul>
          </div>
          <div v-if="planResult.conflicts.length" class="space-y-1">
            <p class="text-xs font-medium uppercase text-muted-foreground">{{ $t('networking.matrix.planConflictsTitle') }}</p>
            <ul class="space-y-1">
              <li
                v-for="(c, i) in planResult.conflicts"
                :key="i"
                class="rounded-md border border-warning/40 bg-warning/5 px-2 py-1.5 text-xs"
              >
                {{ $t('networking.matrix.planConflictLine', { node: nodeName(c.node_id), reason: c.reason }) }}
              </li>
            </ul>
          </div>
          <p
            v-if="!planResult.affected.length && !planResult.conflicts.length && !planResult.orphaned.length"
            class="text-muted-foreground"
          >
            {{ $t('networking.matrix.planNoop') }}
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="setPlanResultOpen(false)">{{ $t('common.actions.close') }}</Button>
          <Button
            :disabled="!canOpenPlanApprovals"
            @click="openPlanApprovals"
          >
            {{ $t('networking.shared.goToApprovals') }}
          </Button>
        </DialogFooter>
      </DialogScrollContent>
    </Dialog>
  </div>
</template>

<script setup lang="ts">
/**
 * Outbound policy (design 32 D3; design 23, section 4.4): which outbound
 * connections each node may open. Inbound traffic is the Inbound firewall
 * (NetGuard); the header says so and links there.
 *
 * Three layers on `?view=` (outboundPolicyModel): policies, the default, is
 * every outbound policy and what it targets, one node, several nodes, node
 * groups or the whole fleet, chosen with the shared selector; a row opens
 * the policy in a sheet on `?policy=<id>`. Nodes is what each node's
 * document holds: built from outbound policies by the plan, or a manual one
 * from before selectors, which converts into an outbound policy in one
 * reviewed plan; a row opens the node on `?open=<node id>`, and the sheet
 * lists the node-to-node edges the server draws for it. Matrix is the
 * group-pair view of the policies that target node groups: a cell click
 * writes the rule for that pair. Old /network/policy links redirect here
 * with their layer translated.
 *
 * Outbound only (design 32 D3 and D7): the policy compiles outbound rules
 * into lattice_policy, so neither form offers a direction, and inbound rules
 * a policy still holds are listed as not applied, with a link to the
 * firewall that owns inbound traffic. Deleting a node's document leaves its
 * ruleset on the node (design 23, section 3.8, "leaves config on a node"):
 * the confirm names the node and what keeps running, and asks for its name.
 */
import { computed, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { toast } from "@/lib/toast";
import { AlertTriangle, ArrowRightLeft, FolderTree, Pencil, Play, Plus, RefreshCw, Trash2 } from "lucide-vue-next";
import {
  api,
  unwrap,
  type ApprovalView,
  type GroupPolicyPlanResult,
  type GroupPolicyUpsertRequest,
  type GroupPolicyView,
  type GroupView,
  type MatrixGroup,
  type NetEndpointKind,
  type NetPolicyMatrix,
  type NetPolicyUpsertRequest,
  type NetPolicyView,
  type NetRule,
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
import { approvalTitleMessage } from "@/lib/approvalKind";
import { cn } from "@/lib/utils";
import { proofReason } from "@/components/common/proofModel";
import { NETGUARD_PLUGIN_ID, pluginPagePath } from "@/views/platform/pluginsModel";
import { OUTBOUND_LAYERS, POLICY_PARAM, isNodeRestricted, outboundLock, type OutboundLayer } from "@/views/networking/outboundPolicyModel";
import { selectorParts } from "@/components/selector/selectorModel";

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
import OutboundPolicyDialog from "@/components/networking/OutboundPolicyDialog.vue";
import GroupChip from "@/components/networking/GroupChip.vue";
import RenameNote from "@/components/common/RenameNote.vue";
import PolicyCellEditor from "@/components/networking/PolicyCellEditor.vue";
import PolicyRulesEditor, { type InboundRuleLine, type PolicyRuleError } from "@/components/networking/PolicyRulesEditor.vue";
import { assignRuleIds, draftPorts, ruleFieldError, type PolicyRuleDraft, type RuleFieldError } from "@/views/networking/policyRuleModel";

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
/** A session confined to some nodes may target only nodes it administers (design 32 D1 rule). */
const restricted = computed(() => isNodeRestricted(auth.serverAllowlist));

type Layer = OutboundLayer;
const layer = useLayer<Layer>(() => OUTBOUND_LAYERS, () => "policies");

const policiesQuery = useAsyncData((signal) => api.netpolicy.list({ signal }).then((r) => unwrap(r, "policies")), {
  pollInterval: 15000,
});
const nodesQuery = useAsyncData((signal) => api.nodes.list({ signal }).then((r) => unwrap(r, "nodes")), {
  pollInterval: 0,
});
const graphQuery = useAsyncData((signal) => api.netpolicy.graph({ signal }), { immediate: false });
/** Node groups with their members, for the target selector and the target chips. */
const nodeGroupsQuery = useAsyncData((signal) => api.groups.list({ signal }), { pollInterval: 0 });
const nodeGroups = computed<GroupView[]>(() => nodeGroupsQuery.data.value?.groups ?? []);

const policies = computed(() => policiesQuery.data.value ?? []);
const nodes = computed(() => nodesQuery.data.value ?? []);
provideNodeDirectory(computed(() => nodesQuery.data.value));

// ── Reachability matrix (the overview picture) ─────────────────────────────────────
// Outbound only: the policy compiles no inbound rules, so the matrix shows none.
const matrixQuery = useAsyncData((signal) => api.netpolicy.matrix("egress", { signal }), {
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

function refreshMatrix() {
  matrixQuery.refresh();
  groupPoliciesQuery.refresh();
}

function goToGroups() {
  router.push({ name: "groups" });
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

/**
 * Other policies that reach the source group's nodes, by naming the group,
 * by naming its nodes or by covering the whole fleet, and that hold rules
 * toward the destination group. The cell edits only the source group's own
 * policy, so removing its rule may leave the path open through one of these.
 */
const cellAlsoFrom = computed<string[]>(() => {
  const source = cellSource.value;
  const dest = cellDest.value;
  if (!source || !dest) return [];
  const members = new Set(nodeGroups.value.find((g) => g.id === source.id)?.resolved_members ?? []);
  return groupPolicies.value
    .filter((p) => p.id !== cellSourcePolicy.value?.id)
    .filter((p) => (p.target?.groups ?? []).includes(source.id) || p.target_node_ids.some((id) => members.has(id)))
    .filter((p) => p.rules.some((r) => r.remote.kind === "group" && r.remote.group_id === dest.id))
    .map((p) => policyTitle(p));
});

/** A cell writes a group-targeted policy, which a token confined to some nodes may not. */
const canEditCells = computed(() => canAdmin.value && !restricted.value);

function openCellEditor(source: MatrixGroup, dest: MatrixGroup) {
  if (!canEditCells.value) return;
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

// ── Outbound policies (the default layer) ─────────────────────────────────
const policySheet = useRouteOpen(POLICY_PARAM);

const sortedGroupPolicies = computed(() =>
  [...groupPolicies.value].sort((a, b) => a.priority - b.priority || policyTitle(a).localeCompare(policyTitle(b))),
);

function targetParts(p: GroupPolicyView) {
  return selectorParts(p.target ?? {}, nodes.value, nodeGroups.value);
}

/** The target in words, for search and for the sheet subtitle. */
function targetText(p: GroupPolicyView): string {
  return targetParts(p)
    .map((part) =>
      part.kind === "fleet" ? t("selector.wholeFleetInline") : part.kind === "exclude" ? t("selector.except", { name: part.name }) : part.name,
    )
    .join(", ");
}

/**
 * The policy's name, or its target in names. The server's label describes an
 * unnamed target by node id, which is what it can say to every reader; the
 * page has the node list, so it says the names.
 */
function policyTitle(p: GroupPolicyView): string {
  const name = p.name?.trim();
  if (name) return name;
  const target = targetText(p);
  return target ? t("networking.outbound.targeting", { target }) : p.label || p.id;
}

function groupColorOf(id: string): string | undefined {
  return nodeGroups.value.find((g) => g.id === id)?.color ?? matrixGroups.value.find((g) => g.id === id)?.color;
}

function activeGroupRuleCount(p: GroupPolicyView): number {
  return p.rules.filter((r) => !r.disabled && r.direction !== "ingress").length;
}

const outboundColumns = computed<DataTableColumn<GroupPolicyView>[]>(() => [
  { key: "label", label: t("networking.outbound.colPolicy"), sortable: true, searchable: true, value: (p) => policyTitle(p) },
  { key: "target", label: t("networking.outbound.colTarget"), searchable: true, value: (p) => targetText(p) },
  { key: "reach", label: t("networking.outbound.colReach"), align: "right", sortable: true, value: (p) => p.target_node_ids?.length ?? 0 },
  { key: "rules", label: t("networking.policy.colRules"), align: "right", sortable: true, value: (p) => activeGroupRuleCount(p) },
  { key: "priority", label: t("networking.matrix.priority"), align: "right", sortable: true, value: (p) => p.priority },
  { key: "state", label: t("networking.policyPage.colState"), sortable: true, value: (p) => (p.enabled ? 0 : 1) },
  { key: "actions", label: "", class: "w-12", pin: "end" },
]);

const openOutbound = computed(() => groupPolicies.value.find((p) => p.id === policySheet.openId.value));
/** What a confined session may not do to the open policy, and why; it stays readable. */
const openOutboundLock = computed(() => (openOutbound.value ? outboundLock(openOutbound.value, restricted.value) : {}));
const outboundSheetState = computed(() => {
  if (!policySheet.openId.value) return "ready" as const;
  if (openOutbound.value) return groupPoliciesQuery.error.value ? ("stale" as const) : ("ready" as const);
  if (groupPoliciesQuery.data.value === undefined) return groupPoliciesQuery.error.value ? ("gone" as const) : ("loading" as const);
  return "gone" as const;
});

const outboundDialogOpen = ref(false);
const outboundEditing = ref<GroupPolicyView | undefined>(undefined);
const savingOutbound = ref(false);

function openOutboundCreate(): void {
  outboundEditing.value = undefined;
  outboundDialogOpen.value = true;
}

function openOutboundEdit(p: GroupPolicyView): void {
  outboundEditing.value = p;
  outboundDialogOpen.value = true;
}

async function saveOutbound(payload: GroupPolicyUpsertRequest): Promise<void> {
  savingOutbound.value = true;
  try {
    const saved = await api.groupPolicy.upsert(payload);
    toast.success(payload.id ? t("networking.outbound.toastUpdated") : t("networking.outbound.toastCreated"));
    outboundDialogOpen.value = false;
    // Read the list before opening the new policy, or its sheet flashes "gone".
    await Promise.all([groupPoliciesQuery.refresh(), matrixQuery.refresh()]);
    if (!payload.id) policySheet.open(saved.id);
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("networking.outbound.toastSaveFailed"));
  } finally {
    savingOutbound.value = false;
  }
}

const outboundDeleteTarget = ref<GroupPolicyView | undefined>(undefined);
const deletingOutbound = ref(false);

async function confirmOutboundDelete(): Promise<void> {
  const target = outboundDeleteTarget.value;
  if (!target) return;
  deletingOutbound.value = true;
  try {
    await api.groupPolicy.delete(target.id);
    toast.success(t("networking.outbound.toastDeleted"));
    outboundDeleteTarget.value = undefined;
    if (policySheet.openId.value === target.id) policySheet.close();
    refreshMatrix();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("networking.outbound.toastDeleteFailed"));
  } finally {
    deletingOutbound.value = false;
  }
}

function outboundMenu(p: GroupPolicyView): RowMenuItem[] {
  const lock = outboundLock(p, restricted.value);
  const reason = t("networking.outbound.locked.menu");
  return [
    {
      key: "edit",
      label: t("common.actions.edit"),
      icon: Pencil,
      hidden: !canAdmin.value,
      disabled: !!lock.edit,
      reason,
      run: () => openOutboundEdit(p),
    },
    {
      key: "delete",
      label: t("common.actions.delete"),
      icon: Trash2,
      danger: true,
      hidden: !canAdmin.value,
      disabled: !!lock.remove,
      reason,
      run: () => (outboundDeleteTarget.value = p),
    },
  ];
}

// ── Convert a manual node policy (design 32 D3) ───────────────────────────
const convertTarget = ref<NetPolicyView | undefined>(undefined);
const convertName = ref("");
const convertPriority = ref(0);
const converting = ref(false);
/** Why the server refused the last convert; kept in the dialog, where the operator decides what to change. */
const convertError = ref("");

/** Outbound policies that already reach the node, which merge into it once it converts. */
const convertMerges = computed(() => {
  const node = convertTarget.value?.target_node_id;
  if (!node) return [];
  return groupPolicies.value.filter((p) => p.enabled && (p.target_node_ids ?? []).includes(node));
});

function openConvert(p: NetPolicyView): void {
  convertTarget.value = p;
  convertName.value = t("networking.outbound.convertDefaultName", { node: policyNodeLabel(p) });
  convertPriority.value = 0;
  convertError.value = "";
}

async function confirmConvert(): Promise<void> {
  const target = convertTarget.value;
  if (!target) return;
  converting.value = true;
  convertError.value = "";
  try {
    const result = await api.netpolicy.convert(target.target_node_id, { name: convertName.value.trim() || undefined, priority: Math.trunc(convertPriority.value || 0) });
    convertTarget.value = undefined;
    toast.success(t("networking.outbound.toastConverted", { node: policyNodeLabel(target) }));
    // Read the lists before opening the new policy, or its sheet flashes "gone".
    await Promise.all([groupPoliciesQuery.refresh(), policiesQuery.refresh(), matrixQuery.refresh()]);
    owned.push({ ...owned.query(), view: undefined, open: undefined, [POLICY_PARAM]: result.group_policy.id });
    if (result.approval) await showPlan(result.approval);
  } catch (error) {
    convertError.value = error instanceof Error ? error.message : t("networking.outbound.toastConvertFailed");
  } finally {
    converting.value = false;
  }
}

/**
 * Show a plan the server already created. The digest is a separate step: a
 * failure to compute it must not read as a failure of what made the plan.
 */
async function showPlan(approval: ApprovalView): Promise<void> {
  planApproval.value = approval;
  try {
    planSha.value = await planDigest.digestFor(approval);
  } catch {
    planSha.value = "";
  }
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
  { key: "source", label: t("networking.outbound.colSource"), sortable: true, value: (p) => (p.group_derived ? 1 : 0) },
  { key: "state", label: t("networking.policyPage.colState"), sortable: true, value: (p) => policyStateOrder(p) },
  { key: "rules", label: t("networking.policy.colRules"), align: "right", sortable: true, value: (p) => p.rules.length },
  { key: "last_applied", label: t("networking.policy.colLastApplied"), sortable: true, value: (p) => (hasRealTime(p.last_applied_at) ? p.last_applied_at : "") },
  { key: "actions", label: "", class: "w-12", pin: "end" },
]);

/* ------------------------------------------------------------------ */
/* Policy state                                                        */
/* ------------------------------------------------------------------ */

type PolicyState = "failing" | "blocked" | "unapplied" | "applied" | "disabled";

/** An inbound rule makes the policy's own plan fail ("egress-only MVP"). */
function holdsInbound(p: NetPolicyView): boolean {
  return p.rules.some((r) => r.direction === "ingress");
}

/** An enabled policy its inbound rules keep from being planned, whatever else is wrong with it. */
function heldByInbound(p: NetPolicyView): boolean {
  return p.enabled && holdsInbound(p);
}

/**
 * What a node's policy amounts to on the node. A failed apply is the only
 * red; an enabled policy holding inbound rules cannot be planned at all; an
 * enabled policy that never applied is not enforced yet; a disabled one is
 * the operator's choice and stays quiet.
 */
function policyState(p: NetPolicyView): PolicyState {
  if (p.last_error) return "failing";
  if (!p.enabled) return "disabled";
  if (holdsInbound(p)) return "blocked";
  return hasRealTime(p.last_applied_at) ? "applied" : "unapplied";
}

const STATE_ORDER: Record<PolicyState, number> = { failing: 0, blocked: 1, unapplied: 2, applied: 3, disabled: 4 };
const STATE_TONE: Record<PolicyState, string> = {
  failing: "text-destructive",
  blocked: "text-warning-text",
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
  const out = { failing: 0, blocked: 0, unapplied: 0, applied: 0, disabled: 0 };
  for (const p of policies.value) {
    const state = policyState(p);
    out[state] += 1;
    // A failed policy that also holds inbound rules is held up by them too;
    // its state shows the failure, the count shows both.
    if (state === "failing" && heldByInbound(p)) out.blocked += 1;
  }
  return out;
});

/* ------------------------------------------------------------------ */
/* Head: proof line and attention                                      */
/* ------------------------------------------------------------------ */

const proof = useProof(policiesQuery);

const proofSegments = computed<ProofSegment[]>(() => {
  const parts: ProofSegment[] = [];
  if (groupPoliciesQuery.data.value !== undefined) {
    parts.push({ key: "outbound", text: t("networking.outbound.proof.policies", { n: groupPolicies.value.length }, groupPolicies.value.length), to: { query: {} } });
  }
  const n = policies.value.length;
  parts.push({ key: "policies", text: t("networking.outbound.proof.nodes", { n }, n), to: { query: { view: "nodes" } } });
  const manual = policies.value.filter((p) => !p.group_derived).length;
  if (manual) parts.push({ key: "manual", text: t("networking.outbound.proof.manual", { n: manual }, manual), to: { query: { view: "nodes" } } });
  const c = counts.value;
  if (c.applied) parts.push({ key: "applied", text: t("networking.policyPage.proof.applied", { n: c.applied }) });
  if (c.unapplied) parts.push({ key: "unapplied", text: t("networking.policyPage.proof.unapplied", { n: c.unapplied }), tone: "warning" });
  if (c.failing) parts.push({ key: "failing", text: t("networking.policyPage.proof.failing", { n: c.failing }), tone: "destructive" });
  if (c.blocked) parts.push({ key: "blocked", text: t("networking.policyPage.proof.blocked", { n: c.blocked }), tone: "warning" });
  return parts;
});

function refreshAll(): void {
  void policiesQuery.refresh();
  void matrixQuery.refresh();
  void groupPoliciesQuery.refresh();
  void nodesQuery.refresh();
  void nodeGroupsQuery.refresh();
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
  if (layer.value === "nodes") {
    sheet.open(p.target_node_id);
    return;
  }
  owned.push({ ...owned.query(), view: "nodes", open: p.target_node_id, [POLICY_PARAM]: undefined });
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
    }
    if (state === "blocked" || (state === "failing" && heldByInbound(p))) {
      items.push({
        key: `blocked:${p.target_node_id}`,
        tone: "warning",
        claim: t("networking.policyPage.attention.blockedClaim", { node: policyNodeLabel(p) }),
        proof: t("networking.policyPage.attention.blockedProof"),
        action: p.group_derived ? action : { label: t("common.actions.edit"), run: () => openEdit(p) },
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
  {
    value: "policies",
    label: t("networking.outbound.layers.policies"),
    count: groupPoliciesQuery.data.value !== undefined ? groupPolicies.value.length : undefined,
  },
  {
    value: "nodes",
    label: t("networking.outbound.layers.nodes"),
    count: policiesQuery.data.value !== undefined ? policies.value.length : undefined,
  },
  { value: "matrix", label: t("networking.outbound.layers.matrix") },
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

/** The enabled outbound policies that reach the open node, in the order they merge. */
const openNodeSources = computed(() => {
  const node = sheet.openId.value;
  if (!node) return [];
  return sortedGroupPolicies.value.filter((p) => p.enabled && (p.target_node_ids ?? []).includes(node));
});

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
  return nodeGroups.value.find((g) => g.id === id)?.name ?? matrixGroups.value.find((g) => g.id === id)?.name ?? id;
}

/**
 * A manual document plans, edits and converts on its own; a document built
 * from outbound policies changes through those policies and their plan, so
 * it offers neither edit nor a plan of its own.
 */
function menuFor(p: NetPolicyView): RowMenuItem[] {
  return [
    {
      key: "plan",
      label: t("networking.shared.plan"),
      icon: Play,
      hidden: !canAdmin.value || !!p.group_derived,
      disabled: planning.value === p.target_node_id || holdsInbound(p),
      reason: holdsInbound(p) ? t("networking.policyPage.planBlocked") : undefined,
      run: () => void plan(p),
    },
    {
      key: "convert",
      label: t("networking.outbound.convert"),
      icon: ArrowRightLeft,
      hidden: !canAdmin.value || !!p.group_derived,
      run: () => openConvert(p),
    },
    { key: "edit", label: t("common.actions.edit"), icon: Pencil, hidden: !canAdmin.value || !!p.group_derived, run: () => openEdit(p) },
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
interface RuleDraft extends PolicyRuleDraft {
  remoteKind: NetEndpointKind;
  remoteNodeId: string;
  remoteCidr: string;
  remoteDomain: string;
  /** The remote as loaded, saved back unchanged for a kind this form does not edit. */
  remoteLoaded?: NetRule["remote"];
}

/** The remote kinds the node form edits; any other loaded kind is kept as it was. */
const EDITABLE_REMOTE_KINDS: readonly NetEndpointKind[] = ["node", "cidr", "domain", "any"];

function editsRemote(kind: NetEndpointKind): boolean {
  return EDITABLE_REMOTE_KINDS.includes(kind);
}

function emptyRule(): RuleDraft {
  return {
    action: "allow",
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
    id: rule.id,
    action: rule.action,
    protocol: rule.protocol,
    ports: (rule.ports ?? []).join(", "),
    remoteKind: rule.remote.kind,
    remoteNodeId: rule.remote.node_id ?? "",
    remoteCidr: rule.remote.cidr ?? "",
    remoteDomain: rule.remote.domain ?? "",
    remoteLoaded: rule.remote,
    comment: rule.comment ?? "",
    disabled: !!rule.disabled,
  };
}

/** The sentence for a ports problem, shared wording with the matrix editor. */
function fieldErrorText(error: RuleFieldError): string {
  if (error.key === "errAnyNoPorts") return t("networking.policy.errAnyNoPorts");
  return t(`networking.policy.${error.key}`, { token: error.token });
}

/** One line for an inbound rule the form keeps but cannot apply. */
function inboundRuleText(rule: NetRule): string {
  const ports = rule.ports?.length ? `:${rule.ports.join(",")}` : "";
  return `${rule.action} ${rule.protocol}${ports} ${t("networking.policyPage.direction.ingress")} ${remoteText(rule)}`;
}

// ── Create / edit dialog ──────────────────────────────────────────────────
const dialogOpen = ref(false);
const editingId = ref<string | undefined>(undefined);
const saving = ref(false);
const form = reactive<{ target_node_id: string; enabled: boolean; rules: RuleDraft[]; inbound: NetRule[] }>({
  target_node_id: "",
  enabled: true,
  rules: [],
  inbound: [],
});

// Snapshot of the form at open time, drives the unsaved-changes (dirty) guard.
const formSnapshot = ref("");
function snapshotForm(): string {
  return JSON.stringify({
    target_node_id: form.target_node_id,
    enabled: form.enabled,
    rules: form.rules,
    inbound: form.inbound.map((r) => r.id),
  });
}
const isDirty = computed(() => dialogOpen.value && snapshotForm() !== formSnapshot.value);
// Confirm dialog shown when the operator tries to discard unsaved edits.
const discardConfirmOpen = ref(false);

function openEdit(p: NetPolicyView) {
  editingId.value = p.target_node_id;
  form.target_node_id = p.target_node_id;
  form.enabled = p.enabled;
  const outbound = p.rules.filter((r) => r.direction !== "ingress");
  form.rules = p.rules.length === 0 ? [emptyRule()] : outbound.map(ruleToDraft);
  form.inbound = p.rules.filter((r) => r.direction === "ingress");
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

function removeInbound(key: string) {
  form.inbound = form.inbound.filter((r) => r.id !== key);
}

const inboundLines = computed<InboundRuleLine[]>(() => form.inbound.map((r) => ({ key: r.id, text: inboundRuleText(r) })));

/** A ports token that is not one port is an error, never an empty list (all ports). */
function ruleError(draft: RuleDraft): PolicyRuleError | undefined {
  const field = ruleFieldError(draft);
  if (field) return { text: fieldErrorText(field), ports: true };
  if (draft.remoteKind === "node" && !draft.remoteNodeId) return { text: t("networking.policy.errSelectNode") };
  if (draft.remoteKind === "cidr" && !draft.remoteCidr.trim()) return { text: t("networking.policy.errEnterCidr") };
  if (draft.remoteKind === "domain" && !draft.remoteDomain.trim()) return { text: t("networking.policy.errEnterDomain") };
  return undefined;
}

const formErrors = computed(() => form.rules.map(ruleError));
const hasRuleErrors = computed(() => formErrors.value.some((e) => e !== undefined));
const canSubmit = computed(
  () => canAdmin.value && !!form.target_node_id && !hasRuleErrors.value,
);

function draftToRule(draft: RuleDraft, id: string): NetRule {
  return {
    id,
    action: draft.action,
    direction: "egress",
    protocol: draft.protocol,
    ports: draftPorts(draft),
    remote:
      !editsRemote(draft.remoteKind) && draft.remoteLoaded
        ? { ...draft.remoteLoaded }
        : {
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
    // Inbound rules are kept as they were: dropping them on save would lose
    // data the operator never saw edited. They stay listed until removed.
    const ids = assignRuleIds(form.rules, form.inbound.map((r) => r.id), "rule");
    const body: NetPolicyUpsertRequest = {
      target_node_id: form.target_node_id,
      enabled: form.enabled,
      rules: [...form.rules.map((draft, i) => draftToRule(draft, ids[i]!)), ...form.inbound],
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
    { label: t(`common.status.${a.status}`), variant: "warning" as const },
    { label: t(approvalTitleMessage(a).key, approvalTitleMessage(a).params), variant: "outline" as const },
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
    <PageHeader :title="$t('nav.items.network-outbound-policy')">
      <template #description>
        <p class="text-sm text-muted-foreground">
          {{ $t('networking.outbound.description') }}
          <template v-if="netguardTo">
            {{ $t('networking.outbound.inboundOwner') }}
            <RouterLink :to="netguardTo" class="whitespace-nowrap text-primary underline-offset-4 hover:underline">{{ $t('networking.outbound.openInbound') }}</RouterLink>
          </template>
          <template v-else>{{ $t('networking.outbound.inboundOwnerNoPlugin') }}</template>
        </p>
        <ProofLine v-bind="proof" :segments="proofSegments" @retry="refreshAll" />
      </template>
      <template #actions>
        <Button variant="outline" size="sm" :disabled="policiesQuery.refreshing.value" @click="refreshAll">
          <RefreshCw :class="cn('size-4', policiesQuery.refreshing.value && 'animate-spin')" aria-hidden="true" />
          {{ $t('common.actions.refresh') }}
        </Button>
        <Button
          v-if="layer !== 'nodes' && canAdmin && hasGroupPolicies"
          variant="outline"
          size="sm"
          :disabled="planningGroups"
          @click="planGroupPolicies"
        >
          <RefreshCw v-if="planningGroups" class="size-4 animate-spin" aria-hidden="true" />
          <Play v-else class="size-4" aria-hidden="true" />
          {{ $t('networking.outbound.planAll') }}
        </Button>
        <Button v-if="layer === 'policies' && canAdmin" size="sm" @click="openOutboundCreate">
          <Plus class="size-4" aria-hidden="true" />
          {{ $t('networking.outbound.newPolicy') }}
        </Button>
      </template>
    </PageHeader>

    <RenameNote id="outboundPolicy" />

    <LayerTabs v-model="layer" :tabs="layerTabs" :label="$t('networking.outbound.layersLabel')" />

    <AttentionList :items="attention" />

    <!-- Policies: every outbound policy and what it targets; a row opens it in the sheet. -->
    <DataTable
      v-if="layer === 'policies'"
      state-key="outbound"
      :columns="outboundColumns"
      :rows="sortedGroupPolicies"
      :row-key="(p) => p.id"
      :loading="groupPoliciesQuery.loading.value"
      :error="groupPoliciesQuery.error.value"
      :has-data="groupPoliciesQuery.data.value !== undefined"
      searchable
      :expression-filter="false"
      :search-placeholder="$t('networking.outbound.searchPlaceholder')"
      :row-click="(p, el) => policySheet.open(p.id, el)"
      :active-row-id="policySheet.openId.value"
      :show-summary="false"
      :empty-title="$t('networking.outbound.emptyTitle')"
      :empty-description="$t('networking.outbound.emptyDescription')"
      :no-match-title="$t('networking.shared.noMatchTitle')"
      :no-match-description="$t('networking.shared.noMatchDescription')"
      @retry="refreshAll"
    >
      <template #no-match>
        <EmptyState :title="$t('networking.shared.noMatchTitle')" :description="$t('networking.shared.noMatchDescription')" />
      </template>
      <template #empty>
        <EmptyState :title="$t('networking.outbound.emptyTitle')" :description="$t('networking.outbound.emptyDescription')">
          <Button v-if="canAdmin" size="sm" type="button" @click="openOutboundCreate">
            <Plus aria-hidden="true" />
            {{ $t('networking.outbound.newPolicy') }}
          </Button>
        </EmptyState>
      </template>
      <template #cell-label="{ row: p }">
        <span :class="cn('font-medium', !p.name && 'text-muted-foreground')">{{ policyTitle(p) }}</span>
      </template>
      <template #cell-target="{ row: p }">
        <span class="flex max-w-md flex-wrap items-center gap-1">
          <template v-for="part in targetParts(p).slice(0, 4)" :key="`${part.kind}:${'id' in part ? part.id : ''}`">
            <GroupChip v-if="part.kind === 'group'" :name="part.name" :color="groupColorOf(part.id)" pill />
            <span v-else :class="cn('rounded-full border px-2 py-0.5 text-xs', part.kind === 'exclude' ? 'border-dashed text-muted-foreground' : 'border-border')">
              {{ part.kind === 'fleet' ? $t('selector.wholeFleet') : part.kind === 'exclude' ? $t('selector.except', { name: part.name }) : part.name }}
            </span>
          </template>
          <span v-if="targetParts(p).length > 4" class="text-xs text-muted-foreground">+{{ targetParts(p).length - 4 }}</span>
        </span>
      </template>
      <template #cell-reach="{ row: p }">
        <span :class="cn('whitespace-nowrap text-xs tabular-nums', (p.target_node_ids?.length ?? 0) === 0 && 'text-warning-text')">
          {{ $t('networking.outbound.reach', { n: p.target_node_ids?.length ?? 0 }, p.target_node_ids?.length ?? 0) }}
        </span>
      </template>
      <template #cell-rules="{ row: p }">
        <span class="font-mono text-xs tabular-nums">{{ activeGroupRuleCount(p) }}</span>
      </template>
      <template #cell-priority="{ row: p }">
        <span class="font-mono text-xs tabular-nums">{{ p.priority }}</span>
      </template>
      <template #cell-state="{ row: p }">
        <span :class="cn('whitespace-nowrap text-xs', p.enabled ? 'text-foreground' : 'text-muted-foreground')">
          {{ p.enabled ? $t('networking.outbound.enabled') : $t('networking.policyPage.state.disabled') }}
        </span>
      </template>
      <template #cell-actions="{ row: p }">
        <RowMenu v-if="canAdmin" :name="policyTitle(p)" :items="outboundMenu(p)" />
      </template>
    </DataTable>

    <!-- Matrix: the group-pair view of the policies that target node groups; a cell click writes the rule for that pair. -->
    <section v-else-if="layer === 'matrix'" class="space-y-3" aria-labelledby="policy-matrix-heading">
      <div class="space-y-0.5">
        <h2 id="policy-matrix-heading" class="text-sm font-medium">{{ $t('networking.matrix.title') }}</h2>
        <p class="text-xs text-muted-foreground">
          {{
            canEditCells && hasGroups
              ? $t('networking.policyPage.matrixHintAdmin')
              : canAdmin && restricted
                ? $t('networking.outbound.locked.matrix')
                : $t('networking.matrix.description')
          }}
          {{ $t('networking.outbound.matrixScope') }}
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
            :can-admin="canEditCells"
            @edit="openCellEditor"
          />
          <p v-if="matrix && !hasGroupPolicies" class="text-xs text-muted-foreground">
            {{ $t('networking.policyPage.noGroupPolicies') }}
          </p>
        </div>
      </DataState>
    </section>

    <!-- Nodes: what each node's document holds; a row opens the node in the sheet. -->
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
      <template #no-match>
        <EmptyState :title="$t('networking.shared.noMatchTitle')" :description="$t('networking.shared.noMatchDescription')" />
      </template>
      <template #empty>
        <EmptyState
          :title="$t('networking.policy.emptyTitle')"
          :description="canRead ? $t('networking.policy.emptyWithRead') : $t('networking.policy.emptyNeedRead')"
        >
          <Button v-if="canAdmin" size="sm" type="button" @click="openOutboundCreate">
            <Plus aria-hidden="true" />
            {{ $t('networking.outbound.newPolicy') }}
          </Button>
        </EmptyState>
      </template>
      <template #cell-target="{ row: p }">
        <NodeLabel :id="p.target_node_id" class="font-medium" />
      </template>
      <template #cell-source="{ row: p }">
        <span :class="cn('whitespace-nowrap text-xs', p.group_derived ? 'text-muted-foreground' : 'text-foreground')">
          {{ p.group_derived ? $t('networking.outbound.sourceDerived') : $t('networking.outbound.sourceManual') }}
        </span>
      </template>
      <template #cell-state="{ row: p }">
        <span :class="cn('whitespace-nowrap text-xs', STATE_TONE[policyState(p)])">
          {{ $t(`networking.policyPage.state.${policyState(p)}`) }}
        </span>
        <span v-if="policyState(p) === 'failing' && heldByInbound(p)" class="ml-1 whitespace-nowrap text-xs text-warning-text">
          · {{ $t('networking.policyPage.state.blocked') }}
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

        <section v-if="openPolicyRow.group_derived" class="space-y-1.5" data-testid="node-policy-source">
          <h3 class="text-xs font-medium text-muted-foreground">{{ $t('networking.outbound.builtFrom') }}</h3>
          <ul v-if="openNodeSources.length" class="divide-y divide-border rounded-md border border-border">
            <li v-for="source in openNodeSources" :key="source.id">
              <RouterLink
                :to="{ query: { [POLICY_PARAM]: source.id } }"
                class="flex items-center gap-2 px-3 py-2 text-xs outline-none hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring pointer-coarse:min-h-11"
              >
                <span class="min-w-0 flex-1 truncate font-medium text-foreground">{{ policyTitle(source) }}</span>
                <span class="shrink-0 text-muted-foreground">{{ $t('networking.outbound.priorityN', { n: source.priority }) }}</span>
              </RouterLink>
            </li>
          </ul>
          <p v-else class="text-xs text-warning-text">{{ $t('networking.outbound.orphaned') }}</p>
        </section>
        <section v-else class="space-y-1.5 rounded-md border border-border px-3 py-2.5" data-testid="node-policy-source">
          <p class="text-xs text-foreground">{{ $t('networking.outbound.manualExplain') }}</p>
          <Button v-if="canAdmin" variant="outline" size="sm" type="button" @click="openConvert(openPolicyRow)">
            <ArrowRightLeft aria-hidden="true" />
            {{ $t('networking.outbound.convert') }}
          </Button>
        </section>

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
              <span v-if="rule.direction === 'ingress'" class="text-warning-text">{{ $t('networking.policyPage.ruleInboundInactive') }}</span>
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
        <Button
          v-if="!openPolicyRow.group_derived"
          variant="outline"
          size="sm"
          type="button"
          :disabled="planning === openPolicyRow.target_node_id || holdsInbound(openPolicyRow)"
          :title="holdsInbound(openPolicyRow) ? $t('networking.policyPage.planBlocked') : undefined"
          @click="plan(openPolicyRow)"
        >
          <RefreshCw v-if="planning === openPolicyRow.target_node_id" class="animate-spin" aria-hidden="true" />
          <Play v-else aria-hidden="true" />
          {{ $t('networking.shared.plan') }}
        </Button>
        <Button v-if="!openPolicyRow.group_derived" variant="outline" size="sm" type="button" @click="openEdit(openPolicyRow)">
          <Pencil aria-hidden="true" />
          {{ $t('common.actions.edit') }}
        </Button>
        <RowMenu :name="policyNodeLabel(openPolicyRow)" :items="menuFor(openPolicyRow).filter((item) => item.key === 'delete')" />
      </template>
    </ObjectSheet>

    <!-- One outbound policy: its target, the nodes it reaches now, its rules. -->
    <ObjectSheet
      :open="!!policySheet.openId.value"
      :title="openOutbound ? policyTitle(openOutbound) : $t('networking.outbound.sheetTitle')"
      :subtitle="openOutbound ? $t('networking.outbound.sheetSubtitle', { priority: openOutbound.priority }) : undefined"
      :mono-subtitle="false"
      :state="outboundSheetState"
      :error="groupPoliciesQuery.error.value ? proofReason(groupPoliciesQuery.error.value) : null"
      :read-only="!canAdmin"
      :return-focus="policySheet.returnFocus"
      :gone-title="$t('networking.outbound.goneTitle')"
      :gone-description="$t('networking.outbound.goneDescription')"
      @close="policySheet.close"
    >
      <div v-if="openOutbound" class="space-y-5 text-sm" data-testid="outbound-sheet">
        <p v-if="!openOutbound.enabled" class="text-muted-foreground">{{ $t('networking.outbound.disabledExplain') }}</p>
        <section class="space-y-1.5">
          <h3 class="text-xs font-medium text-muted-foreground">{{ $t('networking.outbound.target') }}</h3>
          <p class="flex flex-wrap items-center gap-1">
            <template v-for="part in targetParts(openOutbound)" :key="`${part.kind}:${'id' in part ? part.id : ''}`">
              <GroupChip v-if="part.kind === 'group'" :name="part.name" :color="groupColorOf(part.id)" pill />
              <span v-else :class="cn('rounded-full border px-2 py-0.5 text-xs', part.kind === 'exclude' ? 'border-dashed text-muted-foreground' : 'border-border')">
                {{ part.kind === 'fleet' ? $t('selector.wholeFleet') : part.kind === 'exclude' ? $t('selector.except', { name: part.name }) : part.name }}
              </span>
            </template>
            <span v-if="openOutbound.hidden_target_nodes" class="text-xs text-muted-foreground">
              {{ $t('networking.outbound.hiddenTargetNodes', { n: openOutbound.hidden_target_nodes }, openOutbound.hidden_target_nodes) }}
            </span>
          </p>
        </section>
        <section class="space-y-1.5">
          <h3 class="text-xs font-medium text-muted-foreground">
            {{ $t('networking.outbound.reachesNow', { n: openOutbound.target_node_ids?.length ?? 0 }, openOutbound.target_node_ids?.length ?? 0) }}
          </h3>
          <ul v-if="openOutbound.target_node_ids?.length" class="flex flex-wrap gap-x-3 gap-y-1 rounded-md border border-border px-3 py-2 text-xs">
            <li v-for="id in openOutbound.target_node_ids" :key="id" class="max-w-full truncate"><NodeLabel :id="id" link /></li>
          </ul>
          <p v-else class="text-xs text-warning-text">{{ $t('networking.outbound.reachesNone') }}</p>
        </section>
        <section class="space-y-1.5">
          <h3 class="text-xs font-medium text-muted-foreground">
            {{ $t('networking.policyPage.rulesActive', { active: activeGroupRuleCount(openOutbound), total: openOutbound.rules.length }) }}
          </h3>
          <p v-if="openOutbound.rules.length === 0" class="text-xs text-muted-foreground">{{ $t('networking.policy.noRules') }}</p>
          <ol v-else class="divide-y divide-border rounded-md border border-border">
            <li
              v-for="rule in openOutbound.rules"
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
              <span v-if="rule.direction === 'ingress'" class="text-warning-text">{{ $t('networking.policyPage.ruleInboundInactive') }}</span>
            </li>
          </ol>
        </section>
        <p v-if="canAdmin && (openOutboundLock.edit || openOutboundLock.remove)" class="text-xs text-muted-foreground" data-testid="outbound-locked">
          {{ $t(`networking.outbound.locked.${openOutboundLock.edit ?? openOutboundLock.remove}`) }}
        </p>
        <p class="text-xs text-muted-foreground">{{ $t('networking.outbound.planHint') }}</p>
      </div>
      <template v-if="openOutbound && canAdmin" #actions>
        <Button variant="outline" size="sm" type="button" :disabled="!!openOutboundLock.edit" @click="openOutboundEdit(openOutbound)">
          <Pencil aria-hidden="true" />
          {{ $t('common.actions.edit') }}
        </Button>
        <Button variant="outline" size="sm" type="button" :disabled="planningGroups" @click="planGroupPolicies">
          <RefreshCw v-if="planningGroups" class="animate-spin" aria-hidden="true" />
          <Play v-else aria-hidden="true" />
          {{ $t('networking.outbound.planAll') }}
        </Button>
        <RowMenu :name="policyTitle(openOutbound)" :items="outboundMenu(openOutbound).filter((item) => item.key === 'delete')" />
      </template>
    </ObjectSheet>

    <OutboundPolicyDialog
      :open="outboundDialogOpen"
      :existing="outboundEditing"
      :nodes="nodes"
      :groups="nodeGroups"
      :saving="savingOutbound"
      :can-admin="canAdmin"
      :restricted="restricted"
      :firewall-to="netguardTo"
      @update:open="(v) => (outboundDialogOpen = v)"
      @save="saveOutbound"
    />

    <!-- Deleting a definition sends nothing to a node: its nodes keep what they applied until the next plan. -->
    <ConfirmDialog
      :open="!!outboundDeleteTarget"
      :title="$t('networking.outbound.delete.title', { name: outboundDeleteTarget ? policyTitle(outboundDeleteTarget) : '' })"
      :description="$t('networking.outbound.delete.description')"
      :impact="outboundDeleteTarget ? [$t('networking.outbound.delete.impactNodes', { n: outboundDeleteTarget.target_node_ids?.length ?? 0 }, outboundDeleteTarget.target_node_ids?.length ?? 0), $t('networking.outbound.delete.impactPlan')] : []"
      :impact-title="$t('networking.policyPage.delete.impactTitle')"
      :confirm-label="$t('networking.outbound.delete.confirm')"
      :cancel-label="$t('common.actions.cancel')"
      :pending="deletingOutbound"
      @update:open="(v) => { if (!v) outboundDeleteTarget = undefined; }"
      @confirm="confirmOutboundDelete"
    />

    <!-- Convert a manual node policy into an outbound policy targeting that node, in one reviewed plan. -->
    <Dialog :open="!!convertTarget" @update:open="(v) => { if (!v) convertTarget = undefined; }">
      <DialogScrollContent class="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{{ $t('networking.outbound.convertTitle', { node: convertTarget ? policyNodeLabel(convertTarget) : '' }) }}</DialogTitle>
          <DialogDescription>{{ $t('networking.outbound.convertDescription') }}</DialogDescription>
        </DialogHeader>
        <form class="space-y-4 text-sm" @submit.prevent="confirmConvert">
          <ul class="list-disc space-y-1 ps-5 text-muted-foreground">
            <li>{{ $t('networking.outbound.convertKeeps', { n: convertTarget?.rules.length ?? 0 }, convertTarget?.rules.length ?? 0) }}</li>
            <li v-if="convertTarget?.enabled">{{ $t('networking.outbound.convertPlans') }}</li>
            <li v-else>{{ $t('networking.outbound.convertDisabled') }}</li>
            <li v-if="convertMerges.length" class="text-warning-text">
              {{ $t('networking.outbound.convertMerges', { policies: convertMerges.map((p) => policyTitle(p)).join(', ') }) }}
            </li>
            <li v-if="convertTarget && holdsInbound(convertTarget)" class="text-warning-text">{{ $t('networking.outbound.convertInbound') }}</li>
          </ul>
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_7rem]">
            <div class="grid gap-1.5">
              <Label for="convert-name">{{ $t('networking.outbound.name') }}</Label>
              <Input id="convert-name" v-model="convertName" maxlength="120" />
            </div>
            <div class="grid gap-1.5">
              <Label for="convert-priority">{{ $t('networking.matrix.priority') }}</Label>
              <Input id="convert-priority" v-model.number="convertPriority" type="number" inputmode="numeric" aria-describedby="convert-priority-hint" />
              <p id="convert-priority-hint" class="text-xs text-muted-foreground">{{ $t('networking.outbound.priorityHint') }}</p>
            </div>
          </div>
          <p v-if="convertError" class="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-foreground" role="alert">
            {{ convertError }}
          </p>
          <DialogFooter>
            <Button type="button" variant="outline" @click="convertTarget = undefined">{{ $t('common.actions.cancel') }}</Button>
            <Button type="submit" :disabled="converting || !canAdmin">
              <RefreshCw v-if="converting" class="size-4 animate-spin" aria-hidden="true" />
              {{ $t('networking.outbound.convertConfirm') }}
            </Button>
          </DialogFooter>
        </form>
      </DialogScrollContent>
    </Dialog>

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

          <PolicyRulesEditor
            :rules="form.rules"
            :errors="formErrors"
            :inbound="inboundLines"
            :firewall-to="netguardTo"
            :empty-text="$t('networking.policy.noRules')"
            id-prefix="policy"
            @add="addRule"
            @remove="removeRule"
            @remove-inbound="removeInbound"
          >
            <!-- The slot hands back the shared draft type; index reaches the full node draft. -->
            <template #remote="{ index }">
              <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div class="grid gap-1.5">
                  <Label class="text-xs" :for="`policy-rule-${index}-remote`">{{ $t('networking.policy.remoteKind') }}</Label>
                  <Select v-model="form.rules[index]!.remoteKind">
                    <SelectTrigger :id="`policy-rule-${index}-remote`" class="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="node">node</SelectItem>
                      <SelectItem value="cidr">cidr</SelectItem>
                      <SelectItem value="domain">domain</SelectItem>
                      <SelectItem value="any">any</SelectItem>
                      <SelectItem v-if="!editsRemote(form.rules[index]!.remoteKind)" :value="form.rules[index]!.remoteKind" disabled>
                        {{ $t('networking.policy.remoteKept', { kind: form.rules[index]!.remoteKind }) }}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div v-if="form.rules[index]!.remoteKind === 'node'" class="grid gap-1.5">
                  <Label class="text-xs" :for="`policy-rule-${index}-node`">{{ $t('networking.policy.remoteNode') }}</Label>
                  <Select v-model="form.rules[index]!.remoteNodeId">
                    <SelectTrigger :id="`policy-rule-${index}-node`" class="w-full"><SelectValue :placeholder="$t('networking.policy.selectNode')" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem v-for="node in nodes" :key="node.id" :value="node.id">
                        {{ node.name || node.id }}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div v-else-if="form.rules[index]!.remoteKind === 'cidr'" class="grid gap-1.5">
                  <Label class="text-xs" :for="`policy-rule-${index}-cidr`">{{ $t('networking.policy.remoteCidr') }}</Label>
                  <Input :id="`policy-rule-${index}-cidr`" v-model="form.rules[index]!.remoteCidr" placeholder="10.0.0.0/24 or 1.2.3.4" />
                </div>
                <div v-else-if="form.rules[index]!.remoteKind === 'domain'" class="grid gap-1.5">
                  <Label class="text-xs" :for="`policy-rule-${index}-domain`">{{ $t('networking.policy.remoteDomain') }}</Label>
                  <Input :id="`policy-rule-${index}-domain`" v-model="form.rules[index]!.remoteDomain" placeholder="api.example.com" />
                </div>
              </div>
            </template>
          </PolicyRulesEditor>

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
      :existing="cellSourcePolicy"
      :existing-title="cellSourcePolicy ? policyTitle(cellSourcePolicy) : undefined"
      :firewall-to="netguardTo"
      :also-from="cellAlsoFrom"
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

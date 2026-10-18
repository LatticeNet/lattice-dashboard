<script setup lang="ts">
/**
 * Agent updates, Mirrors layer (design 31 D4, slice S5): the registry of
 * download mirrors, what the nodes' last downloads say about each, the
 * registry plans waiting for review, and the order of sources every node
 * would download from.
 *
 * Every change to the registry is a reviewed agent.mirrors plan, because a
 * mirror steers which host every listed node contacts. Add, change, enable
 * or disable, and delete each file a plan, show it at once (the diff and
 * every node whose order changes), and hand the decision to Approvals; the
 * registry on this page changes only when that plan is approved. Delete
 * confirms first, like every delete in the console, and names how many nodes
 * list the mirror now. A mirror with a plan waiting says so in its row, its
 * attention item links to that plan, and filing a second plan for it asks
 * first: approving either would make the other stale.
 *
 * Changing the registry needs node:admin and network:plan over the whole
 * fleet. A session without them, or confined to some nodes, reads the
 * registry and the order of the nodes it may read, and is told why the
 * controls are not there.
 *
 * The order preview groups nodes whose order is identical into one row, so a
 * fleet of a hundred nodes on a few mirrors reads as a handful of rows; a
 * filter finds a node, or every row that lists a mirror, by id or name.
 */
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink } from "vue-router";
import { AlertTriangle, FileCode2, Pencil, Plus, Power, PowerOff, RefreshCw, Search, Trash2 } from "lucide-vue-next";

import {
  api,
  unwrap,
  type AgentMirror,
  type AgentMirrorAction,
  type AgentMirrorPlan,
  type AgentMirrorPlanResponse,
  type AgentMirrorsView,
  type ApprovalView,
  type GroupView,
  type Node,
} from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { usePlanDigest } from "@/composables/usePlanDigest";
import { proofReason } from "@/components/common/proofModel";
import { formatRelativeTime } from "@/lib/format";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores/auth";

import AttentionList, { type AttentionItem } from "@/components/common/AttentionList.vue";
import ConfirmDialog from "@/components/common/ConfirmDialog.vue";
import CopyButton from "@/components/common/CopyButton.vue";
import DataTable, { type DataTableColumn } from "@/components/common/DataTable.vue";
import PlanReviewDialog from "@/components/common/PlanReviewDialog.vue";
import RowMenu, { type RowMenuItem } from "@/components/common/RowMenu.vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogScrollContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import AgentMirrorPlanReadout from "./AgentMirrorPlanReadout.vue";
import { idToken } from "./agentUpdatesModel";
import AgentSourceOrder from "./AgentSourceOrder.vue";
import { mirrorPlanSentence } from "./agentMirrorsCopy";
import {
  AGENT_MIRRORS_PLUGIN,
  MAX_AGENT_MIRRORS,
  chosenSummary,
  draftChangesMirror,
  draftFromMirror,
  emptyMirrorDraft,
  filterOrderGroups,
  groupOrders,
  healthById,
  isNodeConfined,
  mirrorDraftProblems,
  mirrorFromDraft,
  mirrorReach,
  mirrorRefLabel,
  mirrorScope,
  mirrorsWithChunkFailures,
  namePreview,
  parseAgentMirrorPlan,
  pendingByMirror,
  planBehindRegistry,
  planHeadline,
  pruneFiledPlans,
  serverProblemField,
  sortMirrors,
  waitingPlans,
  type FiledPlan,
  type MirrorDraft,
  type MirrorDraftField,
} from "./agentMirrorsModel";

const props = defineProps<{
  /** The registry read; undefined until it lands. */
  view?: AgentMirrorsView;
  error?: Error | null;
  loading: boolean;
  /** The node list, for the preferred-for picker and names. */
  nodes: readonly Node[];
}>();

const emit = defineEmits<{ refresh: [] }>();

const { t } = useI18n();
const auth = useAuthStore();

const K = "platform.agentUpdatesPage.mirrors";

const hasPlanScopes = computed(() => auth.can("node:admin") && auth.can("network:plan"));
const confined = computed(() => isNodeConfined(auth.principal?.server_allowlist));
/** The server takes registry plans from a fleet agent admin only (requireFleetAgentAdmin). */
const canChange = computed(() => hasPlanScopes.value && !confined.value);

const mirrors = computed(() => sortMirrors(props.view?.mirrors ?? []));
const health = computed(() => healthById(props.view?.health));
const order = computed(() => props.view?.order ?? []);
const pendingIds = computed(() => props.view?.pending ?? []);
const registryFull = computed(() => mirrors.value.length >= MAX_AGENT_MIRRORS);
const mirrorNames = computed(() => new Map(mirrors.value.filter((mirror) => mirror.name).map((mirror) => [mirror.id, mirror.name as string] as const)));
const failingMirrors = computed(() => new Set(mirrorsWithChunkFailures(props.view?.health).map((entry) => entry.mirror)));

const introOpen = ref(false);

// ── names for prefer_for ─────────────────────────────────────────────────────
const groupsQuery = useAsyncData<GroupView[]>(
  (signal) => (auth.can("group:read") ? api.groups.list({ signal }).then((r) => r.groups ?? []) : Promise.resolve([])),
  { pollInterval: 0 },
);
const groups = computed(() => groupsQuery.data.value ?? []);
const groupNames = computed(() => new Map(groups.value.map((group) => [group.id, group.name] as const)));
const nodeNames = computed(() => new Map(props.nodes.map((node) => [node.id, node.name || node.id] as const)));

function refLabel(ref: string) {
  return mirrorRefLabel(ref, nodeNames.value, groupNames.value);
}

// ── the plans waiting for review ─────────────────────────────────────────────
// The view names their ids; their plan text says what each does and which
// registry revision it was made against.
const pendingQuery = useAsyncData<ApprovalView[]>(
  (signal) =>
    hasPlanScopes.value && pendingIds.value.length
      ? api.approvals.list({ plugin: AGENT_MIRRORS_PLUGIN, status: "pending", include: "plan" }, { signal }).then((r) => unwrap(r, "approvals"))
      : Promise.resolve([]),
  { pollInterval: 0 },
);
watch(
  () => pendingIds.value.join(","),
  () => void pendingQuery.refresh(),
);

const pendingRows = computed(() => {
  const byId = new Map((pendingQuery.data.value ?? []).map((approval) => [approval.id, approval] as const));
  return pendingIds.value.map((id) => {
    const approval = byId.get(id);
    const plan = parseAgentMirrorPlan(approval?.plan);
    return { id, approval, plan, behind: plan ? planBehindRegistry(plan, props.view?.revision) : false };
  });
});

/**
 * Plans this page filed that the registry read does not list yet. They count
 * as waiting from the moment the server answered, so the row, the attention
 * item and the duplicate check never see a gap between filing and the next
 * read. An entry leaves once the pending plans read holds it, or once a read
 * that landed well after the filing no longer lists it (decided elsewhere).
 */
const localFiled = ref<FiledPlan[]>([]);
watch(
  () => [props.view, pendingQuery.data.value] as const,
  () => {
    const read = new Set((pendingQuery.data.value ?? []).map((approval) => approval.id));
    localFiled.value = pruneFiledPlans(localFiled.value, read, new Set(pendingIds.value), Date.now());
  },
);

/** The plans waiting for each mirror, so its row says one exists before anyone files a second. */
const pendingPlans = computed(() => waitingPlans(pendingRows.value, localFiled.value));
const pendingForMirror = computed(() => pendingByMirror(pendingPlans.value));

function planSentence(plan: AgentMirrorPlan): string {
  return mirrorPlanSentence(t, plan);
}

/** Whether a mirror has a disable plan waiting, for the attention item's words. */
function waitingDisable(mirrorId: string): boolean {
  const ids = new Set(pendingForMirror.value.get(mirrorId) ?? []);
  return pendingPlans.value.some((entry) => ids.has(entry.id) && entry.plan && planHeadline(entry.plan).kind === "disable");
}

// ── attention ────────────────────────────────────────────────────────────────
const attention = computed<AttentionItem[]>(() =>
  mirrorsWithChunkFailures(props.view?.health).map((entry) => {
    const mirror = mirrors.value.find((candidate) => candidate.id === entry.mirror);
    const waiting = pendingForMirror.value.get(entry.mirror) ?? [];
    let action: AttentionItem["action"];
    if (waiting.length) {
      action = {
        label: waitingDisable(entry.mirror) ? t(`${K}.attention.reviewDisable`) : t(`${K}.attention.reviewPending`),
        to: { name: "approvals", query: { open: waiting[0] } },
      };
    } else if (canChange.value && mirror?.enabled) {
      action = { label: t(`${K}.attention.disable`), run: () => void toggleEnabled(mirror), busy: planning.value === mirror.id };
    }
    return {
      key: `chunks:${entry.mirror}`,
      tone: "danger",
      claim: t(`${K}.attention.chunksClaim`, { id: entry.mirror, n: entry.chunk_failures }, entry.chunk_failures),
      proof: t(`${K}.attention.chunksProof`),
      action,
    };
  }),
);

// ── the registry table ───────────────────────────────────────────────────────
const columns = computed<DataTableColumn<AgentMirror>[]>(() => [
  { key: "id", label: t(`${K}.col.mirror`), sortable: true, wrap: true },
  { key: "base_url", label: t(`${K}.col.baseUrl`) },
  { key: "applies", label: t(`${K}.col.applies`), value: (mirror) => mirrorScope(mirror) },
  { key: "priority", label: t(`${K}.col.priority`), sortable: true, align: "right", class: "whitespace-nowrap" },
  { key: "enabled", label: t(`${K}.col.state`), sortable: true, value: (mirror) => (mirror.enabled ? 1 : 0) },
  { key: "health", label: t(`${K}.col.health`), sortable: true, value: (mirror) => health.value.get(mirror.id)?.fetches ?? 0 },
  { key: "actions", label: "", class: "w-12", pin: "end" },
]);

const REFS_SHOWN = 4;

/** A URL in parts that each end at a slash, for <wbr> between them; the text is unchanged. */
function urlParts(url: string): string[] {
  return url.split(/(?<=[^/:]\/)/);
}
const openRefs = ref(new Set<string>());
function toggleRefs(id: string): void {
  const next = new Set(openRefs.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  openRefs.value = next;
}

const planning = ref<string | undefined>();

/**
 * A second plan for a mirror that already has one waiting asks first:
 * approving either makes the other stale, so a repeated click must not file
 * one silently.
 */
const duplicate = ref<{ mirror: AgentMirror; run: () => void } | undefined>();
function guarded(mirror: AgentMirror, run: () => void): void {
  if (pendingForMirror.value.get(mirror.id)?.length) duplicate.value = { mirror, run };
  else run();
}
function fileAnother(): void {
  const pending = duplicate.value;
  duplicate.value = undefined;
  pending?.run();
}

function menuFor(mirror: AgentMirror): RowMenuItem[] {
  const busy = planning.value === mirror.id;
  const waiting = pendingForMirror.value.get(mirror.id) ?? [];
  return [
    {
      key: "review",
      label: t(`${K}.actions.review`),
      icon: FileCode2,
      hidden: !waiting.length,
      to: { name: "approvals", query: { open: waiting[0] } },
    },
    { key: "change", label: t(`${K}.actions.change`), icon: Pencil, disabled: busy, run: () => guarded(mirror, () => openChange(mirror)) },
    {
      key: "toggle",
      label: mirror.enabled ? t(`${K}.actions.disable`) : t(`${K}.actions.enable`),
      icon: mirror.enabled ? PowerOff : Power,
      disabled: busy,
      run: () => guarded(mirror, () => void toggleEnabled(mirror)),
    },
    { key: "delete", label: t(`${K}.actions.delete`), icon: Trash2, danger: true, disabled: busy, run: () => guarded(mirror, () => (deleteTarget.value = mirror)) },
  ];
}

/** The row's actions button: where focus goes back to once a plan filed from that row is closed. */
function rowTrigger(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-mirror-actions="${CSS.escape(id)}"] button`);
}
function addButton(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-testid="mirror-add"]');
}

// ── the order preview ────────────────────────────────────────────────────────
const NAMES_SHOWN = 8;
const orderFilter = ref("");
const orderGroups = computed(() => groupOrders(order.value));
const shownGroups = computed(() => filterOrderGroups(orderGroups.value, orderFilter.value, mirrorNames.value));
const shownNodes = computed(() => shownGroups.value.reduce((sum, group) => sum + group.nodes.length, 0));
const openGroups = ref(new Set<string>());
function toggleGroup(key: string): void {
  const next = new Set(openGroups.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  openGroups.value = next;
}
/** A filter shows every node it matched; otherwise a row names its first few. */
function groupShownNames(group: (typeof shownGroups.value)[number]) {
  if (orderFilter.value.trim() || openGroups.value.has(group.key)) return { names: group.nodes, extra: 0 };
  return namePreview(group.nodes, NAMES_SHOWN);
}

// ── filing a plan ────────────────────────────────────────────────────────────
const { digestHex } = usePlanDigest();
const filed = ref<AgentMirrorPlanResponse | undefined>();
const filedDigest = ref("");
const planOpen = ref(false);
const filedPlan = computed(() => (filed.value ? (parseAgentMirrorPlan(filed.value.approval.plan) ?? filed.value.plan) : undefined));
/** The plan dialog's title says what the plan does, enable and disable included. */
const filedKind = computed(() => (filedPlan.value ? planHeadline(filedPlan.value).kind : undefined));
/** Where focus lands when the plan dialog closes: the control that filed it, which a closed form or menu no longer is. */
const returnTarget = ref<(() => HTMLElement | null) | undefined>();

async function filePlan(action: AgentMirrorAction, mirror: AgentMirror | { id: string }, returnTo: () => HTMLElement | null): Promise<void> {
  planning.value = mirror.id;
  try {
    const result = await api.agentUpdates.planMirror({ action, mirror });
    // The plan is filed from here on: a failure below must not read as a
    // refusal, or a retry files it twice.
    filed.value = result;
    const plan = parseAgentMirrorPlan(result.approval.plan) ?? result.plan;
    localFiled.value = [...localFiled.value, { id: result.approval.id, plan, at: Date.now() }];
    try {
      filedDigest.value = await digestHex(result.approval.plan);
    } catch {
      // No WebCrypto (plain http): the dialog shows the plan without its
      // digest, and Approvals computes it again before anyone decides.
      filedDigest.value = "";
    }
    returnTarget.value = returnTo;
    planOpen.value = true;
    toast.success(t(`${K}.planFiled`));
    emit("refresh");
  } finally {
    planning.value = undefined;
  }
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const status = (error as { status?: number } | undefined)?.status;
  if (status === 403) return t(`${K}.refusedForbidden`, { message });
  return t(`${K}.refused`, { message });
}

/**
 * Enable or disable, built on the registry as the server holds it now rather
 * than on this page's last read, which may be 30 s old: a plan built on a
 * stale copy would quietly undo an edit someone else had approved since.
 * The state the operator asked for is the one they saw flipped; when the
 * registry already reads that way there is nothing to file.
 */
async function toggleEnabled(mirror: AgentMirror): Promise<void> {
  if (!canChange.value || planning.value) return;
  const wanted = !mirror.enabled;
  planning.value = mirror.id;
  try {
    const fresh = await api.agentUpdates.mirrors();
    const current = fresh.mirrors.find((entry) => entry.id === mirror.id);
    if (!current) {
      toast.error(t(`${K}.goneSince`, { id: mirror.id }));
      emit("refresh");
      return;
    }
    if (current.enabled === wanted) {
      toast.info(wanted ? t(`${K}.alreadyEnabled`, { id: mirror.id }) : t(`${K}.alreadyDisabled`, { id: mirror.id }));
      emit("refresh");
      return;
    }
    await filePlan("change", { ...current, enabled: wanted, created_at: undefined, updated_at: undefined }, () => rowTrigger(mirror.id));
  } catch (error) {
    toast.error(errorText(error));
  } finally {
    planning.value = undefined;
  }
}

// ── the add and change form ──────────────────────────────────────────────────
const formOpen = ref(false);
const editing = ref<AgentMirror | undefined>();
const draft = ref<MirrorDraft>(emptyMirrorDraft());
const formError = ref("");
/** The field a server refusal names, marked as invalid beside the message. */
const formErrorField = ref<MirrorDraftField | undefined>();
const formErrorEl = ref<HTMLElement | null>(null);
const refFilter = ref("");
/** The applies-to warning waits until the operator has been through that part of the form. */
const appliesTouched = ref(false);

const problems = computed(() => mirrorDraftProblems(draft.value, { registry: mirrors.value, editing: editing.value?.id }));
/** Enabled, neither global nor preferred: valid, and listed in no plan. Said before filing, not after. */
const listsNowhere = computed(() => draft.value.enabled && !draft.value.global && !draft.value.prefer_for.length);
// A refusal answered the draft as it was; once a field changes it no longer applies.
watch(
  draft,
  () => {
    formError.value = "";
    formErrorField.value = undefined;
  },
  { deep: true },
);
const unchanged = computed(() => !!editing.value && !draftChangesMirror(draft.value, editing.value));
const canSubmit = computed(() => Object.keys(problems.value).length === 0 && !unchanged.value && !planning.value);

function resetForm(entry: AgentMirror | undefined): void {
  editing.value = entry;
  draft.value = entry ? draftFromMirror(entry) : emptyMirrorDraft();
  formError.value = "";
  formErrorField.value = undefined;
  refFilter.value = "";
  chosenSnapshot.value = null;
  appliesTouched.value = !!entry;
  formOpen.value = true;
}

function openCreate(): void {
  if (canChange.value) resetForm(undefined);
}

function openChange(mirror: AgentMirror): void {
  if (canChange.value) resetForm(mirror);
}

/** A field's problem shows once the field holds something, as the policy form's checks do. */
function problemText(field: MirrorDraftField, filled: boolean): string | undefined {
  const problem = problems.value[field];
  return problem && filled ? t(`${K}.form.problems.${problem}`) : undefined;
}

/** aria-invalid and the line that says why, for a field with a problem or the field a refusal named. */
function fieldAria(field: MirrorDraftField, filled: boolean): Record<string, string> {
  if (problemText(field, filled)) return { "aria-invalid": "true", "aria-describedby": `mirror-${field}-error` };
  if (formErrorField.value === field) return { "aria-invalid": "true", "aria-describedby": "mirror-form-error" };
  return {};
}
function fieldInvalid(field: MirrorDraftField, filled: boolean): boolean {
  return !!problemText(field, filled) || formErrorField.value === field;
}

// The picker. The list never moves while the operator ticks it: what is
// chosen is one fixed line above it, not chips that wrap and push it down,
// and "Show chosen" keeps the rows it showed until it is turned off, so
// unticking one there leaves the row in place, unticked.
const chosenSnapshot = ref<Set<string> | null>(null);
const nodeIds = computed(() => new Set(props.nodes.map((node) => node.id)));
const groupIds = computed(() => new Set(groups.value.map((group) => group.id)));
const chosen = computed(() => chosenSummary(draft.value.prefer_for, nodeIds.value, groupIds.value));
const chosenText = computed(() => {
  const summary = chosen.value;
  if (!summary.total) return t(`${K}.form.chosenNone`);
  const parts = [
    summary.groups ? t(`${K}.form.chosenGroups`, { n: summary.groups }, summary.groups) : "",
    summary.nodes ? t(`${K}.form.chosenNodes`, { n: summary.nodes }, summary.nodes) : "",
    summary.unknown ? t(`${K}.form.chosenUnknown`, { n: summary.unknown }) : "",
  ].filter(Boolean);
  return t(`${K}.form.chosen`, { n: summary.total, parts: parts.join(t(`${K}.plan.fieldSeparator`)) });
});
function toggleShowChosen(): void {
  chosenSnapshot.value = chosenSnapshot.value ? null : new Set(draft.value.prefer_for);
}

function toggleRef(id: string, on: boolean): void {
  const next = new Set(draft.value.prefer_for);
  if (on) next.add(id);
  else next.delete(id);
  draft.value = { ...draft.value, prefer_for: [...next] };
}

const refNeedle = computed(() => refFilter.value.trim().toLowerCase());
function inPicker(id: string, name: string): boolean {
  if (chosenSnapshot.value && !chosenSnapshot.value.has(id)) return false;
  return !refNeedle.value || name.toLowerCase().includes(refNeedle.value) || id.toLowerCase().includes(refNeedle.value);
}
const pickGroups = computed(() => groups.value.filter((group) => inPicker(group.id, group.name)));
const pickNodes = computed(() => [...props.nodes].sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id)).filter((node) => inPicker(node.id, node.name || "")));
/** Chosen ids that name no node or group this page can read, so they can still be unticked. */
const pickUnknown = computed(() =>
  [...(chosenSnapshot.value ?? new Set(draft.value.prefer_for))].filter((id) => !nodeIds.value.has(id) && !groupIds.value.has(id) && inPicker(id, "")),
);

async function submitForm(): Promise<void> {
  if (!canSubmit.value) return;
  formError.value = "";
  formErrorField.value = undefined;
  const entry = editing.value;
  try {
    await filePlan(entry ? "change" : "create", mirrorFromDraft(draft.value), entry ? () => rowTrigger(entry.id) : addButton);
    formOpen.value = false;
  } catch (error) {
    formError.value = errorText(error);
    formErrorField.value = serverProblemField(error instanceof Error ? error.message : "");
    // The refusal may sit below the fold of a long form: bring the field it
    // names into view, or the message itself.
    await nextTick();
    const field = formErrorField.value ? document.querySelector<HTMLElement>(`#mirror-${formErrorField.value === "base_url" ? "url" : formErrorField.value}`) : null;
    const target = field && !field.hasAttribute("disabled") ? field : formErrorEl.value;
    target?.scrollIntoView({ block: "center" });
    target?.focus();
  }
}

// ── delete ───────────────────────────────────────────────────────────────────
const deleteTarget = ref<AgentMirror | undefined>();
const deleting = ref(false);
const deleteImpact = computed(() => {
  const mirror = deleteTarget.value;
  if (!mirror) return [];
  const reach = mirrorReach(order.value, mirror.id);
  return [
    reach ? t(`${K}.delete.impactReach`, { id: mirror.id, n: reach }, reach) : t(`${K}.delete.impactNone`, { id: mirror.id }),
    t(`${K}.delete.impactReview`),
  ];
});

async function confirmDelete(): Promise<void> {
  const mirror = deleteTarget.value;
  if (!mirror) return;
  deleting.value = true;
  try {
    await filePlan("delete", { id: mirror.id }, () => rowTrigger(mirror.id));
    deleteTarget.value = undefined;
  } catch (error) {
    toast.error(errorText(error));
  } finally {
    deleting.value = false;
  }
}
</script>

<template>
  <div class="space-y-5" data-testid="agent-mirrors">
    <AttentionList :items="attention" />

    <section class="space-y-3" aria-labelledby="agent-mirrors-heading">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h2 id="agent-mirrors-heading" class="text-sm font-medium">{{ $t(`${K}.title`) }}</h2>
        <div class="flex flex-wrap items-center gap-3">
          <span v-if="view" class="font-mono text-xs text-muted-foreground">{{ $t(`${K}.revision`, { n: view.revision, count: mirrors.length, max: MAX_AGENT_MIRRORS }) }}</span>
          <Button
            v-if="canChange"
            size="sm"
            variant="outline"
            :disabled="!view || registryFull"
            :title="registryFull ? $t(`${K}.full`, { max: MAX_AGENT_MIRRORS }) : undefined"
            data-testid="mirror-add"
            @click="openCreate"
          >
            <Plus aria-hidden="true" class="size-4" />
            {{ $t(`${K}.add`) }}
          </Button>
        </div>
      </div>
      <div class="max-w-3xl">
        <!-- Below 640 px the intro keeps to two lines until it is opened, so the registry stays near the top. -->
        <p id="agent-mirrors-intro" :class="cn('text-xs text-muted-foreground', !introOpen && 'max-sm:line-clamp-2')">{{ $t(`${K}.hint`) }}</p>
        <button
          type="button"
          class="touch-target mt-0.5 rounded-sm text-xs text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring sm:hidden"
          aria-controls="agent-mirrors-intro"
          :aria-expanded="introOpen"
          @click="introOpen = !introOpen"
        >{{ introOpen ? $t(`${K}.introLess`) : $t(`${K}.introMore`) }}</button>
      </div>
      <p v-if="hasPlanScopes && confined" class="max-w-3xl text-xs text-muted-foreground" data-testid="mirrors-confined">{{ $t(`${K}.confined`) }}</p>
      <p v-else-if="!hasPlanScopes" class="max-w-3xl text-xs text-muted-foreground" data-testid="mirrors-read-only">{{ $t(`${K}.readOnly`) }}</p>
      <p v-if="error && view" class="text-sm text-warning-text">{{ $t(`${K}.staleRead`, { reason: proofReason(error) }) }}</p>

      <!-- Plans filed and not yet decided: the registry below is what is in force. -->
      <div v-if="pendingIds.length" class="rounded-md border border-warning/40 bg-warning/5 p-3 text-sm" data-testid="mirrors-pending">
        <p class="font-medium text-foreground">{{ $t(`${K}.pending.title`, { n: pendingIds.length }, pendingIds.length) }}</p>
        <p class="mt-0.5 text-xs text-muted-foreground">{{ pendingIds.length > 1 ? $t(`${K}.pending.hintMany`) : $t(`${K}.pending.hint`) }}</p>
        <p v-if="pendingQuery.error.value" class="mt-1 flex flex-wrap items-baseline gap-x-2 text-xs text-warning-text" data-testid="mirrors-pending-unread">
          <span>{{ $t(`${K}.pending.readFailed`, { reason: proofReason(pendingQuery.error.value) }) }}</span>
          <button
            type="button"
            class="touch-target rounded-sm text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            @click="pendingQuery.refresh()"
          >{{ $t('common.actions.retry') }}</button>
        </p>
        <ul class="mt-2 divide-y divide-warning/20">
          <li v-for="row in pendingRows" :key="row.id" class="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-1.5 text-xs">
            <span class="w-full min-w-0 break-words text-foreground sm:w-auto sm:flex-1">{{ row.plan ? planSentence(row.plan) : $t(`${K}.pending.unread`, { id: idToken(row.id) }) }}</span>
            <span v-if="row.approval" class="whitespace-nowrap text-muted-foreground">{{ $t(`${K}.pending.filed`, { actor: row.approval.actor_id || '?', age: formatRelativeTime(row.approval.created_at || '') }) }}</span>
            <span v-if="row.behind" class="whitespace-nowrap text-warning-text">{{ $t(`${K}.pending.behind`) }}</span>
            <RouterLink :to="{ name: 'approvals', query: { open: row.id } }" class="touch-target whitespace-nowrap text-primary underline-offset-4 hover:underline">{{ $t(`${K}.pending.review`) }}</RouterLink>
          </li>
        </ul>
      </div>

      <div v-if="view && !mirrors.length" class="rounded-md border border-dashed border-muted-foreground/40 p-4" data-testid="mirrors-empty">
        <p class="text-sm font-medium">{{ $t(`${K}.emptyTitle`) }}</p>
        <p class="mt-1 max-w-3xl text-sm text-muted-foreground">{{ $t(`${K}.emptyDescription`) }}</p>
        <Button v-if="canChange" size="sm" class="mt-3" data-testid="mirror-add-empty" @click="openCreate">
          <Plus aria-hidden="true" class="size-4" />
          {{ $t(`${K}.add`) }}
        </Button>
      </div>
      <DataTable
        v-else
        state-key="mirrors"
        :columns="columns"
        :rows="mirrors"
        :row-key="(mirror) => mirror.id"
        :loading="loading && !view"
        :error="!view ? (error ?? null) : null"
        :has-data="!!view"
        :expression-filter="false"
        :show-summary="false"
        @retry="emit('refresh')"
      >
        <template #cell-id="{ row }">
          <span class="block break-all font-mono text-xs font-medium">{{ row.id }}</span>
          <span v-if="row.name" class="block break-words text-xs text-muted-foreground">{{ row.name }}</span>
        </template>
        <template #cell-base_url="{ row }">
          <div class="flex w-36 items-start gap-1 sm:w-auto sm:min-w-48 sm:max-w-80">
            <!-- Breaks after a slash first, and inside a part only when one part is too long. -->
            <code class="min-w-0 font-mono text-xs [overflow-wrap:anywhere]"><template v-for="(part, index) in urlParts(row.base_url)" :key="index"><wbr v-if="index" />{{ part }}</template></code>
            <CopyButton :value="row.base_url" :aria-label="$t(`${K}.copyBaseUrl`, { id: row.id })" />
          </div>
        </template>
        <template #cell-applies="{ row }">
          <div class="min-w-40 max-w-72 space-y-1 text-xs">
            <p v-if="row.global" class="text-foreground">{{ $t(`${K}.applies.global`) }}</p>
            <div v-if="(row.prefer_for ?? []).length">
              <p class="text-muted-foreground">{{ $t(`${K}.applies.preferred`, { n: (row.prefer_for ?? []).length }) }}</p>
              <ul class="mt-0.5 flex flex-wrap gap-1">
                <li
                  v-for="item in openRefs.has(row.id) ? (row.prefer_for ?? []) : namePreview(row.prefer_for ?? [], REFS_SHOWN).names"
                  :key="item"
                  :title="item"
                  :class="cn('max-w-full break-all rounded border border-border px-1.5 py-px', refLabel(item).kind === 'unknown' && 'font-mono text-muted-foreground')"
                >
                  <span v-if="refLabel(item).kind === 'group'" class="me-1 text-muted-foreground">{{ $t(`${K}.applies.groupMark`) }}</span>{{ refLabel(item).text }}
                </li>
                <li v-if="namePreview(row.prefer_for ?? [], REFS_SHOWN).extra">
                  <button
                    type="button"
                    class="touch-target rounded-sm text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                    :aria-expanded="openRefs.has(row.id)"
                    @click="toggleRefs(row.id)"
                  >{{ openRefs.has(row.id) ? $t(`${K}.showFewer`) : $t(`${K}.showAll`, { n: namePreview(row.prefer_for ?? [], REFS_SHOWN).extra }) }}</button>
                </li>
              </ul>
            </div>
            <p v-if="row.enabled && mirrorScope(row) === 'nowhere'" class="text-warning-text">{{ $t(`${K}.applies.nowhere`) }}</p>
          </div>
        </template>
        <template #cell-priority="{ row }">
          <span class="font-mono text-xs tabular-nums">{{ row.priority }}</span>
        </template>
        <template #cell-enabled="{ row }">
          <span v-if="row.enabled" class="whitespace-nowrap text-xs text-muted-foreground">{{ $t(`${K}.state.enabled`) }}</span>
          <span v-else class="block text-xs text-warning-text">
            <span class="whitespace-nowrap">{{ $t(`${K}.state.disabled`) }}</span>
            <span class="block text-muted-foreground">{{ $t(`${K}.state.disabledHint`) }}</span>
          </span>
          <RouterLink
            v-if="pendingForMirror.get(row.id)?.length"
            :to="{ name: 'approvals', query: { open: pendingForMirror.get(row.id)![0] } }"
            class="touch-target mt-0.5 block min-w-28 text-xs text-primary underline-offset-4 hover:underline"
            data-testid="mirror-row-pending"
          >{{ $t(`${K}.state.pending`) }}</RouterLink>
        </template>
        <template #cell-health="{ row }">
          <div class="text-xs md:min-w-36">
            <template v-if="health.get(row.id)?.fetches">
              <p class="text-foreground">{{ $t(`${K}.health.fetches`, { n: health.get(row.id)!.fetches }, health.get(row.id)!.fetches) }}</p>
              <p v-if="health.get(row.id)!.chunk_failures" class="mt-0.5 flex items-start gap-1 text-destructive" data-testid="mirror-chunk-failures">
                <AlertTriangle class="mt-px size-3.5 shrink-0" aria-hidden="true" />
                <span>{{ $t(`${K}.health.chunkFailures`, { n: health.get(row.id)!.chunk_failures }, health.get(row.id)!.chunk_failures) }}</span>
              </p>
            </template>
            <p v-else class="text-muted-foreground">{{ $t(`${K}.health.none`) }}</p>
          </div>
        </template>
        <template #cell-actions="{ row }">
          <div v-if="canChange" :data-mirror-actions="row.id">
            <RowMenu :name="row.id" :items="menuFor(row)" />
          </div>
        </template>
      </DataTable>
    </section>

    <section class="space-y-3" aria-labelledby="agent-order-heading">
      <div class="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="agent-order-heading" class="text-sm font-medium">{{ $t(`${K}.order.title`) }}</h2>
        <span v-if="view" class="text-xs text-muted-foreground">
          {{ orderFilter.trim()
            ? $t(`${K}.order.countFiltered`, { shown: shownNodes, total: order.length })
            : `${$t(`${K}.nodeCount`, { n: order.length }, order.length)} · ${$t(`${K}.order.groups`, { n: orderGroups.length }, orderGroups.length)}` }}
        </span>
      </div>
      <p class="max-w-3xl text-xs text-muted-foreground">{{ confined ? $t(`${K}.order.hintConfined`) : $t(`${K}.order.hint`) }}</p>
      <p v-if="!view && error" class="text-sm text-muted-foreground">{{ $t(`${K}.order.notRead`) }}</p>
      <p v-else-if="!view" class="text-sm text-muted-foreground">{{ $t(`${K}.order.reading`) }}</p>
      <template v-else-if="order.length">
        <div class="relative max-w-xs">
          <Search class="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input v-model="orderFilter" type="search" class="ps-8" :aria-label="$t(`${K}.order.filterLabel`)" :placeholder="$t(`${K}.order.filterPlaceholder`)" data-testid="mirror-order-filter" />
        </div>
        <ul v-if="shownGroups.length" class="divide-y divide-border rounded-md border border-border" data-testid="mirror-order-groups">
          <li v-for="group in shownGroups" :key="group.key" class="grid gap-2 px-3 py-2.5 md:grid-cols-[minmax(0,30rem)_minmax(0,1fr)] md:gap-4">
            <AgentSourceOrder :sources="group.sources" :mirror-names="mirrorNames" :failing="failingMirrors" />
            <p class="break-words text-xs text-muted-foreground">
              <span class="font-medium text-foreground">{{ $t(`${K}.nodeCount`, { n: group.nodes.length }, group.nodes.length) }}</span>
              <span>: </span>
              <template v-for="(node, index) in groupShownNames(group).names" :key="node.id">
                <span v-if="index">, </span><span class="whitespace-nowrap">{{ node.name }}</span>
              </template>
              <button
                v-if="!orderFilter.trim() && namePreview(group.nodes, NAMES_SHOWN).extra"
                type="button"
                class="touch-target ms-1 rounded-sm text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                :aria-expanded="openGroups.has(group.key)"
                @click="toggleGroup(group.key)"
              >{{ openGroups.has(group.key) ? $t(`${K}.showFewer`) : $t(`${K}.showAll`, { n: namePreview(group.nodes, NAMES_SHOWN).extra }) }}</button>
            </p>
          </li>
        </ul>
        <p v-else class="text-sm text-muted-foreground">{{ $t(`${K}.order.noMatch`, { text: orderFilter.trim() }) }}</p>
      </template>
      <p v-else class="text-sm text-muted-foreground">{{ $t(`${K}.order.empty`) }}</p>
    </section>

    <!-- Add or change an entry: files a plan, nothing changes until it is approved. -->
    <Dialog v-model:open="formOpen">
      <DialogScrollContent class="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{{ editing ? $t(`${K}.form.changeTitle`, { id: editing.id }) : $t(`${K}.form.createTitle`) }}</DialogTitle>
          <DialogDescription>{{ $t(`${K}.form.description`) }}</DialogDescription>
        </DialogHeader>
        <form class="space-y-4" data-testid="mirror-form" @submit.prevent="submitForm">
          <div class="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
            <div class="grid content-start gap-2">
              <Label for="mirror-id">{{ $t(`${K}.form.id`) }}</Label>
              <Input
                id="mirror-id"
                v-model="draft.id"
                class="font-mono"
                autocomplete="off"
                spellcheck="false"
                :disabled="!!editing"
                :placeholder="$t(`${K}.form.idPlaceholder`)"
                :class="cn(fieldInvalid('id', !!draft.id) && 'border-destructive')"
                v-bind="fieldAria('id', !!draft.id)"
              />
              <p v-if="problemText('id', !!draft.id)" id="mirror-id-error" class="text-xs text-destructive">{{ problemText('id', !!draft.id) }}</p>
              <p v-else class="text-xs text-muted-foreground">{{ editing ? $t(`${K}.form.idFixed`) : $t(`${K}.form.idHint`) }}</p>
            </div>
            <div class="grid content-start gap-2">
              <Label for="mirror-name">{{ $t(`${K}.form.name`) }}</Label>
              <Input
                id="mirror-name"
                v-model="draft.name"
                autocomplete="off"
                :placeholder="$t(`${K}.form.namePlaceholder`)"
                :class="cn(fieldInvalid('name', !!draft.name) && 'border-destructive')"
                v-bind="fieldAria('name', !!draft.name)"
              />
              <p v-if="problemText('name', !!draft.name)" id="mirror-name-error" class="text-xs text-destructive">{{ problemText('name', !!draft.name) }}</p>
              <p v-else class="text-xs text-muted-foreground">{{ $t(`${K}.form.nameHint`) }}</p>
            </div>
          </div>

          <div class="grid gap-2">
            <Label for="mirror-url">{{ $t(`${K}.form.baseUrl`) }}</Label>
            <Input
              id="mirror-url"
              v-model="draft.base_url"
              class="font-mono"
              autocomplete="off"
              spellcheck="false"
              inputmode="url"
              placeholder="https://agent-mirror.example.com/lattice-agent"
              :class="cn(fieldInvalid('base_url', !!draft.base_url) && 'border-destructive')"
              v-bind="fieldAria('base_url', !!draft.base_url)"
            />
            <p v-if="problemText('base_url', !!draft.base_url)" id="mirror-base_url-error" class="text-xs text-destructive">{{ problemText('base_url', !!draft.base_url) }}</p>
            <p v-else class="text-xs text-muted-foreground">{{ $t(`${K}.form.baseUrlHint`) }}</p>
          </div>

          <fieldset class="grid min-w-0 gap-2 rounded-md border border-border bg-muted/20 p-3" @focusout="appliesTouched = true">
            <legend class="px-1 text-sm font-medium">{{ $t(`${K}.form.applies`) }}</legend>
            <label class="flex cursor-pointer items-start gap-2 text-sm">
              <Checkbox v-model="draft.global" class="mt-0.5" />
              <span>
                <span class="block">{{ $t(`${K}.form.global`) }}</span>
                <span class="block text-xs text-muted-foreground">{{ $t(`${K}.form.globalHint`) }}</span>
              </span>
            </label>
            <div class="grid min-w-0 gap-2 pt-1">
              <p id="mirror-prefer-label" class="text-sm">{{ $t(`${K}.form.preferFor`) }}</p>
              <p class="text-xs text-muted-foreground">{{ $t(`${K}.form.preferForHint`) }}</p>
              <!-- One fixed line, whatever is chosen: the list below never moves under the pointer. -->
              <div class="flex h-6 min-w-0 items-center justify-between gap-2 text-xs">
                <p
                  id="mirror-prefer_for-error"
                  :class="cn('min-w-0 truncate', problemText('prefer_for', true) ? 'text-destructive' : 'text-muted-foreground')"
                  aria-live="polite"
                  :title="chosenText"
                  data-testid="mirror-chosen"
                >{{ problemText('prefer_for', true) ? `${chosenText}. ${problemText('prefer_for', true)}` : chosenText }}</p>
                <button
                  v-if="chosen.total || chosenSnapshot"
                  type="button"
                  class="touch-target shrink-0 rounded-sm text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                  :aria-pressed="!!chosenSnapshot"
                  data-testid="mirror-show-chosen"
                  @click="toggleShowChosen"
                >{{ chosenSnapshot ? $t(`${K}.form.showAllRefs`) : $t(`${K}.form.showChosen`) }}</button>
              </div>
              <div class="relative">
                <Search class="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                <!-- Enter narrows the list; it never submits the form, which would file a plan. -->
                <Input v-model="refFilter" type="search" class="ps-8" :aria-label="$t(`${K}.form.refFilter`)" :placeholder="$t(`${K}.form.refFilter`)" @keydown.enter.prevent />
              </div>
              <div
                class="grid max-h-56 gap-0.5 overflow-auto rounded-md border border-border bg-background p-1.5"
                role="group"
                aria-labelledby="mirror-prefer-label"
                v-bind="fieldAria('prefer_for', true)"
              >
                <template v-if="pickGroups.length">
                  <p class="px-2 pt-1 text-xs font-medium text-muted-foreground">{{ $t(`${K}.form.groups`) }}</p>
                  <label v-for="group in pickGroups" :key="group.id" class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted/40">
                    <Checkbox :model-value="draft.prefer_for.includes(group.id)" @update:model-value="(v) => toggleRef(group.id, v === true)" />
                    <span class="min-w-0 flex-1 truncate" :title="group.name">{{ group.name }}</span>
                    <span class="shrink-0 text-xs text-muted-foreground">{{ $t(`${K}.form.groupMembers`, { n: (group.members ?? []).length }, (group.members ?? []).length) }}</span>
                  </label>
                </template>
                <p v-if="pickNodes.length" class="px-2 pt-1 text-xs font-medium text-muted-foreground">{{ $t(`${K}.form.nodes`) }}</p>
                <label v-for="node in pickNodes" :key="node.id" class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted/40">
                  <Checkbox :model-value="draft.prefer_for.includes(node.id)" @update:model-value="(v) => toggleRef(node.id, v === true)" />
                  <span class="min-w-0 flex-1 truncate" :title="node.name || node.id">{{ node.name || node.id }}</span>
                </label>
                <template v-if="pickUnknown.length">
                  <p class="px-2 pt-1 text-xs font-medium text-muted-foreground">{{ $t(`${K}.form.unknownRefs`) }}</p>
                  <label v-for="id in pickUnknown" :key="id" class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted/40">
                    <Checkbox :model-value="draft.prefer_for.includes(id)" @update:model-value="(v) => toggleRef(id, v === true)" />
                    <span class="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" :title="id">{{ id }}</span>
                  </label>
                </template>
                <p v-if="!pickGroups.length && !pickNodes.length && !pickUnknown.length" class="px-2 py-1.5 text-xs text-muted-foreground">{{ $t(`${K}.form.refNoMatch`) }}</p>
              </div>
            </div>
          </fieldset>

          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div class="grid content-start gap-2">
              <Label for="mirror-priority">{{ $t(`${K}.form.priority`) }}</Label>
              <Input
                id="mirror-priority"
                v-model="draft.priority"
                class="w-40 font-mono"
                inputmode="numeric"
                autocomplete="off"
                :class="cn(fieldInvalid('priority', true) && 'border-destructive')"
                v-bind="fieldAria('priority', true)"
              />
              <p v-if="problemText('priority', true)" id="mirror-priority-error" class="text-xs text-destructive">{{ problemText('priority', true) }}</p>
              <p v-else class="text-xs text-muted-foreground">{{ $t(`${K}.form.priorityHint`) }}</p>
            </div>
            <label class="flex cursor-pointer items-start gap-2 self-start text-sm sm:pt-7">
              <Checkbox v-model="draft.enabled" class="mt-0.5" />
              <span>
                <span class="block">{{ $t(`${K}.form.enabled`) }}</span>
                <span class="block text-xs text-muted-foreground">{{ $t(`${K}.form.enabledHint`) }}</span>
              </span>
            </label>
          </div>

          <p
            v-if="formError"
            id="mirror-form-error"
            ref="formErrorEl"
            tabindex="-1"
            class="break-words rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-foreground outline-none"
            role="alert"
            data-testid="mirror-form-error"
          >{{ formError }}</p>
          <p v-else-if="unchanged" class="text-xs text-muted-foreground">{{ $t(`${K}.form.unchanged`) }}</p>
          <p v-else-if="listsNowhere && appliesTouched" class="text-xs text-warning-text" data-testid="mirror-form-nowhere">{{ $t(`${K}.form.nowhere`) }}</p>

          <DialogFooter>
            <Button type="button" variant="outline" @click="formOpen = false">{{ $t('common.actions.cancel') }}</Button>
            <Button type="submit" :disabled="!canSubmit" data-testid="mirror-form-submit">
              <RefreshCw v-if="planning" aria-hidden="true" class="size-4 animate-spin" />
              {{ $t(`${K}.form.submit`) }}
            </Button>
          </DialogFooter>
        </form>
      </DialogScrollContent>
    </Dialog>

    <!-- Delete files a plan too, and confirms first like every delete in the console. -->
    <ConfirmDialog
      :open="!!deleteTarget"
      :title="$t(`${K}.delete.title`, { id: deleteTarget?.id ?? '' })"
      :description="$t(`${K}.delete.description`, { id: deleteTarget?.id ?? '' })"
      :impact="deleteImpact"
      :impact-title="$t(`${K}.delete.impactTitle`)"
      :confirm-label="$t(`${K}.delete.confirm`)"
      :cancel-label="$t('common.actions.cancel')"
      :pending="deleting"
      :return-focus="() => (deleteTarget ? rowTrigger(deleteTarget.id) : null)"
      @update:open="(v) => { if (!v && !deleting) deleteTarget = undefined; }"
      @confirm="confirmDelete"
    />

    <!-- A second plan for a mirror with one waiting: say so, offer the waiting one, file another only when asked. -->
    <ConfirmDialog
      :open="!!duplicate"
      variant="default"
      :title="$t(`${K}.duplicate.title`, { id: duplicate?.mirror.id ?? '' })"
      :description="$t(`${K}.duplicate.description`)"
      :confirm-label="$t(`${K}.duplicate.confirm`)"
      :cancel-label="$t('common.actions.cancel')"
      :return-focus="() => (duplicate ? rowTrigger(duplicate.mirror.id) : null)"
      @update:open="(v) => { if (!v) duplicate = undefined; }"
      @confirm="fileAnother"
    >
      <RouterLink
        v-if="duplicate && pendingForMirror.get(duplicate.mirror.id)?.length"
        :to="{ name: 'approvals', query: { open: pendingForMirror.get(duplicate.mirror.id)![0] } }"
        class="touch-target text-sm text-primary underline-offset-4 hover:underline"
        data-testid="mirror-duplicate-review"
      >{{ $t(`${K}.actions.review`) }}</RouterLink>
    </ConfirmDialog>

    <!--
      SECURITY-CRITICAL: PlanReviewDialog is a pure renderer. `:plan-text` is the
      exact bytes the approval carries and `:digest` is digestHex over those same
      bytes. The readout above it is read from that text; it never replaces it.
    -->
    <PlanReviewDialog
      v-model:open="planOpen"
      :plan-text="filed?.approval.plan"
      :digest="filedDigest"
      :title="filedPlan && filedKind ? $t(`${K}.plan.dialogTitle.${filedKind}`, { id: filedPlan.mirror.id }) : $t(`${K}.title`)"
      :description="$t(`${K}.plan.dialogDescription`)"
      :plan-label="$t(`${K}.plan.text`)"
      :close-label="$t('common.actions.close')"
      :approvals-label="$t(`${K}.plan.review`)"
      :approvals-to="filed ? `/approvals?open=${encodeURIComponent(filed.approval.id)}` : '/approvals'"
      :return-focus="returnTarget"
    >
      <template #badges>
        <Badge v-if="filed" variant="outline">{{ $t('platform.agentUpdates.approvalLabel', { id: idToken(filed.approval.id) }) }}</Badge>
        <Badge v-if="filed" variant="warning">{{ $t(`common.status.${filed.approval.status}`) }}</Badge>
      </template>
      <template #summary>
        <AgentMirrorPlanReadout v-if="filedPlan" :plan="filedPlan" :revision="view?.revision" :group-names="groupNames" />
      </template>
      <p class="rounded-md border border-warning/40 bg-warning/5 p-3 text-sm text-muted-foreground">{{ $t(`${K}.plan.next`) }}</p>
    </PlanReviewDialog>
  </div>
</template>

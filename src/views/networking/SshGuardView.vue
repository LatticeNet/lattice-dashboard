<script setup lang="ts">
/**
 * SSH Guard: shrink a fleet's SSH exposure without locking yourself out.
 *
 * The page is a coverage board first, a fleet table second and a plan sheet
 * third. The board answers "where is the rollout": how many nodes are
 * confirmed, how many arms failed, how many are sitting on a revert timer
 * right now. The table answers it per node, and it answers with evidence
 * rather than intent: what sshd is bound to according to the node's own
 * guard-reality report, and when that was observed. The sheet is where a
 * plan gets written, once, for one node or for a batch, and it names the
 * consequence before it files anything.
 *
 * The state machine is still two approvals with a gap between them. Arming
 * applies the hardening and schedules an automatic revert; confirming cancels
 * the revert. The gap exists so a human can open a fresh connection over the
 * new path and get a shell, and the one urgent thing on this page is a node
 * inside that gap, because it has a deadline.
 */
import { computed, onBeforeUnmount, reactive, ref, shallowRef, watch } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { toast } from "vue-sonner";
import { AlertTriangle, ChevronRight, KeyRound, Lock, RefreshCw, Timer, X } from "lucide-vue-next";

import {
  api,
  ApiError,
  unwrap,
  type ApprovalView,
  type GuardNodeReality,
  type GuardRealitySummary,
  type Node,
  type NodeCapability,
  type SSHGuardFinding,
  type SSHGuardKnockRevealResponse,
  type SSHGuardKnockStateResponse,
} from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { useStepUp } from "@/composables/useStepUp";
import { useAuthStore } from "@/stores/auth";
import { formatDateTime, formatDuration, shortId } from "@/lib/format";
import { fieldNumber } from "@/lib/formValue";
import { cn } from "@/lib/utils";
import { partitionBatchResults, runWithConcurrency } from "@/views/operations/approvalsModel";
// Through the alias rather than "./", so the harness can swap it the way it swaps @/lib/api.
import { guardReality } from "@/views/networking/sshGuardReality";

import PageHeader from "@/components/common/PageHeader.vue";
import DataState from "@/components/common/DataState.vue";
import CopyButton from "@/components/common/CopyButton.vue";
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
  ADVANCED_DEFAULTS,
  DEFAULT_CONFIRM_WINDOW_SEC,
  KNOCK_OPEN_FOR_VALUES,
  PERMIT_ROOT_LOGIN_VALUES,
  armFailureText,
  armRejection,
  buildFleetStates,
  buildPlanRequest,
  defaultGuardForm,
  hasBlocking,
  isSSHGuardApproval,
  knockKnowledgeFor,
  parseMgmtSources,
  revertDeadline,
  sortFindings,
  validateForm,
  type GuardForm,
  type NodeGuardState,
} from "./sshGuardModel";
import {
  COVERAGE_FILTERS,
  batchRefusal,
  boardStage,
  controlPlaneNodeIds,
  coverageCounts,
  filterByCoverage,
  foldReality,
  formatAge,
  formatCountdown,
  isCoverageFilter,
  membersToFile,
  newestObservation,
  orderForBoard,
  proofCounts,
  realityDetailsToFetch,
  revertingNodes,
  summarizeBatch,
  type BatchMember,
  type BatchOutcome,
  type BoardStage,
  type CoverageFilter,
  type ScopeState,
} from "./sshGuardBoardModel";

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const auth = useAuthStore();

// Both scopes are required server-side: the capability's own and the plan
// scope the approval is minted under. Checking only one would offer a button
// that always fails.
const canAdmin = computed(() => auth.canAll(["sshguard:admin", "network:plan"]));
const canReadReality = computed(() => auth.can("netguard:read"));

/* ------------------------------------------------------------------ */
/* The knock sequence.                                                  */
/* ------------------------------------------------------------------ */

/*
 * This page used to say nothing at all about how to reach a node, which is
 * what produced the question: an operator who cannot get in has no way to find
 * the sequence, so he goes to an operations note that holds it in clear. The
 * table now answers "does the control plane know this" on every row, and the
 * dialog answers "what is it" behind a second factor.
 *
 * The two halves are deliberately different. Knowing whether a sequence exists
 * is not a secret and needs no ceremony. Being told the sequence is being told
 * the way into the machine, so it costs a passkey or a passcode and leaves an
 * audit row.
 */
const knockOpen = ref(false);
const knockNodeId = ref("");
const knockState = shallowRef<SSHGuardKnockStateResponse | undefined>();
const knockLoading = ref(false);
const knockError = ref("");
const knockRevealed = shallowRef<SSHGuardKnockRevealResponse | undefined>();
const knockRevealing = ref(false);

const knockStepUp = useStepUp({
  required: t("networking.sshGuard.knock.stepUp.required"),
  failed: t("networking.sshGuard.knock.stepUp.failed"),
  passkeyFailed: t("networking.sshGuard.knock.stepUp.passkeyFailed"),
});
const knockStepUpOpen = knockStepUp.open;
const knockStepUpCode = knockStepUp.code;
const knockStepUpError = knockStepUp.error;
const knockStepUpPending = knockStepUp.pending;

/** An applied arm with no applied confirm: the revert may have undone it. */
const knockUnconfirmed = computed(
  () => knockState.value?.knowledge === "installed" && knockState.value.confirmed === false,
);

const knockNodeName = computed(
  () => nodesQuery.data.value?.find((n) => n.id === knockNodeId.value)?.name || knockNodeId.value,
);

/** The word the Knock column shows, and the title that explains it. */
function knockCell(state: NodeGuardState): { text: string; title: string; muted: boolean } {
  const knowledge = knockKnowledgeFor(state);
  const key = (
    { installed: "installed", planned: "planned", no_knock: "noKnock", unknown: "unknown" } as const
  )[knowledge];
  return {
    text: t(`networking.sshGuard.knock.${key}`),
    title: t(`networking.sshGuard.knock.${key}Title`),
    // Only a sequence that reached the node is worth reading as present.
    muted: knowledge !== "installed",
  };
}

/**
 * Open the dialog and ask the server what it knows.
 *
 * The table's answer is derived from the plan the page already holds; this one
 * comes from the server, which is the authority and whose sentence the dialog
 * renders verbatim. Asking again on open also means a node armed in another
 * tab is not reported from a stale board.
 */
async function openKnock(nodeId: string) {
  knockNodeId.value = nodeId;
  knockRevealed.value = undefined;
  knockState.value = undefined;
  knockError.value = "";
  knockOpen.value = true;
  if (!canAdmin.value) return;
  knockLoading.value = true;
  try {
    knockState.value = await api.sshGuard.knockState(nodeId);
  } catch (error) {
    knockError.value = error instanceof Error ? error.message : t("networking.sshGuard.knock.toastRevealFailed");
  } finally {
    knockLoading.value = false;
  }
}

/**
 * Reveal, or put it away again.
 *
 * Toggling off drops the only copy the page holds. There is no timer on the
 * display: an operator reading a sequence off the screen is usually typing it
 * into another window, and a value that vanished mid-type would send him back
 * through the second factor for no security gain.
 */
async function revealKnock() {
  if (knockRevealed.value) {
    knockRevealed.value = undefined;
    return;
  }
  if (knockRevealing.value || !knockNodeId.value) return;
  knockRevealing.value = true;
  try {
    const grant = await knockStepUp.request();
    knockRevealed.value = await api.sshGuard.revealKnock(knockNodeId.value, grant);
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("networking.sshGuard.knock.toastRevealFailed"));
  } finally {
    knockRevealing.value = false;
  }
}

// Closing the dialog drops the sequence rather than leaving it in memory for
// the next open.
watch(knockOpen, (open) => {
  if (!open) {
    knockRevealed.value = undefined;
    knockState.value = undefined;
    knockError.value = "";
  }
});

/* ------------------------------------------------------------------ */
/* Data: approvals, fleet, scope, and what the nodes report.            */
/* ------------------------------------------------------------------ */

const approvalsQuery = useAsyncData<ApprovalView[] | undefined>(
  (signal) => api.approvals.list(undefined, { signal }).then((r) => unwrap(r, "approvals")),
  { pollInterval: 15000 },
);
const approvals = computed(() => (approvalsQuery.data.value ?? []).filter(isSSHGuardApproval));

// The fleet, not just the nodes with history: the remaining work here is
// rolling this out, and that work is made of the machines still open.
const nodesQuery = useAsyncData<Node[] | undefined>(
  (signal) => api.nodes.list({ signal }).then((r) => unwrap(r, "nodes")),
  { pollInterval: 30000 },
);

/**
 * Enrolment: whether SSH Guard is allowed to act on a node at all. Hardening
 * decides who can reach a machine over SSH, so it is opt-in per node, and the
 * server refuses a plan for a node nobody has enrolled.
 */
const capabilitiesQuery = useAsyncData<NodeCapability[] | undefined>(
  (signal) => api.nodes.capabilities({ signal }).then((r) => r.capabilities ?? []),
  { pollInterval: 60000 },
);

/**
 * The fleet summary of guard-reality snapshots: one call, paged by cursor,
 * saying when each node was last observed. The listeners themselves are only
 * on the per-node detail, read below and only when the summary says a node's
 * snapshot moved.
 */
const realityQuery = useAsyncData<GuardRealitySummary[] | undefined>(
  async (signal) => {
    if (!canReadReality.value) return undefined;
    const all: GuardRealitySummary[] = [];
    let cursor: string | undefined;
    do {
      const page = await guardReality.list({ limit: 500, cursor }, { signal });
      all.push(...(page.nodes ?? []));
      cursor = page.next_cursor || undefined;
    } while (cursor);
    return all;
  },
  { pollInterval: 60000 },
);

const realityDetails = shallowRef<Map<string, GuardNodeReality>>(new Map());
const detailCollectedAt = new Map<string, string>();
const detailsReading = ref(false);

watch(
  () => realityQuery.data.value,
  async (summaries) => {
    const ids = realityDetailsToFetch(summaries ?? [], detailCollectedAt);
    if (!ids.length) return;
    detailsReading.value = true;
    const next = new Map(realityDetails.value);
    try {
      await runWithConcurrency(ids, 4, async (nodeId) => {
        const res = await guardReality.detail(nodeId);
        const reality = res.node.reality;
        if (!reality) return;
        next.set(nodeId, reality);
        detailCollectedAt.set(nodeId, reality.collected_at);
      });
    } finally {
      realityDetails.value = next;
      detailsReading.value = false;
    }
  },
);

const summariesById = computed(
  () => new Map((realityQuery.data.value ?? []).map((s) => [s.node_id, s] as const)),
);

/* ------------------------------------------------------------------ */
/* The clock. A revert countdown is the one thing on this page that     */
/* changes without a poll, so it gets a one-second tick; the ages in    */
/* the table only need to move every quarter minute.                    */
/* ------------------------------------------------------------------ */

const now = ref(Date.now());
let ticks = 0;
const clock = setInterval(() => {
  ticks += 1;
  if (urgent.value.length || ticks % 15 === 0) now.value = Date.now();
}, 1000);
onBeforeUnmount(() => clearInterval(clock));

/* ------------------------------------------------------------------ */
/* Fleet state and the coverage board.                                  */
/* ------------------------------------------------------------------ */

const states = computed<NodeGuardState[]>(() =>
  orderForBoard(buildFleetStates(approvals.value, nodesQuery.data.value ?? []), now.value),
);

/**
 * The board's word for a row. It is the approval stage except for one case
 * the approvals cannot see: an applied arm whose window has closed, which the
 * box has already reverted. Read against the clock, so the second the window
 * closes the row, the chips, the proof line and the urgent card all change.
 */
function stageOf(state: NodeGuardState): BoardStage {
  return boardStage(state, now.value);
}

const urgent = computed(() => revertingNodes(states.value, now.value));
const confirmable = computed(() => urgent.value.filter((s) => s.stage === "awaitingConfirm"));

function scopeOf(nodeId: string): ScopeState {
  const record = (capabilitiesQuery.data.value ?? []).find(
    (c) => c.node_id === nodeId && c.capability === "sshguard",
  );
  if (record?.state === "enrolled") return "enrolled";
  if (record?.state === "excluded") return "excluded";
  return "undecided";
}

function nameOf(nodeId: string): string {
  return states.value.find((s) => s.nodeId === nodeId)?.name || nodeId;
}

/** The filter lives in the address bar, so a pasted link lands on the same chip. */
const coverageFilter = computed<CoverageFilter>({
  get: () => (isCoverageFilter(route.query.coverage) ? route.query.coverage : "all"),
  set: (value) => {
    const query = { ...route.query };
    if (value === "all") delete query.coverage;
    else query.coverage = value;
    router.replace({ query }).catch(() => {});
  },
});

const counts = computed(() => coverageCounts(states.value, scopeOf, now.value));
const visibleStates = computed(() => filterByCoverage(states.value, coverageFilter.value, scopeOf, now.value));

const proof = computed(() => proofCounts(states.value, now.value));
const observedAt = computed(() => newestObservation(realityQuery.data.value ?? []));
const proofLine = computed(() => {
  const observed = observedAt.value
    ? t("networking.sshGuard.proof.observed", { age: formatAge(now.value - Date.parse(observedAt.value)) })
    : t("networking.sshGuard.proof.notObserved");
  return [
    observed,
    t("networking.sshGuard.proof.nodes", { n: proof.value.total }),
    t("networking.sshGuard.proof.confirmed", { n: proof.value.confirmed }),
    t("networking.sshGuard.proof.failedArms", { n: proof.value.failedArms }),
    t("networking.sshGuard.proof.reverting", { n: proof.value.reverting }),
  ].join(" · ");
});

const evidence = computed(
  () => new Map(states.value.map((s) => [s.nodeId, foldReality(s.nodeId, summariesById.value, realityDetails.value)] as const)),
);

/* ------------------------------------------------------------------ */
/* Selection. Rows are picked for one of two things: a scope change or  */
/* a batch arm. Select-all acts on the current chip, never on the whole  */
/* fleet behind it.                                                     */
/* ------------------------------------------------------------------ */

const selectedNodes = ref<Set<string>>(new Set());
let selectionAnchor = "";

const selectedVisible = computed(() =>
  visibleStates.value.filter((state) => selectedNodes.value.has(state.nodeId)),
);

function toggleRow(nodeId: string, event?: MouseEvent) {
  const next = new Set(selectedNodes.value);
  // Shift-click selects the run between the anchor and here, which is what
  // makes partitioning a sorted fleet quick instead of 33 individual clicks.
  if (event?.shiftKey && selectionAnchor) {
    const ids = visibleStates.value.map((s) => s.nodeId);
    const from = ids.indexOf(selectionAnchor);
    const to = ids.indexOf(nodeId);
    if (from !== -1 && to !== -1) {
      const [lo, hi] = from < to ? [from, to] : [to, from];
      for (const id of ids.slice(lo, hi + 1)) next.add(id);
      selectedNodes.value = next;
      return;
    }
  }
  if (next.has(nodeId)) next.delete(nodeId);
  else next.add(nodeId);
  selectionAnchor = nodeId;
  selectedNodes.value = next;
}

function toggleSelectAllVisible(on: boolean) {
  const next = new Set(selectedNodes.value);
  for (const state of visibleStates.value) {
    if (on) next.add(state.nodeId);
    else next.delete(state.nodeId);
  }
  selectedNodes.value = next;
}

const allVisibleSelected = computed(
  () => visibleStates.value.length > 0 && selectedVisible.value.length === visibleStates.value.length,
);

function clearSelection() {
  selectedNodes.value = new Set();
  selectionAnchor = "";
  scopeFailures.value = [];
}

/**
 * A node an arm plan can be written for: nothing live on it, and in scope. A
 * node whose window closed has nothing live either; its hardening is gone.
 */
function isArmable(state: NodeGuardState): boolean {
  const stage = stageOf(state);
  return (stage === "idle" || stage === "armFailed" || stage === "reverted") && scopeOf(state.nodeId) === "enrolled";
}
const armableSelected = computed(() => selectedVisible.value.filter(isArmable));

/* ------------------------------------------------------------------ */
/* Scope changes. Cheap and reversible: neither touches the machine.    */
/* Four in flight at once, and every failure named per node, because a  */
/* partial change that toasts "done" is how a fleet ends up in a state   */
/* nobody can describe.                                                  */
/* ------------------------------------------------------------------ */

const bulkRunning = ref(false);
const bulkProgress = reactive({ done: 0, total: 0 });
const bulkExcludeOpen = ref(false);
const bulkExcludeReason = ref("");
const scopeFailures = ref<{ nodeId: string; error: string }[]>([]);

async function applyScope(nodeIds: string[], state: "enrolled" | "excluded" | "", reason?: string) {
  if (!nodeIds.length || bulkRunning.value) return;
  bulkRunning.value = true;
  bulkProgress.done = 0;
  bulkProgress.total = nodeIds.length;
  scopeFailures.value = [];
  try {
    const results = await runWithConcurrency(
      nodeIds,
      4,
      (nodeId) => api.nodes.setCapability({ node_id: nodeId, capability: "sshguard", state, reason }),
      (done) => {
        bulkProgress.done = done;
        // Refresh as it goes so the chips move while the work happens.
        if (done % 5 === 0) capabilitiesQuery.refresh();
      },
    );
    const { failed } = partitionBatchResults(nodeIds, results);
    if (failed.length) {
      scopeFailures.value = failed.map((f) => ({ nodeId: f.item, error: f.error }));
      toast.error(
        t("networking.sshGuard.scope.bulkPartial", {
          done: nodeIds.length - failed.length,
          failed: failed.length,
          nodes: failed.slice(0, 3).map((f) => nameOf(f.item)).join(", "),
        }),
      );
      // Keep the failures selected so the retry is one click, and drop the rest.
      selectedNodes.value = new Set(failed.map((f) => f.item));
    } else {
      toast.success(t("networking.sshGuard.scope.bulkDone", { count: nodeIds.length }));
      clearSelection();
    }
    capabilitiesQuery.refresh();
  } finally {
    bulkRunning.value = false;
    bulkProgress.done = 0;
    bulkProgress.total = 0;
  }
}

async function confirmBulkExclude() {
  const reason = bulkExcludeReason.value.trim();
  if (!reason) return;
  bulkExcludeOpen.value = false;
  await applyScope(selectedVisible.value.map((s) => s.nodeId), "excluded", reason);
  bulkExcludeReason.value = "";
}

/* ------------------------------------------------------------------ */
/* Confirming. One call per node; "confirm all" is that call in a loop, */
/* so a node that fails to confirm is reported on its own.              */
/* ------------------------------------------------------------------ */

const confirming = ref<Set<string>>(new Set());
const confirmingAll = ref(false);

async function confirmNode(nodeId: string): Promise<boolean> {
  if (confirming.value.has(nodeId)) return false;
  confirming.value = new Set(confirming.value).add(nodeId);
  try {
    const res = await api.sshGuard.confirm(nodeId);
    toast.success(t("networking.sshGuard.confirmPlanned", { id: shortId(res.approval.id) }));
    return true;
  } catch (err) {
    toast.error(`${nameOf(nodeId)}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  } finally {
    const next = new Set(confirming.value);
    next.delete(nodeId);
    confirming.value = next;
    approvalsQuery.refresh();
  }
}

async function confirmAllUrgent() {
  if (confirmingAll.value) return;
  confirmingAll.value = true;
  try {
    for (const state of confirmable.value) await confirmNode(state.nodeId);
  } finally {
    confirmingAll.value = false;
  }
}

/* ------------------------------------------------------------------ */
/* The plan sheet. One shared policy, one plan per node, filed in the   */
/* order shown, with the outcome written against each node.             */
/* ------------------------------------------------------------------ */

const sheetOpen = ref(false);
const members = ref<BatchMember[]>([]);
const filing = ref(false);
const fileProgress = reactive({ done: 0, total: 0 });

const form = reactive<GuardForm>(defaultGuardForm());

function resetForm() {
  Object.assign(form, defaultGuardForm());
}

/**
 * The port field. Blank is the keep-current sentinel the model stores as 0;
 * the input never shows a literal 0, which reads as a port number.
 */
const sshPortInput = computed<string | number>({
  get: () => (form.sshPort > 0 ? form.sshPort : ""),
  set: (value) => {
    const n = fieldNumber(value);
    form.sshPort = n !== undefined && n > 0 ? Math.trunc(n) : 0;
  },
});

/**
 * The control-plane host is identified by the address the console was reached
 * on (see controlPlaneNodeIds for why, and for what that misses). A batch of
 * more than one that includes it is refused: if that node's arm strands the
 * operator, nobody is left to confirm the others.
 */
const controlPlane = computed(() => controlPlaneNodeIds(nodesQuery.data.value ?? [], window.location.host));
const controlPlaneMember = computed(() => members.value.find((m) => controlPlane.value.has(m.nodeId)));
const refusal = computed(() => batchRefusal(members.value.map((m) => m.nodeId), controlPlane.value));
const notEnrolledCount = computed(() => members.value.filter((m) => scopeOf(m.nodeId) !== "enrolled").length);
const batch = computed(() => summarizeBatch(members.value));
const anyBlocking = computed(() =>
  members.value.some((m) => m.outcome?.kind === "blocked" && hasBlocking(m.outcome.findings)),
);

const sourceParse = computed(() => parseMgmtSources(form.mgmtSources));
// The policy is validated once for the batch; the node id is per member, so
// the first member stands in. With no members left, node_required is exactly
// the right complaint. The list is shown from the moment the sheet opens: the
// defaults already trip single_way_in, and a disabled "File" button with no
// reason beside it is a dead end.
const policyErrors = computed(() => validateForm({ ...form, nodeId: members.value[0]?.nodeId ?? "" }));

const consequence = computed(() => {
  const count = members.value.length;
  const what = form.sshPort > 0
    ? t("networking.sshGuard.sheet.whatPort", { port: form.sshPort, count }, count)
    : t("networking.sshGuard.sheet.whatNoPort", { count }, count);
  const legacy = form.sshPort > 0
    ? (form.keepLegacyPort ? t("networking.sshGuard.sheet.legacyKeep") : t("networking.sshGuard.sheet.legacyDrop"))
    : "";
  const knock = form.enableKnock ? t("networking.sshGuard.sheet.knockOn") : t("networking.sshGuard.sheet.knockOff");
  const window = formatDuration(form.confirmWindowSec > 0 ? form.confirmWindowSec : DEFAULT_CONFIRM_WINDOW_SEC);
  return `${[what, legacy, knock].filter(Boolean).join(", ")}. ${t("networking.sshGuard.sheet.consequence", { window })}`;
});

const sheetTitle = computed(() =>
  members.value.length === 1
    ? t("networking.sshGuard.sheet.titleOne", { name: members.value[0]?.name ?? "" })
    : t("networking.sshGuard.sheet.titleMany", { count: members.value.length }),
);

function openSheet(nodeIds: string[]) {
  members.value = nodeIds.map((id) => ({ nodeId: id, name: nameOf(id) }));
  resetForm();
  fileProgress.done = 0;
  fileProgress.total = 0;
  sheetOpen.value = true;
}

function removeMember(nodeId: string) {
  if (filing.value) return;
  members.value = members.value.filter((m) => m.nodeId !== nodeId);
}

function setOutcome(nodeId: string, outcome: BatchOutcome) {
  members.value = members.value.map((m) => (m.nodeId === nodeId ? { ...m, outcome } : m));
}

// Findings and the acceptance that went with them belong to the exact policy
// they were computed for. Editing any field that shapes the plan drops the
// refusals and failures, which describe a plan that no longer exists; a filed
// approval is a fact and stays.
watch(
  () => [
    form.sshPort,
    form.keepLegacyPort,
    form.mgmtSources,
    form.enableKnock,
    form.outOfBandFallback,
    form.confirmWindowSec,
    JSON.stringify(form.advanced),
  ],
  () => {
    form.acceptFindings = false;
    members.value = members.value.map((m) => (m.outcome && m.outcome.kind !== "filed" ? { ...m, outcome: undefined } : m));
  },
);

async function fileBatch(retryBlocked: boolean) {
  if (refusal.value || policyErrors.value.length || filing.value) return;
  const todo = membersToFile(members.value, retryBlocked);
  if (!todo.length) return;
  filing.value = true;
  fileProgress.done = 0;
  fileProgress.total = todo.length;
  try {
    // Sequential on purpose: the order is the operator's, and a refusal on
    // the first node is worth seeing before the rest are filed.
    for (const member of todo) {
      const acceptFindings = retryBlocked && form.acceptFindings && member.outcome?.kind === "blocked";
      const request = buildPlanRequest({ ...form, nodeId: member.nodeId, acceptFindings });
      let outcome: BatchOutcome;
      try {
        const res = await api.sshGuard.plan(request);
        outcome = { kind: "filed", approvalId: res.approval.id, findings: res.findings ?? [] };
      } catch (err) {
        // 409 is the lint refusing the plan. It carries the reasons, so show
        // them instead of a generic failure: the operator's next move is to
        // read them.
        if (err instanceof ApiError && err.status === 409) {
          const body = err.body as { findings?: SSHGuardFinding[] } | undefined;
          outcome = { kind: "blocked", findings: body?.findings ?? [] };
        } else {
          outcome = { kind: "failed", error: err instanceof Error ? err.message : String(err) };
        }
      }
      setOutcome(member.nodeId, outcome);
      fileProgress.done += 1;
    }
    const summary = summarizeBatch(members.value);
    const text = t("networking.sshGuard.sheet.summary", { ...summary });
    if (summary.blocked || summary.failed) toast.error(text);
    else toast.success(text);
    approvalsQuery.refresh();
    clearSelection();
  } finally {
    filing.value = false;
  }
}

async function enrolNode(nodeId: string) {
  await applyScope([nodeId], "enrolled");
}

/**
 * Seed from ?node_id=, so a node page can link straight to "harden this one"
 * instead of making the operator find it in a 33-row table. The sheet opens
 * once the fleet is known, so the member has its name.
 */
{
  const seeded = route.query.node_id;
  if (typeof seeded === "string" && seeded) {
    const stop = watch(
      () => nodesQuery.data.value,
      (nodes) => {
        if (!nodes) return;
        openSheet([seeded]);
        stop();
      },
      { immediate: true },
    );
  }
}

/**
 * Failure reasons are one line until asked. A click, or Enter on the focused
 * line, opens the full text in place; the key names the list the line is in.
 */
const expandedReasons = ref<Set<string>>(new Set());
function toggleReason(key: string) {
  const next = new Set(expandedReasons.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  expandedReasons.value = next;
}

const stageTone: Record<BoardStage, "default" | "secondary" | "warning" | "destructive" | "success"> = {
  idle: "secondary",
  armPending: "secondary",
  armApproved: "secondary",
  awaitingConfirm: "warning",
  confirmPending: "warning",
  confirmApproved: "warning",
  confirmed: "success",
  armFailed: "destructive",
  reverted: "destructive",
};

const advancedId = (name: string) => `sshguard-adv-${name}`;
</script>

<template>
  <div class="p-3 sm:p-6 space-y-5">
    <PageHeader
      :title="$t('networking.sshGuard.title')"
      :description="$t('networking.sshGuard.description')"
    >
      <template #actions>
        <!-- Rotation needs the plan request to accept a knock rotation, which
             the server does not yet. The control stays visible so the gap is
             visible; the title says why it is inert. -->
        <Button
          variant="outline"
          disabled
          :title="$t('networking.sshGuard.actions.rotateKnockUnavailable')"
        >
          {{ $t('networking.sshGuard.actions.rotateKnock') }}
        </Button>
        <Button
          :disabled="!canAdmin || !armableSelected.length"
          :title="armableSelected.length ? undefined : $t('networking.sshGuard.actions.armSelectedNone')"
          @click="openSheet(armableSelected.map((s) => s.nodeId))"
        >
          {{ armableSelected.length
            ? $t('networking.sshGuard.actions.armSelectedCount', { count: armableSelected.length })
            : $t('networking.sshGuard.actions.armSelected') }}
        </Button>
      </template>
    </PageHeader>

    <!-- The proof line: what was observed, and the numbers the board is made of. -->
    <p class="font-mono text-xs tabular text-muted-foreground" data-testid="proof-line">{{ proofLine }}</p>

    <!-- The only state with a deadline. It goes first and it is loud. -->
    <section
      v-if="urgent.length"
      class="rounded-md border border-warning bg-warning/5"
      aria-live="polite"
    >
      <div class="flex flex-wrap items-center justify-between gap-3 border-b border-warning/40 px-4 py-3">
        <h2 class="flex items-center gap-2 text-sm font-semibold tracking-[-0.01em]">
          <Timer class="size-4 text-warning" aria-hidden="true" />
          {{ $t('networking.sshGuard.urgent.title', { count: urgent.length }, urgent.length) }}
        </h2>
        <Button
          v-if="confirmable.length > 1"
          size="sm"
          variant="outline"
          :disabled="!canAdmin || confirmingAll || confirming.size > 0"
          @click="confirmAllUrgent"
        >
          {{ confirmable.length === 2
            ? $t('networking.sshGuard.actions.confirmBoth')
            : $t('networking.sshGuard.actions.confirmAll') }}
        </Button>
      </div>
      <p class="px-4 pt-3 text-sm">{{ $t('networking.sshGuard.awaiting.instruction') }}</p>
      <ul class="divide-y divide-warning/30 px-4 pb-1">
        <li
          v-for="state in urgent"
          :key="state.nodeId"
          class="flex flex-wrap items-center gap-x-4 gap-y-1 py-3"
        >
          <div class="min-w-0 flex-1 basis-40">
            <p class="truncate text-sm font-medium" :title="state.nodeId">{{ state.name || state.nodeId }}</p>
            <p class="truncate font-mono text-xs text-muted-foreground">{{ state.nodeId }}</p>
          </div>
          <div
            v-if="revertDeadline(state)"
            class="font-mono text-sm tabular"
            :title="$t('networking.sshGuard.urgent.windowNote', { window: formatDuration(revertDeadline(state)!.windowSec) })"
          >
            <span class="text-xs text-muted-foreground">{{ $t('networking.sshGuard.urgent.revertsIn') }}</span>
            <span class="ml-2 text-base font-semibold text-warning">{{ formatCountdown(revertDeadline(state)!.at - now) }}</span>
            <span class="ml-2 text-xs text-muted-foreground">
              {{ $t('networking.sshGuard.urgent.deadlineAt', { time: formatDateTime(revertDeadline(state)!.at) }) }}
            </span>
          </div>
          <Button
            v-if="state.stage === 'awaitingConfirm'"
            class="shrink-0"
            size="sm"
            variant="outline"
            :disabled="!canAdmin || confirming.has(state.nodeId)"
            @click="confirmNode(state.nodeId)"
          >
            {{ $t('networking.sshGuard.confirmAction') }}
          </Button>
          <Badge v-else class="shrink-0" variant="warning">
            {{ $t(`networking.sshGuard.stageShort.${state.stage}`) }}
          </Badge>
        </li>
      </ul>
    </section>

    <!-- Coverage chips: the filter and the count are the same control, so
         they can never disagree. -->
    <div
      v-if="states.length"
      class="flex flex-wrap gap-1"
      role="group"
      :aria-label="$t('networking.sshGuard.coverage.filterLabel')"
    >
      <button
        v-for="key in COVERAGE_FILTERS"
        :key="key"
        type="button"
        :aria-pressed="coverageFilter === key"
        :title="key === 'reverting' || key === 'armPending' ? $t(`networking.sshGuard.coverage.covers.${key}`) : undefined"
        :class="cn(
          'board-chip inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
          coverageFilter === key
            ? 'border-primary bg-primary/10 text-primary'
            : 'border-border text-muted-foreground hover:bg-muted/40',
        )"
        @click="coverageFilter = key"
      >
        {{ $t(`networking.sshGuard.coverage.filter.${key}`) }}
        <span class="font-mono tabular">{{ counts[key] }}</span>
      </button>
    </div>

    <DataState
      :loading="approvalsQuery.loading.value || nodesQuery.loading.value"
      :error="approvalsQuery.error.value"
      :has-data="approvalsQuery.data.value !== undefined"
      :is-empty="states.length === 0"
      :empty-description="$t('networking.sshGuard.fleet.empty')"
      :skeleton-rows="6"
      @retry="approvalsQuery.refresh"
    >
      <!-- Bulk bar. Present only while something is selected, and it names
           what the action would do rather than how many rows are ticked. -->
      <div
        v-if="selectedVisible.length"
        class="mb-2 flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted px-3 py-2 text-sm"
      >
        <span class="font-medium tabular">
          {{ $t('networking.sshGuard.scope.selected', { count: selectedVisible.length }) }}
        </span>
        <span v-if="bulkRunning" class="text-xs tabular text-muted-foreground">
          {{ $t('networking.sshGuard.scope.bulkProgress', { done: bulkProgress.done, total: bulkProgress.total }) }}
        </span>
        <div class="ms-auto flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" :disabled="!canAdmin || bulkRunning"
            @click="applyScope(selectedVisible.map((s) => s.nodeId), 'enrolled')">
            {{ $t('networking.sshGuard.scope.bulkEnrol') }}
          </Button>
          <Button size="sm" variant="outline" :disabled="!canAdmin || bulkRunning"
            @click="bulkExcludeOpen = true">
            {{ $t('networking.sshGuard.scope.bulkExclude') }}
          </Button>
          <Button size="sm" variant="ghost" :disabled="bulkRunning" @click="clearSelection">
            {{ $t('networking.sshGuard.scope.clearSelection') }}
          </Button>
        </div>
        <ul v-if="scopeFailures.length" class="basis-full space-y-0.5 text-xs text-destructive">
          <li v-for="f in scopeFailures" :key="f.nodeId" class="truncate font-mono" :title="f.error">
            {{ nameOf(f.nodeId) }}: {{ f.error }}
          </li>
        </ul>
      </div>

      <p v-if="!visibleStates.length" class="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
        {{ $t('networking.sshGuard.coverage.emptyFilter') }}
      </p>

      <!-- The table scrolls sideways inside itself at narrow widths and keeps
           the node column pinned; the page stays the only vertical scroller. -->
      <div v-else class="overflow-x-auto rounded-md border border-border">
        <table class="w-full border-collapse text-sm">
          <thead class="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th scope="col" class="sticky left-0 z-10 bg-background px-2 py-2 text-left font-medium max-sm:w-[8.5rem]">
                <span class="flex items-center gap-2">
                  <Checkbox
                    :model-value="allVisibleSelected"
                    :aria-label="$t('networking.sshGuard.table.selectAllInFilter')"
                    @update:model-value="(v) => toggleSelectAllVisible(v === true)"
                  />
                  {{ $t('networking.sshGuard.table.node') }}
                </span>
              </th>
              <th scope="col" class="px-2 py-2 text-left font-medium">{{ $t('networking.sshGuard.table.stage') }}</th>
              <th scope="col" class="px-2 py-2 text-left font-medium whitespace-nowrap">{{ $t('networking.sshGuard.table.sshdNow') }}</th>
              <th scope="col" class="px-2 py-2 text-left font-medium">
                <span class="cursor-help underline decoration-dotted underline-offset-4" :title="$t('networking.sshGuard.table.passwordTitle')">{{ $t('networking.sshGuard.table.password') }}</span>
              </th>
              <!-- Knock state is not in the snapshot. The reason is printed
                   once, here, instead of on every row. -->
              <th scope="col" class="px-2 py-2 text-left font-medium">
                <span class="cursor-help underline decoration-dotted underline-offset-4" :title="$t('networking.sshGuard.table.notReportedTitle')">{{ $t('networking.sshGuard.table.knock') }}</span>
              </th>
              <th scope="col" class="px-2 py-2 text-left font-medium">{{ $t('networking.sshGuard.table.observed') }}</th>
              <th scope="col" class="px-2 py-2 text-right font-medium">{{ $t('networking.sshGuard.table.actions') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="state in visibleStates"
              :key="state.nodeId"
              :aria-selected="selectedNodes.has(state.nodeId)"
              class="group/row board-row h-10 border-t border-border"
              :class="selectedNodes.has(state.nodeId) ? 'bg-primary/5' : 'hover:bg-muted/30'"
            >
              <td
                class="sticky left-0 z-10 bg-background px-2 py-1 max-sm:w-[8.5rem]"
                :class="selectedNodes.has(state.nodeId) ? 'shadow-[inset_2px_0_0_var(--primary)]' : ''"
              >
                <div class="flex items-center gap-2">
                  <Checkbox
                    :model-value="selectedNodes.has(state.nodeId)"
                    :aria-label="$t('networking.sshGuard.scope.selectRow', { node: state.name || state.nodeId })"
                    @click="(e: MouseEvent) => toggleRow(state.nodeId, e)"
                    @update:model-value="() => {}"
                  />
                  <div class="min-w-0 max-sm:w-24">
                    <p class="truncate font-medium max-sm:text-xs" :title="state.name ? `${state.name} (${state.nodeId})` : state.nodeId">
                      {{ state.name || state.nodeId }}
                    </p>
                    <p v-if="state.name" class="truncate font-mono text-[11px] text-muted-foreground max-sm:hidden">{{ state.nodeId }}</p>
                  </div>
                </div>
              </td>

              <td class="px-2 py-1 align-top">
                <!-- Narrow by default at phone width so the table stays compact;
                     an opened reason gets the room to be read. -->
                <div :class="expandedReasons.has(`row:${state.nodeId}`) ? 'max-sm:w-64' : 'max-sm:w-24'">
                <Badge
                  class="whitespace-nowrap"
                  :variant="stageTone[stageOf(state)]"
                  :title="$t(`networking.sshGuard.stage.${stageOf(state)}`)"
                >
                  {{ $t(`networking.sshGuard.stageShort.${stageOf(state)}`) }}
                </Badge>
                <!-- The refusal, in the server's words, where the badge used to
                     say "did not go through". One line until asked; the button
                     opens the full text in place, by click or by Enter. -->
                <button
                  v-if="armFailureText(state)"
                  type="button"
                  class="reason-toggle mt-1 block max-w-[18rem] text-left font-mono text-[11px] text-destructive"
                  :class="expandedReasons.has(`row:${state.nodeId}`) ? 'whitespace-pre-wrap break-words' : 'truncate max-sm:max-w-24'"
                  :aria-expanded="expandedReasons.has(`row:${state.nodeId}`)"
                  :title="expandedReasons.has(`row:${state.nodeId}`) ? $t('networking.sshGuard.table.reasonCollapse') : $t('networking.sshGuard.table.reasonExpand')"
                  @click="toggleReason(`row:${state.nodeId}`)"
                >{{ expandedReasons.has(`row:${state.nodeId}`) ? armFailureText(state)!.full : armFailureText(state)!.line }}</button>
                <!-- A refusal is not a failure: the plan never reached the box. -->
                <p
                  v-else-if="armRejection(state)"
                  class="mt-1 text-[11px] text-muted-foreground"
                  :title="$t('networking.sshGuard.table.rejectedByTitle', { summary: state.arm?.reason || '' })"
                >
                  {{ $t('networking.sshGuard.table.rejectedBy', { time: formatDateTime(armRejection(state)!.at) }) }}
                </p>
                <!-- A closed window: when it closed, where a failure prints its reason. -->
                <p
                  v-else-if="stageOf(state) === 'reverted'"
                  class="mt-1 font-mono text-[11px] text-destructive"
                >
                  {{ $t('networking.sshGuard.table.windowPassedAt', { time: formatDateTime(revertDeadline(state)!.at) }) }}
                </p>
                <p
                  v-else-if="scopeOf(state.nodeId) !== 'enrolled' && state.stage === 'idle'"
                  class="mt-1 text-[11px] text-muted-foreground"
                >
                  {{ scopeOf(state.nodeId) === 'excluded'
                    ? $t('networking.sshGuard.table.scopeExcluded')
                    : $t('networking.sshGuard.table.scopeUndecided') }}
                </p>
                </div>
              </td>

              <!-- SSHD NOW: a claim from the node's own report, or an honest
                   reason there is none. Never a status word. -->
              <td class="px-2 py-1 align-top font-mono text-xs tabular whitespace-nowrap max-sm:text-[11px]">
                <template v-if="evidence.get(state.nodeId)?.sshd">
                  <span v-if="evidence.get(state.nodeId)!.sshd!.kind === 'none'" class="text-muted-foreground" :title="$t('networking.sshGuard.table.noSshdTitle')">
                    {{ $t('networking.sshGuard.table.noSshd') }}
                  </span>
                  <span v-else :class="evidence.get(state.nodeId)!.sshd!.kind === 'legacy' ? 'text-warning' : ''">
                    {{ evidence.get(state.nodeId)!.sshd!.text }}
                  </span>
                </template>
                <span v-else-if="!canReadReality" class="text-muted-foreground" :title="$t('networking.sshGuard.table.noAccessTitle')">
                  {{ $t('networking.sshGuard.table.noAccess') }}
                </span>
                <span v-else-if="evidence.get(state.nodeId)?.status === 'unknown'" class="text-muted-foreground" :title="$t('networking.sshGuard.table.noSnapshotTitle')">
                  {{ $t('networking.sshGuard.table.noSnapshot') }}
                </span>
                <span v-else class="text-muted-foreground">{{ $t('networking.sshGuard.table.reading') }}</span>
              </td>

              <!-- PASSWORD: PasswordAuthentication as the node's own sshd -T
                   printed it. "on" is the finding this board exists for, so it
                   is the one value with a colour. A snapshot past its freshness
                   says so beside the value rather than printing an age alone:
                   a stale "off" is a claim about the past. -->
              <td class="px-2 py-1 align-top font-mono text-xs tabular whitespace-nowrap max-sm:text-[11px]">
                <template v-if="evidence.get(state.nodeId)?.password">
                  <span
                    :class="evidence.get(state.nodeId)!.password!.enabled ? 'text-warning' : ''"
                    :title="$t('networking.sshGuard.table.passwordObserved', { time: formatDateTime(evidence.get(state.nodeId)!.password!.observedAt) })"
                  >{{ evidence.get(state.nodeId)!.password!.enabled ? $t('networking.sshGuard.table.passwordOn') : $t('networking.sshGuard.table.passwordOff') }}</span>
                  <span
                    v-if="evidence.get(state.nodeId)!.status === 'stale'"
                    class="ml-1 text-warning"
                    :title="$t('networking.sshGuard.table.staleTitle')"
                  >{{ $t('networking.sshGuard.table.staleSince', { time: formatDateTime(evidence.get(state.nodeId)!.staleSince) }) }}</span>
                </template>
                <span
                  v-else-if="evidence.get(state.nodeId)?.sshd"
                  class="text-muted-foreground"
                  :title="evidence.get(state.nodeId)!.sshdNote || $t('networking.sshGuard.table.passwordNotReportedTitle')"
                >{{ $t('networking.sshGuard.table.notReported') }}</span>
                <span v-else-if="!canReadReality" class="text-muted-foreground" :title="$t('networking.sshGuard.table.noAccessTitle')">
                  {{ $t('networking.sshGuard.table.noAccess') }}
                </span>
                <span v-else-if="evidence.get(state.nodeId)?.status === 'unknown'" class="text-muted-foreground" :title="$t('networking.sshGuard.table.noSnapshotTitle')">
                  {{ $t('networking.sshGuard.table.noSnapshot') }}
                </span>
                <span v-else class="text-muted-foreground">{{ $t('networking.sshGuard.table.reading') }}</span>
              </td>

              <!-- KNOCK is not in the snapshot either, but the control plane
                   does not need the node to tell it: the arm plan it filed is
                   the record of the sequence. So this cell reports what the
                   control plane knows rather than what the agent reports, and
                   never leaves the question unanswered. -->
              <td class="px-2 py-1 align-top text-xs whitespace-nowrap">
                <button
                  type="button"
                  class="reason-toggle text-left underline-offset-4 hover:underline"
                  :class="knockCell(state).muted ? 'text-muted-foreground' : 'text-foreground'"
                  :title="knockCell(state).title"
                  @click="openKnock(state.nodeId)"
                >
                  {{ knockCell(state).text }}
                </button>
              </td>

              <td class="px-2 py-1 align-top font-mono text-xs tabular whitespace-nowrap">
                <template v-if="evidence.get(state.nodeId)?.collectedAt">
                  <span :title="formatDateTime(evidence.get(state.nodeId)!.collectedAt)">
                    {{ $t('networking.sshGuard.table.ago', { age: formatAge(now - Date.parse(evidence.get(state.nodeId)!.collectedAt!)) }) }}
                  </span>
                  <span
                    v-if="evidence.get(state.nodeId)!.status === 'stale'"
                    class="ml-1 text-warning"
                    :title="$t('networking.sshGuard.table.staleTitle')"
                  >{{ $t('networking.sshGuard.table.stale') }}</span>
                </template>
                <span v-else class="text-muted-foreground">{{ canReadReality ? $t('networking.sshGuard.table.noSnapshot') : $t('networking.sshGuard.table.noAccess') }}</span>
              </td>

              <td class="px-2 py-1 text-right align-top whitespace-nowrap">
                <span class="inline-flex items-center justify-end gap-1">
                  <!-- Past the window the Confirm stays where it was, disabled,
                       with the reason: the revert already ran and there is
                       nothing left to cancel. A control that vanished would
                       leave the operator wondering where it went. -->
                  <span
                    v-if="state.stage === 'awaitingConfirm'"
                    :title="stageOf(state) === 'reverted'
                      ? $t('networking.sshGuard.table.confirmReverted', { time: formatDateTime(revertDeadline(state)!.at) })
                      : undefined"
                  >
                    <Button
                      size="sm"
                      variant="outline"
                      :disabled="!canAdmin || confirming.has(state.nodeId) || stageOf(state) === 'reverted'"
                      @click="confirmNode(state.nodeId)"
                    >
                      {{ $t('networking.sshGuard.confirmAction') }}
                    </Button>
                  </span>
                  <RouterLink
                    v-else-if="state.actionableApprovalId"
                    :to="{ path: '/approvals', query: { selected: state.actionableApprovalId } }"
                    class="row-action font-mono text-xs text-primary underline-offset-4 hover:underline"
                    :title="$t('networking.sshGuard.actions.openApproval', { id: state.actionableApprovalId })"
                  >
                    {{ $t('networking.sshGuard.table.awaitingApproval') }} {{ shortId(state.actionableApprovalId) }}
                  </RouterLink>
                  <Button
                    v-else-if="state.stage === 'idle' && scopeOf(state.nodeId) === 'undecided'"
                    class="row-action"
                    size="sm"
                    variant="outline"
                    :disabled="!canAdmin || bulkRunning"
                    @click="enrolNode(state.nodeId)"
                  >
                    {{ $t('networking.sshGuard.actions.enrol') }}
                  </Button>
                  <Button
                    v-if="isArmable(state)"
                    class="row-action"
                    size="sm"
                    variant="outline"
                    :disabled="!canAdmin"
                    @click="openSheet([state.nodeId])"
                  >
                    {{ $t('networking.sshGuard.actions.arm') }}
                  </Button>
                  <!-- Always present when a sequence is known, including on a
                       confirmed node with nothing else to do. That row is
                       exactly the one an operator opens when he cannot get in. -->
                  <Button
                    v-if="knockKnowledgeFor(state) === 'installed'"
                    class="row-action"
                    size="sm"
                    variant="ghost"
                    :title="$t('networking.sshGuard.knock.openFor', { node: state.name || state.nodeId })"
                    @click="openKnock(state.nodeId)"
                  >
                    <KeyRound class="size-4" aria-hidden="true" />
                    <span class="sr-only">{{ $t('networking.sshGuard.knock.openFor', { node: state.name || state.nodeId }) }}</span>
                  </Button>
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </DataState>

    <!-- The plan sheet. Full screen at phone width; a wide dialog otherwise. -->
    <Dialog v-model:open="sheetOpen">
      <!-- self-start at phone width: the overlay centres its grid item, and an
           item taller than the viewport centred in a scroll container overflows
           above the top, where no scroll can reach it. -->
      <DialogScrollContent class="sm:max-w-2xl max-sm:my-0 max-sm:min-h-dvh max-sm:max-w-none max-sm:self-start max-sm:rounded-none max-sm:border-0">
        <DialogHeader>
          <DialogTitle class="tracking-[-0.02em]">{{ sheetTitle }}</DialogTitle>
          <DialogDescription>{{ consequence }}</DialogDescription>
        </DialogHeader>

        <div class="space-y-5">
          <!-- The batch, in filing order, with each node's outcome against it. -->
          <section class="space-y-2">
            <h3 class="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {{ $t('networking.sshGuard.sheet.nodes') }}
            </h3>
            <p
              v-if="refusal === 'control_plane_in_batch' && controlPlaneMember"
              class="rounded-md border border-destructive/50 bg-destructive/5 px-3 py-2 text-sm text-destructive"
            >
              {{ $t('networking.sshGuard.sheet.controlPlaneRefused', { name: controlPlaneMember.name }) }}
            </p>
            <p
              v-if="notEnrolledCount"
              class="rounded-md border border-warning/50 bg-warning/5 px-3 py-2 text-sm"
            >
              {{ $t('networking.sshGuard.sheet.notEnrolled', { count: notEnrolledCount }, notEnrolledCount) }}
            </p>
            <ul class="divide-y divide-border rounded-md border border-border">
              <li
                v-for="member in members"
                :key="member.nodeId"
                class="px-3 py-2"
                :class="member.outcome?.kind === 'failed' || member.outcome?.kind === 'blocked' ? 'bg-destructive/5' : ''"
              >
                <div class="flex flex-wrap items-center gap-3">
                  <div class="min-w-0 flex-1">
                    <p class="truncate text-sm font-medium">{{ member.name }}</p>
                    <p class="truncate font-mono text-[11px] text-muted-foreground">{{ member.nodeId }}</p>
                  </div>
                  <span
                    v-if="member.outcome?.kind === 'filed'"
                    class="font-mono text-xs text-success"
                  >
                    <RouterLink
                      :to="{ path: '/approvals', query: { selected: member.outcome.approvalId } }"
                      class="underline-offset-4 hover:underline"
                    >{{ $t('networking.sshGuard.sheet.outcomeFiled', { id: shortId(member.outcome.approvalId) }) }}</RouterLink>
                  </span>
                  <span v-else-if="member.outcome?.kind === 'blocked'" class="font-mono text-xs text-destructive">
                    {{ $t('networking.sshGuard.sheet.outcomeBlocked') }}
                  </span>
                  <button
                    v-else-if="member.outcome?.kind === 'failed'"
                    type="button"
                    class="reason-toggle min-w-0 text-left font-mono text-xs text-destructive"
                    :class="expandedReasons.has(`outcome:${member.nodeId}`) ? 'basis-full whitespace-pre-wrap break-words' : 'max-w-[14rem] truncate'"
                    :aria-expanded="expandedReasons.has(`outcome:${member.nodeId}`)"
                    :title="expandedReasons.has(`outcome:${member.nodeId}`) ? $t('networking.sshGuard.table.reasonCollapse') : $t('networking.sshGuard.table.reasonExpand')"
                    @click="toggleReason(`outcome:${member.nodeId}`)"
                  >{{ $t('networking.sshGuard.sheet.outcomeFailed') }}: {{ member.outcome.error }}</button>
                  <span v-else-if="fileProgress.total" class="font-mono text-xs text-muted-foreground">
                    {{ $t('networking.sshGuard.sheet.outcomePending') }}
                  </span>
                  <Button
                    v-if="!member.outcome && members.length > 1"
                    size="icon-sm"
                    variant="ghost"
                    :disabled="filing"
                    :aria-label="$t('networking.sshGuard.sheet.remove', { name: member.name })"
                    :title="$t('networking.sshGuard.sheet.remove', { name: member.name })"
                    @click="removeMember(member.nodeId)"
                  >
                    <X aria-hidden="true" />
                  </Button>
                </div>
                <!-- Findings from the pre-check, per node, sorted blocking first. -->
                <ul
                  v-if="member.outcome && member.outcome.kind !== 'failed' && member.outcome.findings.length"
                  class="mt-2 space-y-1"
                >
                  <li
                    v-for="finding in sortFindings(member.outcome.findings)"
                    :key="finding.code"
                    class="flex items-start gap-2 text-xs"
                  >
                    <Badge class="mt-px shrink-0" :variant="finding.severity === 'block' ? 'destructive' : 'warning'">
                      {{ finding.severity }}
                    </Badge>
                    <span class="min-w-0">
                      <code class="font-mono">{{ finding.code }}</code>
                      <span class="ml-1 text-muted-foreground">{{ finding.message }}</span>
                    </span>
                  </li>
                </ul>
              </li>
            </ul>
            <label v-if="anyBlocking" class="flex items-start gap-3 text-sm">
              <Checkbox class="mt-0.5" :model-value="form.acceptFindings" :disabled="!canAdmin || filing"
                @update:model-value="(v) => (form.acceptFindings = v === true)" />
              <span class="space-y-1">
                <span class="block font-medium">{{ $t('networking.sshGuard.sheet.acceptAll') }}</span>
                <span class="block text-muted-foreground">{{ $t('networking.sshGuard.findings.acceptHint') }}</span>
              </span>
            </label>
          </section>

          <!-- The shared policy. -->
          <section class="space-y-4">
            <h3 class="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {{ $t('networking.sshGuard.sheet.policy') }}
            </h3>
            <div class="grid gap-4 sm:grid-cols-2">
              <div class="grid gap-1.5">
                <Label for="sshguard-port">{{ $t('networking.sshGuard.fields.sshPort') }}</Label>
                <Input id="sshguard-port" v-model="sshPortInput" type="number" min="1" max="65535" :placeholder="$t('networking.sshGuard.fields.sshPortKeep')" :disabled="!canAdmin || filing" />
                <p class="text-xs text-muted-foreground">{{ $t('networking.sshGuard.fields.sshPortHint') }}</p>
              </div>
              <div class="grid gap-1.5">
                <Label for="sshguard-window">{{ $t('networking.sshGuard.fields.window') }}</Label>
                <Input id="sshguard-window" v-model.number="form.confirmWindowSec" type="number" min="120" max="3600" :disabled="!canAdmin || filing" />
                <p class="text-xs text-muted-foreground">{{ $t('networking.sshGuard.fields.windowHint') }}</p>
              </div>
            </div>

            <div class="grid gap-1.5">
              <Label for="sshguard-sources">{{ $t('networking.sshGuard.fields.mgmtSources') }}</Label>
              <Input id="sshguard-sources" v-model="form.mgmtSources" :disabled="!canAdmin || filing"
                :placeholder="$t('networking.sshGuard.fields.mgmtSourcesPlaceholder')" />
              <p class="text-xs text-muted-foreground">{{ $t('networking.sshGuard.fields.mgmtSourcesHint') }}</p>
              <p v-if="sourceParse.invalid.length" class="text-xs text-destructive">
                {{ $t('networking.sshGuard.fields.mgmtSourcesInvalid', { values: sourceParse.invalid.join(', ') }) }}
              </p>
            </div>

            <div class="grid gap-3 sm:grid-cols-3">
              <label class="flex items-start gap-3 text-sm">
                <Checkbox class="mt-0.5" :model-value="form.keepLegacyPort" :disabled="!canAdmin || filing"
                  @update:model-value="(v) => (form.keepLegacyPort = v === true)" />
                <span class="space-y-1">
                  <span class="block font-medium">{{ $t('networking.sshGuard.fields.keepLegacy') }}</span>
                  <span class="block text-xs text-muted-foreground">{{ $t('networking.sshGuard.fields.keepLegacyHint') }}</span>
                </span>
              </label>
              <label class="flex items-start gap-3 text-sm">
                <Checkbox class="mt-0.5" :model-value="form.enableKnock" :disabled="!canAdmin || filing"
                  @update:model-value="(v) => (form.enableKnock = v === true)" />
                <span class="space-y-1">
                  <span class="block font-medium">{{ $t('networking.sshGuard.fields.knock') }}</span>
                  <span class="block text-xs text-muted-foreground">{{ $t('networking.sshGuard.fields.knockHint') }}</span>
                </span>
              </label>
              <label class="flex items-start gap-3 text-sm">
                <Checkbox class="mt-0.5" :model-value="form.outOfBandFallback" :disabled="!canAdmin || filing"
                  @update:model-value="(v) => (form.outOfBandFallback = v === true)" />
                <span class="space-y-1">
                  <span class="block font-medium">{{ $t('networking.sshGuard.fields.fallback') }}</span>
                  <span class="block text-xs text-muted-foreground">{{ $t('networking.sshGuard.fields.fallbackHint') }}</span>
                </span>
              </label>
            </div>
          </section>

          <!-- Advanced: the eight overrides the server accepts. Placeholders
               are the verified defaults; blank sends nothing. -->
          <details class="group rounded-md border border-border" data-testid="advanced">
            <summary class="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm font-medium select-none">
              <ChevronRight class="advanced-chevron size-4 group-open:rotate-90" aria-hidden="true" />
              {{ $t('networking.sshGuard.sheet.advanced') }}
            </summary>
            <div v-if="form.advanced" class="space-y-4 border-t border-border px-3 py-3">
              <p class="text-xs text-muted-foreground">{{ $t('networking.sshGuard.sheet.advancedHint') }}</p>
              <div class="grid gap-4 sm:grid-cols-2">
                <div class="grid gap-1.5">
                  <Label :for="advancedId('gate')">{{ $t('networking.sshGuard.advancedFields.gatePorts') }}</Label>
                  <Input :id="advancedId('gate')" v-model="form.advanced.gatePorts" class="font-mono" :disabled="!canAdmin || filing"
                    :placeholder="$t('networking.sshGuard.advancedFields.gatePortsPlaceholder')" />
                  <p class="text-xs text-muted-foreground">{{ $t('networking.sshGuard.advancedFields.gatePortsHint') }}</p>
                </div>
                <div class="grid gap-1.5">
                  <Label :for="advancedId('knock')">{{ $t('networking.sshGuard.advancedFields.knockPorts') }}</Label>
                  <Input :id="advancedId('knock')" v-model="form.advanced.knockPorts" class="font-mono" :disabled="!canAdmin || filing"
                    :placeholder="$t('networking.sshGuard.advancedFields.knockPortsPlaceholder')" />
                  <p class="text-xs text-muted-foreground">{{ $t('networking.sshGuard.advancedFields.knockPortsHint') }}</p>
                </div>
                <div class="grid gap-1.5">
                  <Label :for="advancedId('open')">{{ $t('networking.sshGuard.advancedFields.knockOpenFor') }}</Label>
                  <select
                    :id="advancedId('open')"
                    v-model="form.advanced.knockOpenFor"
                    class="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
                    :disabled="!canAdmin || filing"
                  >
                    <option value="">{{ $t('networking.sshGuard.advancedFields.serverDefault') }} ({{ ADVANCED_DEFAULTS.knockOpenFor }})</option>
                    <option v-for="v in KNOCK_OPEN_FOR_VALUES" :key="v" :value="v">{{ v }}</option>
                  </select>
                  <p class="text-xs text-muted-foreground">{{ $t('networking.sshGuard.advancedFields.knockOpenForHint') }}</p>
                </div>
                <div class="grid gap-1.5">
                  <Label :for="advancedId('seq')">{{ $t('networking.sshGuard.advancedFields.knockSeqTimeout') }}</Label>
                  <Input :id="advancedId('seq')" v-model="form.advanced.knockSeqTimeoutSec" type="number" min="3" max="120" :disabled="!canAdmin || filing"
                    :placeholder="String(ADVANCED_DEFAULTS.knockSeqTimeoutSec)" />
                  <p class="text-xs text-muted-foreground">{{ $t('networking.sshGuard.advancedFields.knockSeqTimeoutHint') }}</p>
                </div>
                <div class="grid gap-1.5">
                  <Label :for="advancedId('grace')">{{ $t('networking.sshGuard.advancedFields.loginGrace') }}</Label>
                  <Input :id="advancedId('grace')" v-model="form.advanced.loginGraceTimeSec" type="number" min="5" max="600" :disabled="!canAdmin || filing"
                    :placeholder="String(ADVANCED_DEFAULTS.loginGraceTimeSec)" />
                  <p class="text-xs text-muted-foreground">{{ $t('networking.sshGuard.advancedFields.loginGraceHint') }}</p>
                </div>
                <div class="grid gap-1.5">
                  <Label :for="advancedId('tries')">{{ $t('networking.sshGuard.advancedFields.maxAuthTries') }}</Label>
                  <Input :id="advancedId('tries')" v-model="form.advanced.maxAuthTries" type="number" min="1" max="10" :disabled="!canAdmin || filing"
                    :placeholder="String(ADVANCED_DEFAULTS.maxAuthTries)" />
                  <p class="text-xs text-muted-foreground">{{ $t('networking.sshGuard.advancedFields.maxAuthTriesHint') }}</p>
                </div>
                <div class="grid gap-1.5">
                  <Label :for="advancedId('startups')">{{ $t('networking.sshGuard.advancedFields.maxStartups') }}</Label>
                  <Input :id="advancedId('startups')" v-model="form.advanced.maxStartups" class="font-mono" :disabled="!canAdmin || filing"
                    :placeholder="ADVANCED_DEFAULTS.maxStartups" />
                  <p class="text-xs text-muted-foreground">{{ $t('networking.sshGuard.advancedFields.maxStartupsHint') }}</p>
                </div>
                <div class="grid gap-1.5">
                  <Label :for="advancedId('root')">{{ $t('networking.sshGuard.advancedFields.permitRootLogin') }}</Label>
                  <select
                    :id="advancedId('root')"
                    v-model="form.advanced.permitRootLogin"
                    class="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
                    :disabled="!canAdmin || filing"
                  >
                    <option value="">{{ $t('networking.sshGuard.advancedFields.serverDefault') }} ({{ ADVANCED_DEFAULTS.permitRootLogin }})</option>
                    <option v-for="v in PERMIT_ROOT_LOGIN_VALUES" :key="v" :value="v">{{ v }}</option>
                  </select>
                  <p class="text-xs text-muted-foreground">{{ $t('networking.sshGuard.advancedFields.permitRootLoginHint') }}</p>
                </div>
              </div>
            </div>
          </details>

          <ul v-if="policyErrors.length" class="space-y-1 text-xs text-destructive">
            <li v-for="code in policyErrors" :key="code">{{ $t(`networking.sshGuard.errors.${code}`) }}</li>
          </ul>

          <!-- What pressing the button calls, so an agent reading the screen
               can do the same thing. -->
          <p class="font-mono text-[11px] text-muted-foreground">{{ $t('networking.sshGuard.sheet.method') }}</p>
        </div>

        <DialogFooter class="gap-2 sm:items-center">
          <span v-if="filing" class="me-auto font-mono text-xs tabular text-muted-foreground">
            {{ $t('networking.sshGuard.sheet.filing', { done: fileProgress.done, total: fileProgress.total }) }}
          </span>
          <span v-else-if="fileProgress.total" class="me-auto font-mono text-xs tabular" :class="batch.blocked || batch.failed ? 'text-destructive' : 'text-success'">
            {{ $t('networking.sshGuard.sheet.summary', { ...batch }) }}
          </span>
          <Button type="button" variant="outline" :disabled="filing" @click="sheetOpen = false">
            {{ fileProgress.total ? $t('common.actions.close') : $t('common.actions.cancel') }}
          </Button>
          <Button
            v-if="batch.blocked && anyBlocking"
            type="button"
            variant="destructive"
            :disabled="!canAdmin || filing || !form.acceptFindings || !!refusal || policyErrors.length > 0"
            @click="fileBatch(true)"
          >
            {{ $t('networking.sshGuard.sheet.retryBlocked', { count: batch.blocked }) }}
          </Button>
          <Button
            v-if="batch.pending"
            type="button"
            :disabled="!canAdmin || filing || !!refusal || policyErrors.length > 0"
            @click="fileBatch(false)"
          >
            {{ $t('networking.sshGuard.sheet.file', { count: batch.pending }, batch.pending) }}
          </Button>
        </DialogFooter>
      </DialogScrollContent>
    </Dialog>

    <!-- Bulk exclude. One reason for the whole selection, because that is how
         these decisions are actually made: "the NAT boxes, because no exposed
         port". -->
    <Dialog v-model:open="bulkExcludeOpen">
      <DialogScrollContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {{ $t('networking.sshGuard.scope.bulkExcludeTitle', { count: selectedVisible.length }) }}
          </DialogTitle>
          <DialogDescription>{{ $t('networking.sshGuard.scope.bulkExcludeDescription') }}</DialogDescription>
        </DialogHeader>
        <div class="grid gap-1.5">
          <Label for="bulk-exclude-reason">{{ $t('networking.sshGuard.scope.reason') }}</Label>
          <Input
            id="bulk-exclude-reason"
            v-model="bulkExcludeReason"
            :placeholder="$t('networking.sshGuard.scope.reasonPlaceholder')"
            @keydown.enter.prevent="confirmBulkExclude"
          />
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" @click="bulkExcludeOpen = false">
            {{ $t('common.actions.cancel') }}
          </Button>
          <Button
            type="button"
            variant="destructive"
            :disabled="!bulkExcludeReason.trim() || bulkRunning"
            @click="confirmBulkExclude"
          >
            {{ $t('networking.sshGuard.scope.bulkExclude') }}
          </Button>
        </DialogFooter>
      </DialogScrollContent>
    </Dialog>
  </div>

    <!-- The knock sequence.

         The whole point of this dialog is that it always says something. Even
         with no sequence to show it states which of the four cases this node
         is in, because the version of this page that said nothing is what sent
         an operator to read the sequence out of an operations note. -->
    <Dialog v-model:open="knockOpen">
      <DialogScrollContent class="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{{ $t('networking.sshGuard.knock.title') }}</DialogTitle>
          <DialogDescription>{{ $t('networking.sshGuard.knock.description') }}</DialogDescription>
        </DialogHeader>

        <div class="space-y-4">
          <p class="font-mono text-xs tabular text-muted-foreground">{{ knockNodeName }}</p>

          <p v-if="!canAdmin" class="rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
            {{ $t('networking.sshGuard.knock.noScope') }}
          </p>

          <template v-else>
            <p v-if="knockLoading" class="text-xs text-muted-foreground">{{ $t('networking.sshGuard.table.reading') }}</p>
            <p v-else-if="knockError" class="text-xs text-destructive">{{ knockError }}</p>

            <template v-else-if="knockState">
              <!-- The server's own sentence, verbatim and once, so the page and
                   the API cannot describe the same node differently. It carries
                   the revert caveat itself, so this styles it as a warning
                   rather than repeating it underneath. -->
              <p
                :class="knockUnconfirmed
                  ? 'rounded-md border border-warning/40 bg-warning/5 p-3 text-sm text-warning'
                  : 'text-sm text-foreground'"
              >
                {{ knockState.note }}
              </p>

              <p v-if="knockState.plan_unreadable" class="text-xs text-warning">
                {{ $t('networking.sshGuard.knock.unreadable') }}
              </p>

              <!-- Shape without secret: enough to plan the attempt (how many
                   datagrams, how fast, how long the door stays open) and not
                   enough to narrow a guess at the ports. -->
              <p v-if="knockState.port_count" class="font-mono text-xs tabular text-muted-foreground">
                {{ $t('networking.sshGuard.knock.shape', {
                  count: knockState.port_count,
                  seconds: knockState.seq_timeout_sec ?? 0,
                  openFor: knockState.open_for ?? '',
                }) }}
                <span v-if="knockState.ssh_port"> · {{ $t('networking.sshGuard.knock.sshPort', { port: knockState.ssh_port }) }}</span>
              </p>

              <div v-if="knockState.revealable" class="space-y-3">
                <Button variant="outline" size="sm" :disabled="knockRevealing" @click="revealKnock">
                  <RefreshCw v-if="knockRevealing" class="size-4 animate-spin" aria-hidden="true" />
                  <KeyRound v-else class="size-4" aria-hidden="true" />
                  {{ knockRevealed ? $t('networking.sshGuard.knock.hide') : $t('networking.sshGuard.knock.reveal') }}
                </Button>

                <div v-if="knockRevealed" class="space-y-3 rounded-md border border-warning/40 bg-warning/5 p-3">
                  <p class="inline-flex items-center gap-1 text-xs text-muted-foreground">
                    <Lock class="size-3.5" aria-hidden="true" />
                    {{ $t('networking.sshGuard.knock.revealed') }}
                  </p>

                  <div>
                    <p class="mb-1 text-xs text-muted-foreground">{{ $t('networking.sshGuard.knock.sequenceLabel') }}</p>
                    <!-- Selectable text, not only a copy button: a browser can
                         refuse the clipboard, and an operator who is locked out
                         must still be able to read the value off the screen. -->
                    <code class="block break-all font-mono text-sm tabular text-foreground">{{ knockRevealed.ports.join(' ') }}</code>
                  </div>

                  <div>
                    <div class="mb-1 flex items-center justify-between gap-2">
                      <p class="text-xs text-muted-foreground">{{ $t('networking.sshGuard.knock.commandLabel') }}</p>
                      <CopyButton :value="knockRevealed.command" :label="$t('networking.sshGuard.knock.copyCommand')" />
                    </div>
                    <pre class="max-h-40 overflow-auto rounded bg-background/70 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all">{{ knockRevealed.command }}</pre>
                  </div>

                  <p class="text-xs text-muted-foreground">{{ $t('networking.sshGuard.knock.sameSource') }}</p>
                  <p class="text-xs text-muted-foreground">{{ $t('networking.sshGuard.knock.payloadNote') }}</p>
                </div>
              </div>

              <p class="text-xs text-muted-foreground">{{ $t('networking.sshGuard.knock.agentNote') }}</p>
            </template>
          </template>
        </div>

        <DialogFooter>
          <Button variant="outline" @click="knockOpen = false">{{ $t('common.actions.close') }}</Button>
        </DialogFooter>
      </DialogScrollContent>
    </Dialog>

    <!-- Second factor for the reveal. Same ceremony as the task-script reveal,
         because it discloses the same class of thing. -->
    <Dialog v-model:open="knockStepUpOpen">
      <DialogScrollContent class="sm:max-w-md" @escape-key-down.prevent="knockStepUp.cancel">
        <DialogHeader>
          <DialogTitle>{{ $t('networking.sshGuard.knock.stepUp.title') }}</DialogTitle>
          <DialogDescription>{{ $t('networking.sshGuard.knock.stepUp.description') }}</DialogDescription>
        </DialogHeader>
        <form class="space-y-4" @submit.prevent="knockStepUp.submitTotp">
          <div class="grid gap-2">
            <Label for="knock-step-up-code">{{ $t('networking.sshGuard.knock.stepUp.code') }}</Label>
            <Input
              id="knock-step-up-code"
              v-model="knockStepUpCode"
              inputmode="numeric"
              autocomplete="one-time-code"
              maxlength="8"
              placeholder="123456"
            />
            <p v-if="knockStepUpError" class="text-xs text-destructive">{{ knockStepUpError }}</p>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" @click="knockStepUp.cancel">
              {{ $t('common.actions.cancel') }}
            </Button>
            <Button
              type="button"
              variant="outline"
              :disabled="!!knockStepUpPending || !knockStepUp.supportsPasskey"
              @click="knockStepUp.submitPasskey"
            >
              <RefreshCw v-if="knockStepUpPending === 'passkey'" class="size-4 animate-spin" aria-hidden="true" />
              <KeyRound v-else class="size-4" aria-hidden="true" />
              {{ $t('networking.sshGuard.knock.stepUp.passkey') }}
            </Button>
            <Button type="submit" :disabled="!!knockStepUpPending || !knockStepUpCode.trim()">
              <RefreshCw v-if="knockStepUpPending === 'totp'" class="size-4 animate-spin" aria-hidden="true" />
              <Lock v-else class="size-4" aria-hidden="true" />
              {{ $t('networking.sshGuard.knock.stepUp.submit') }}
            </Button>
          </DialogFooter>
        </form>
      </DialogScrollContent>
    </Dialog>

</template>

<style scoped>
/*
 * Motion and reveal, per the 1.x direction. Durations and easing are the
 * chassis tokens in app.css, which also zeroes them under
 * prefers-reduced-motion, so nothing here carries its own reduced-motion rule.
 */
.board-chip,
.board-row,
.row-action {
  transition-property: color, background-color, border-color, opacity;
  transition-duration: var(--duration-fast);
  transition-timing-function: var(--ease-out);
}

.advanced-chevron {
  transition: transform var(--duration-base) var(--ease-out);
}

/* The one-line failure reason is a button; it earns a focus ring, not a border. */
.reason-toggle {
  border-radius: var(--radius-sm);
  outline: none;
}
.reason-toggle:focus-visible {
  box-shadow: 0 0 0 2px var(--background), 0 0 0 4px var(--ring);
}

/*
 * Row actions show on hover and on keyboard focus within the row, and are
 * always shown on a coarse pointer, where there is no hover to reveal them.
 * They stay in the tab order at every width.
 */
.row-action {
  opacity: 0;
}
.group\/row:hover .row-action,
.group\/row:focus-within .row-action {
  opacity: 1;
}
@media (pointer: coarse) {
  .row-action {
    opacity: 1;
  }
}
</style>

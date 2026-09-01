<script setup lang="ts">
/**
 * SSH Guard: shrink a node's SSH exposure without locking yourself out.
 *
 * The screen is built around the one thing that makes this safe, which is that
 * it takes two decisions rather than one. Arming applies the hardening and, at
 * the same moment, schedules an automatic revert. Confirming cancels that
 * revert. The gap between them exists so a human can open a fresh connection
 * over the new path and get a shell; if they cannot, doing nothing is what
 * restores access.
 *
 * So the loudest thing on the page is not the form. It is the list of nodes
 * whose revert timer is running, because that is a state with a deadline.
 */
import { computed, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute } from "vue-router";
import { toast } from "vue-sonner";
import { AlertTriangle, KeyRound, ShieldCheck, Timer } from "lucide-vue-next";

import { api, ApiError, unwrap, type ApprovalView, type Node, type NodeCapability, type SSHGuardFinding } from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { useAuthStore } from "@/stores/auth";
import { shortId } from "@/lib/format";
import { cn } from "@/lib/utils";

import PageHeader from "@/components/common/PageHeader.vue";
import DataState from "@/components/common/DataState.vue";
import NodePicker from "@/components/common/NodePicker.vue";
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
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

import {
  DEFAULT_CONFIRM_WINDOW_SEC,
  buildFleetStates,
  buildPlanRequest,
  deriveNodeGuardState,
  guardCoverage,
  hasBlocking,
  isSSHGuardApproval,
  nodesAwaitingConfirm,
  parseMgmtSources,
  sortFindings,
  validateForm,
  type GuardForm,
  type NodeGuardState,
} from "./sshGuardModel";

const { t } = useI18n();
const route = useRoute();
const auth = useAuthStore();

// Both scopes are required server-side: the capability's own and the plan
// scope the approval is minted under. Checking only one would offer a button
// that always fails.
const canAdmin = computed(() => auth.canAll(["sshguard:admin", "network:plan"]));

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
 * Enrolment: whether SSH Guard is allowed to act on a node at all.
 *
 * Hardening decides who can reach a machine over SSH, so it is opt-in per node
 * rather than available to whichever node the picker happens to be showing.
 * That makes "is this node even in scope" a precondition of the whole form, and
 * the operator should learn it when they pick the node, not after they have
 * composed a plan and the server refuses it.
 */
const capabilitiesQuery = useAsyncData<NodeCapability[] | undefined>(
  (signal) => api.nodes.capabilities({ signal }).then((r) => r.capabilities ?? []),
  { pollInterval: 60000 },
);

const selectedEnrolment = computed<NodeCapability | undefined>(() =>
  (capabilitiesQuery.data.value ?? []).find(
    (c) => c.node_id === form.nodeId && c.capability === "sshguard",
  ),
);

/**
 * No record is not a decision: nobody has said anything about this node, and
 * SSH Guard is opt-in, so it is out of scope until someone says otherwise.
 * Distinct from excluded, which is somebody having looked and said no.
 */
const selectedInScope = computed(() => selectedEnrolment.value?.state === "enrolled");

const enrolling = ref(false);

async function enrolSelected() {
  if (!form.nodeId || enrolling.value) return;
  enrolling.value = true;
  try {
    await api.nodes.setCapability({
      node_id: form.nodeId,
      capability: "sshguard",
      state: "enrolled",
    });
    toast.success(t("networking.sshGuard.enrolment.enrolled"));
    capabilitiesQuery.refresh();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : String(err));
  } finally {
    enrolling.value = false;
  }
}

/* ------------------------------------------------------------------ */
/* Fleet scope: who SSH Guard is allowed to touch.                      */
/*                                                                      */
/* The operator's job on this page is not "arm one node", it is         */
/* "decide the whole fleet's scope, then arm what is in it". Scope was  */
/* only settable one node at a time on each node's own page, so getting */
/* a 33-node fleet right meant 33 page visits. This panel is where the  */
/* fleet is already on screen, so it is where the partition belongs.    */
/* ------------------------------------------------------------------ */

type Scope = "enrolled" | "excluded" | "undecided";
type ScopeFilter = "all" | Scope;

function scopeOf(nodeId: string): Scope {
  const record = (capabilitiesQuery.data.value ?? []).find(
    (c) => c.node_id === nodeId && c.capability === "sshguard",
  );
  if (record?.state === "enrolled") return "enrolled";
  if (record?.state === "excluded") return "excluded";
  return "undecided";
}

const scopeFilter = ref<ScopeFilter>("all");

/** Live counts, which double as the filter. The page previously printed three
 *  numbers about arming progress and nothing about scope, so "how much of this
 *  fleet have I even decided about" had no answer on screen. */
const scopeCounts = computed(() => {
  const counts = { all: states.value.length, enrolled: 0, excluded: 0, undecided: 0 };
  for (const state of states.value) counts[scopeOf(state.nodeId)] += 1;
  return counts;
});

const visibleStates = computed(() =>
  scopeFilter.value === "all"
    ? states.value
    : states.value.filter((state) => scopeOf(state.nodeId) === scopeFilter.value),
);

const selectedNodes = ref<Set<string>>(new Set());
/** Anchor for shift-click range selection. */
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

/** Select-all acts on what is on screen, never on the whole fleet behind a
 *  filter. The bulk bar then says how many, so the two can never disagree. */
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
}

const bulkRunning = ref(false);
/** How far a bulk apply has got. The API is one call per node, so a 33-node
 *  change is 33 round trips; without this the button simply sits disabled for
 *  several seconds and the operator cannot tell it from a hang. */
const bulkProgress = reactive({ done: 0, total: 0 });
const bulkExcludeOpen = ref(false);
const bulkExcludeReason = ref("");

/**
 * Enrolling and excluding are both cheap and both reversible: neither touches
 * the machine. Enrolment only permits a plan to be written, exclusion only
 * withdraws that permission, and the actual hardening still goes through arm,
 * approve and confirm. So these run without a confirmation step - guarding a
 * reversible bookkeeping change would only teach people to click through
 * dialogs, which is what makes the guard on the destructive step worth less.
 */
async function applyScope(nodeIds: string[], state: "enrolled" | "excluded" | "", reason?: string) {
  if (!nodeIds.length || bulkRunning.value) return;
  bulkRunning.value = true;
  bulkProgress.done = 0;
  bulkProgress.total = nodeIds.length;
  const failures: string[] = [];
  try {
    for (const nodeId of nodeIds) {
      try {
        await api.nodes.setCapability({ node_id: nodeId, capability: "sshguard", state, reason });
      } catch {
        failures.push(nodeId);
      }
      bulkProgress.done += 1;
      // Refresh as it goes rather than only at the end, so the counts and the
      // rows move while the work happens instead of jumping when it finishes.
      if (bulkProgress.done % 5 === 0) capabilitiesQuery.refresh();
    }
    const failed = failures.length;
    // Report what actually happened rather than a flat success. A partial
    // failure that toasts "done" is how a fleet ends up half-configured with
    // nobody aware of it.
    if (failed) {
      // Name the ones that failed. "3 failed" on a 33-node change leaves the
      // operator to find them by hand, which is how a fleet ends up in a state
      // nobody can describe.
      toast.error(
        t("networking.sshGuard.scope.bulkPartial", {
          done: nodeIds.length - failed,
          failed,
          nodes: failures.slice(0, 3).join(", "),
        }),
      );
      // Keep the failures selected so the retry is one click, and drop the rest.
      selectedNodes.value = new Set(failures);
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

const scopeTone: Record<Scope, "success" | "destructive" | "outline"> = {
  enrolled: "success",
  excluded: "destructive",
  undecided: "outline",
};

const states = computed<NodeGuardState[]>(() =>
  buildFleetStates(approvals.value, nodesQuery.data.value ?? []),
);

const coverage = computed(() => guardCoverage(states.value));
const urgent = computed(() => nodesAwaitingConfirm(states.value));

const form = reactive<GuardForm>({
  nodeId: "",
  sshPort: 0,
  keepLegacyPort: true,
  mgmtSources: "",
  enableKnock: true,
  outOfBandFallback: false,
  confirmWindowSec: DEFAULT_CONFIRM_WINDOW_SEC,
  acceptFindings: false,
});

/**
 * Seed the node from ?node_id=, so a node page can link straight to "harden
 * this one" instead of making the operator find it again in a 33-entry picker.
 * Only a seed: it does not follow later route changes, because that would
 * fight the picker once someone starts choosing.
 */
{
  const seeded = route.query.node_id;
  if (typeof seeded === "string" && seeded) form.nodeId = seeded;
}


const findings = ref<SSHGuardFinding[]>([]);
const planning = ref(false);
const confirming = ref("");

const sourceParse = computed(() => parseMgmtSources(form.mgmtSources));
const errors = computed(() => validateForm(form));
// A form nobody has touched yet is not wrong, it is empty. Listing what is
// missing before the operator has typed anything makes an untouched page look
// broken, and it is doubly confusing here because the management-sources
// placeholder reads as a filled value while the warning says there is none.
// The button stays disabled either way; the reasons appear once they are news.
const touched = ref(false);
const shownErrors = computed(() => (touched.value ? errors.value : []));
const blocked = computed(() => hasBlocking(findings.value) && !form.acceptFindings);
const selected = computed(() =>
  form.nodeId ? deriveNodeGuardState(approvals.value, form.nodeId) : undefined,
);

// Findings and the acceptance that went with them belong to the exact profile
// they were computed for. Editing any field that shapes the plan invalidates
// both: a "port already in use" that was verified as a false alarm must not
// carry an exemption over to a different port, and a finding left on screen
// after the field it describes has changed is reporting on a plan that no
// longer exists.
watch(
  () => [
    form.nodeId,
    form.sshPort,
    form.keepLegacyPort,
    form.mgmtSources,
    form.enableKnock,
    form.outOfBandFallback,
    form.confirmWindowSec,
  ],
  () => {
    touched.value = true;
    findings.value = [];
    form.acceptFindings = false;
  },
);

async function plan() {
  touched.value = true;
  if (!form.nodeId || errors.value.length || planning.value) return;
  planning.value = true;
  try {
    const res = await api.sshGuard.plan(buildPlanRequest(form));
    findings.value = res.findings ?? [];
    form.acceptFindings = false;
    toast.success(t("networking.sshGuard.planned", { id: shortId(res.approval.id) }));
    approvalsQuery.refresh();
  } catch (err) {
    // 409 is the lint refusing the plan. It carries the reasons, so show them
    // instead of a generic failure: the operator's next move is to read them.
    if (err instanceof ApiError && err.status === 409) {
      const body = err.body as { findings?: SSHGuardFinding[] } | undefined;
      findings.value = body?.findings ?? [];
      toast.error(t("networking.sshGuard.blockedByLint"));
    } else {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  } finally {
    planning.value = false;
  }
}

async function confirmNode(nodeId: string) {
  if (confirming.value) return;
  confirming.value = nodeId;
  try {
    const res = await api.sshGuard.confirm(nodeId);
    toast.success(t("networking.sshGuard.confirmPlanned", { id: shortId(res.approval.id) }));
    approvalsQuery.refresh();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : String(err));
  } finally {
    confirming.value = "";
  }
}

const stageTone: Record<string, "default" | "secondary" | "warning" | "destructive"> = {
  idle: "secondary",
  armPending: "secondary",
  armApproved: "secondary",
  awaitingConfirm: "warning",
  confirmPending: "warning",
  confirmApproved: "warning",
  confirmed: "default",
  armFailed: "destructive",
};
</script>

<template>
  <div class="space-y-6">
    <PageHeader
      :title="$t('networking.sshGuard.title')"
      :description="$t('networking.sshGuard.description')"
    />

    <!-- The only state with a deadline. It goes first and it is loud. -->
    <Card v-if="urgent.length" class="border-warning">
      <CardHeader>
        <CardTitle class="flex items-center gap-2">
          <Timer class="size-4 text-warning" aria-hidden="true" />
          {{ $t('networking.sshGuard.awaiting.title') }}
          <Badge variant="warning">{{ urgent.length }}</Badge>
        </CardTitle>
        <CardDescription>{{ $t('networking.sshGuard.awaiting.description') }}</CardDescription>
      </CardHeader>
      <CardContent class="space-y-3">
        <p class="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
          {{ $t('networking.sshGuard.awaiting.instruction') }}
        </p>
        <div
          v-for="state in urgent"
          :key="state.nodeId"
          class="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
        >
          <div class="min-w-0 flex-1">
            <p class="truncate font-mono text-sm" :title="state.nodeId">{{ state.nodeId }}</p>
            <p class="text-xs text-muted-foreground">
              {{ $t(`networking.sshGuard.stage.${state.stage}`) }}
            </p>
          </div>
          <Button
            v-if="state.stage === 'awaitingConfirm'"
            class="shrink-0"
            size="sm"
            :disabled="!canAdmin || confirming === state.nodeId"
            @click="confirmNode(state.nodeId)"
          >
            {{ $t('networking.sshGuard.confirmAction') }}
          </Button>
          <Badge v-else class="shrink-0" variant="warning">{{ $t('networking.sshGuard.confirmQueued') }}</Badge>
        </div>
      </CardContent>
    </Card>

    <div class="grid gap-6 lg:grid-cols-2">
      <!-- Plan -->
      <Card>
        <CardHeader>
          <CardTitle class="flex items-center gap-2">
            <ShieldCheck class="size-4 text-muted-foreground" aria-hidden="true" />
            {{ $t('networking.sshGuard.plan.title') }}
          </CardTitle>
          <CardDescription>{{ $t('networking.sshGuard.plan.description') }}</CardDescription>
        </CardHeader>
        <CardContent class="space-y-4">
          <NodePicker id="sshguard-node" v-model="form.nodeId" :disabled="!canAdmin" />

          <!-- Whether this node is in scope at all. Same reasoning as the stage
               block below: it is a property of the node, not a field of the
               form, and it decides whether the form is the right action. The
               server refuses an out-of-scope plan regardless; showing it here
               means the operator finds out before composing one. -->
          <div
            v-if="form.nodeId && !selectedInScope"
            class="rounded-md border px-3 py-2 text-sm"
            :class="selectedEnrolment?.state === 'excluded'
              ? 'border-destructive/40 bg-destructive/5'
              : 'border-warning/40 bg-warning/5'"
          >
            <div class="flex flex-wrap items-center justify-between gap-2">
              <div class="min-w-0">
                <p class="font-medium">
                  {{ selectedEnrolment?.state === 'excluded'
                    ? $t('networking.sshGuard.enrolment.excluded')
                    : $t('networking.sshGuard.enrolment.notEnrolled') }}
                </p>
                <p class="text-xs text-muted-foreground">
                  {{ selectedEnrolment?.reason || $t('networking.sshGuard.enrolment.notEnrolledHint') }}
                </p>
              </div>
              <!-- Enrolling is offered here because it is the block the operator
                   is standing in front of. Excluding, which needs a reason and
                   is a decision about the node rather than about this form,
                   lives on the node page. -->
              <Button
                size="sm"
                variant="outline"
                :disabled="!canAdmin || enrolling"
                @click="enrolSelected"
              >
                {{ selectedEnrolment?.state === 'excluded'
                  ? $t('networking.sshGuard.enrolment.enrolAnyway')
                  : $t('networking.sshGuard.enrolment.enrol') }}
              </Button>
            </div>
          </div>
          <!-- Where the selected node already stands. It sits here, against
               the picker, because it is a property of that node rather than a
               field of this form: picking one that is mid-sequence makes the
               form below the wrong action, and that should be visible before
               anyone fills it in. -->
          <div
            v-if="selected && selected.stage !== 'idle'"
            class="rounded-md px-3 py-2 text-sm"
            :class="selected.revertArmed ? 'border border-warning bg-warning/10' : 'bg-muted/50'"
          >
            <div class="flex flex-wrap items-center justify-between gap-2">
              <span class="font-medium">{{ $t(`networking.sshGuard.stage.${selected.stage}`) }}</span>
              <Button
                v-if="selected.stage === 'awaitingConfirm'"
                size="sm"
                :disabled="!canAdmin || confirming === selected.nodeId"
                @click="confirmNode(selected.nodeId)"
              >
                {{ $t('networking.sshGuard.confirmAction') }}
              </Button>
            </div>
            <p v-if="selected.revertArmed" class="mt-2 text-xs">
              {{ $t('networking.sshGuard.awaiting.instruction') }}
            </p>
          </div>


          <div class="grid gap-2">
            <Label for="sshguard-port">{{ $t('networking.sshGuard.fields.sshPort') }}</Label>
            <Input
              id="sshguard-port"
              v-model.number="form.sshPort"
              type="number"
              min="0"
              max="65535"
              :disabled="!canAdmin"
            />
            <p class="text-xs text-muted-foreground">{{ $t('networking.sshGuard.fields.sshPortHint') }}</p>
          </div>

          <label class="flex items-start gap-3 text-sm">
            <Checkbox class="mt-0.5" :model-value="form.keepLegacyPort" :disabled="!canAdmin"
              @update:model-value="(v) => (form.keepLegacyPort = v === true)" />
            <span class="space-y-1">
              <span class="block font-medium">{{ $t('networking.sshGuard.fields.keepLegacy') }}</span>
              <span class="block text-muted-foreground">{{ $t('networking.sshGuard.fields.keepLegacyHint') }}</span>
            </span>
          </label>

          <div class="grid gap-2">
            <Label for="sshguard-sources">{{ $t('networking.sshGuard.fields.mgmtSources') }}</Label>
            <Input id="sshguard-sources" v-model="form.mgmtSources" :disabled="!canAdmin"
              :placeholder="$t('networking.sshGuard.fields.mgmtSourcesPlaceholder')" />
            <p class="text-xs text-muted-foreground">{{ $t('networking.sshGuard.fields.mgmtSourcesHint') }}</p>
            <p v-if="sourceParse.invalid.length" class="text-xs text-destructive">
              {{ $t('networking.sshGuard.fields.mgmtSourcesInvalid', { values: sourceParse.invalid.join(', ') }) }}
            </p>
          </div>

          <label class="flex items-start gap-3 text-sm">
            <Checkbox class="mt-0.5" :model-value="form.enableKnock" :disabled="!canAdmin"
              @update:model-value="(v) => (form.enableKnock = v === true)" />
            <span class="space-y-1">
              <span class="block font-medium">{{ $t('networking.sshGuard.fields.knock') }}</span>
              <span class="block text-muted-foreground">{{ $t('networking.sshGuard.fields.knockHint') }}</span>
            </span>
          </label>

          <label class="flex items-start gap-3 text-sm">
            <Checkbox class="mt-0.5" :model-value="form.outOfBandFallback" :disabled="!canAdmin"
              @update:model-value="(v) => (form.outOfBandFallback = v === true)" />
            <span class="space-y-1">
              <span class="block font-medium">{{ $t('networking.sshGuard.fields.fallback') }}</span>
              <span class="block text-muted-foreground">{{ $t('networking.sshGuard.fields.fallbackHint') }}</span>
            </span>
          </label>

          <div class="grid gap-2">
            <Label for="sshguard-window">{{ $t('networking.sshGuard.fields.window') }}</Label>
            <Input id="sshguard-window" v-model.number="form.confirmWindowSec" type="number" min="120"
              :disabled="!canAdmin" />
            <p class="text-xs text-muted-foreground">{{ $t('networking.sshGuard.fields.windowHint') }}</p>
          </div>

          <ul v-if="shownErrors.length" class="space-y-1 text-xs text-destructive">
            <li v-for="code in shownErrors" :key="code">{{ $t(`networking.sshGuard.errors.${code}`) }}</li>
          </ul>

          <div class="flex items-center gap-3">
            <Button :disabled="!canAdmin || !form.nodeId || errors.length > 0 || planning || blocked" @click="plan">
              {{ $t('networking.sshGuard.planAction') }}
            </Button>
          </div>
        </CardContent>
      </Card>

      <!-- Findings + fleet state -->
      <div class="space-y-6">
        <Card v-if="findings.length">
          <CardHeader>
            <CardTitle class="flex items-center gap-2">
              <AlertTriangle class="size-4 text-muted-foreground" aria-hidden="true" />
              {{ $t('networking.sshGuard.findings.title') }}
            </CardTitle>
            <CardDescription>{{ $t('networking.sshGuard.findings.description') }}</CardDescription>
          </CardHeader>
          <CardContent class="space-y-3">
            <div
              v-for="finding in sortFindings(findings)"
              :key="finding.code"
              class="rounded-md border border-border p-3"
            >
              <div class="flex items-center gap-2">
                <Badge :variant="finding.severity === 'block' ? 'destructive' : 'warning'">
                  {{ finding.severity }}
                </Badge>
                <code class="font-mono text-xs">{{ finding.code }}</code>
              </div>
              <p class="mt-1 text-sm">{{ finding.message }}</p>
            </div>
            <label v-if="hasBlocking(findings)" class="flex items-start gap-3 text-sm">
              <Checkbox class="mt-0.5" :model-value="form.acceptFindings" :disabled="!canAdmin"
                @update:model-value="(v) => (form.acceptFindings = v === true)" />
              <span class="space-y-1">
                <span class="block font-medium">{{ $t('networking.sshGuard.findings.accept') }}</span>
                <span class="block text-muted-foreground">{{ $t('networking.sshGuard.findings.acceptHint') }}</span>
              </span>
            </label>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle class="flex items-center gap-2">
              <KeyRound class="size-4 text-muted-foreground" aria-hidden="true" />
              {{ $t('networking.sshGuard.fleet.title') }}
            </CardTitle>
            <CardDescription>{{ $t('networking.sshGuard.fleet.description') }}</CardDescription>
            <!-- The three numbers an operator is deciding between: what is
                 finished, what is mid-sequence, and what is still open. -->
            <div v-if="coverage.total" class="flex flex-wrap gap-x-4 gap-y-1 pt-1 text-xs text-muted-foreground">
              <span>{{ $t('networking.sshGuard.fleet.done', { n: coverage.done, total: coverage.total }) }}</span>
              <span v-if="coverage.inFlight">{{ $t('networking.sshGuard.fleet.inFlight', { n: coverage.inFlight }) }}</span>
              <span v-if="coverage.open">{{ $t('networking.sshGuard.fleet.open', { n: coverage.open }) }}</span>
            </div>

            <!-- Scope, as a filter rather than a caption. The page used to
                 print progress numbers you could not act on; these answer the
                 prior question - how much of this fleet have I decided about -
                 and clicking one narrows the list to it. -->
            <div v-if="states.length" class="flex flex-wrap gap-1 pt-2" role="group" :aria-label="$t('networking.sshGuard.scope.filterLabel')">
              <button
                v-for="key in (['all', 'enrolled', 'undecided', 'excluded'] as const)"
                :key="key"
                type="button"
                :aria-pressed="scopeFilter === key"
                :class="cn(
                  'inline-flex items-center gap-1.5 rounded-sm border px-2 py-1 text-xs font-medium transition-colors',
                  scopeFilter === key
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border text-muted-foreground hover:bg-muted/40',
                )"
                @click="scopeFilter = key"
              >
                {{ $t(`networking.sshGuard.scope.filter.${key}`) }}
                <span class="tabular">{{ scopeCounts[key] }}</span>
              </button>
            </div>
          </CardHeader>
          <CardContent>
            <DataState
              :loading="approvalsQuery.loading.value || nodesQuery.loading.value"
              :error="approvalsQuery.error.value"
              :has-data="approvalsQuery.data.value !== undefined"
              :is-empty="states.length === 0"
              :empty-description="$t('networking.sshGuard.fleet.empty')"
              :skeleton-rows="3"
              @retry="approvalsQuery.refresh"
            >
              <!-- Bulk bar. Present only while something is selected, and it
                   names what the action would do rather than how many rows are
                   ticked, so the sentence and the effect cannot disagree. -->
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
              </div>

              <label
                v-if="visibleStates.length"
                class="mb-2 flex items-center gap-2 text-xs text-muted-foreground"
              >
                <Checkbox
                  :model-value="allVisibleSelected"
                  :aria-label="$t('networking.sshGuard.scope.selectAll')"
                  @update:model-value="(v) => toggleSelectAllVisible(v === true)"
                />
                <span>{{ $t('networking.sshGuard.scope.selectAll') }}</span>
              </label>

              <ul class="space-y-1">
                <!-- One line per node. Node ids run long and the stage labels
                     are sentences, so letting the row wrap gave a list where
                     some rows were one line and some were two, which is hard to
                     scan. The id truncates and the stage keeps its width. -->
                <li
                  v-for="state in visibleStates"
                  :key="state.nodeId"
                  :tabindex="0"
                  :aria-selected="selectedNodes.has(state.nodeId)"
                  class="group/row flex items-center gap-2 rounded-md border px-2 py-1.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                  @keydown.space.prevent="toggleRow(state.nodeId, $event as unknown as MouseEvent)"
                  @keydown.enter.prevent="form.nodeId = state.nodeId"
                  :class="state.nodeId === form.nodeId
                    ? 'border-primary bg-primary/5'
                    : selectedNodes.has(state.nodeId)
                      ? 'border-primary/40 bg-primary/5'
                      : 'border-border hover:bg-muted/40'"
                >
                  <span class="shrink-0" @click.stop>
                    <Checkbox
                      :model-value="selectedNodes.has(state.nodeId)"
                      :aria-label="$t('networking.sshGuard.scope.selectRow', { node: state.name || state.nodeId })"
                      @click="(e: MouseEvent) => toggleRow(state.nodeId, e)"
                      @update:model-value="() => {}"
                    />
                  </span>
                  <button
                    type="button"
                    :title="state.name ? `${state.name} (${state.nodeId})` : state.nodeId"
                    class="min-w-0 flex-1 truncate text-left"
                    @click="form.nodeId = state.nodeId"
                  >
                    <span class="text-sm font-medium">{{ state.name || state.nodeId }}</span>
                    <span v-if="state.name" class="ml-2 font-mono text-xs text-muted-foreground">{{ state.nodeId }}</span>
                  </button>
                  <!-- The scope chip is dropped while a scope filter is active:
                       every row already carries that value, and repeating what
                       you just asked for is noise. -->
                  <Badge
                    v-if="scopeFilter === 'all'"
                    class="shrink-0"
                    :variant="scopeTone[scopeOf(state.nodeId)]"
                  >
                    {{ $t(`networking.sshGuard.scope.state.${scopeOf(state.nodeId)}`) }}
                  </Badge>
                  <Badge class="shrink-0" :variant="stageTone[state.stage] ?? 'secondary'">
                    {{ $t(`networking.sshGuard.stage.${state.stage}`) }}
                  </Badge>
                </li>
              </ul>
            </DataState>
          </CardContent>
        </Card>
      </div>
    </div>

    <!-- Bulk exclude. One reason for the whole selection, because that is how
         these decisions are actually made: "the NAT boxes, because no exposed
         port". Asking per node would either get the same sentence typed ten
         times or get it abandoned. -->
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
</template>

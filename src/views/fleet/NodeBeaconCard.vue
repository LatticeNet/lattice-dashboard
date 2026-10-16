<script lang="ts">
/**
 * Whether this session has seen the beacon route answer. A server before
 * design 29 M2b answers 404, and the card then never draws, not even a
 * skeleton; once the route has answered, the next node page shows the
 * card's loading state while it reads.
 */
let beaconRouteSeen = false;
/**
 * Whether the route answered 404 or 405 in this session: a server before
 * M2b. The card then asks no more, on this node page or the next, until the
 * console reloads (a server upgrade reloads it).
 */
let beaconRouteMissing = false;
</script>

<script setup lang="ts">
/**
 * The Beacon card on a node's page (design 29 D3, D7, D12): the one inbound
 * socket a node's agent may open, off until an approved node.beacon plan
 * turns it on.
 *
 * It says, in this order: the state and its cause in one toned line; the
 * settings (UDP port, the endpoint sources send to, the bind address, the
 * key epoch and its last rotation, the last signed request); the exposure,
 * always printed (NetGuard admits only the approved sources, or the port is
 * open to the internet, as D3 requires the console to say); the
 * reachability check's verdict; sources the beacon does not admit yet; the
 * sources; and the actions. Enable, change and turn off are plans filed
 * here and decided in Approvals; rotating the keys is an audited action
 * behind a confirm. A session without the scopes reads everything and is
 * told which scopes change it.
 */
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink, useRoute } from "vue-router";
import { KeyRound, Power, RadioTower, ShieldAlert, SlidersHorizontal } from "lucide-vue-next";

import { api, type ApprovalView, type BeaconPlanAction, type BeaconView, type Node } from "@/lib/api";
import { formatRelativeTime } from "@/lib/format";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { useAsyncData } from "@/composables/useAsyncData";
import { useAuthStore } from "@/stores/auth";

import ConfirmDialog from "@/components/common/ConfirmDialog.vue";
import DataState from "@/components/common/DataState.vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

import BeaconPlanSheet from "./BeaconPlanSheet.vue";
import {
  agentHasResponder,
  beaconActions,
  beaconEnabled,
  beaconForbidden,
  beaconSources,
  beaconState,
  beaconTone,
  companionApprovalToRead,
  companionOutcome,
  endpointIsOwn,
  nextEpoch,
  nodeRefusesBeacon,
  notListeningCause,
  reachState,
  waitingSources,
} from "./beaconModel";
import { isMissingRoute } from "./pathsModel";

const props = defineProps<{ node: Node }>();

const { t } = useI18n();
const auth = useAuthStore();
const route = useRoute();
const canRead = computed(() => auth.can("monitor:read"));

/** The applied plan's approval, read for its NetGuard task's outcome; "denied" when this session may not read it. */
type CompanionRead = { kind: "approval"; approval: ApprovalView } | { kind: "denied" } | { kind: "unread" };
type BeaconRead = { kind: "view"; view: BeaconView; companion?: CompanionRead } | { kind: "missing" } | { kind: "denied" };

/**
 * D12: with a NetGuard companion the beacon stays closed to sources until
 * the companion task succeeds, and stays closed if it fails. The view says
 * firewall pending either way; the applied plan's approval says which.
 * Reading it needs monitor:read on every source the plan names, so a 403
 * is an answer, not an error.
 */
async function readCompanion(view: BeaconView, signal: AbortSignal): Promise<CompanionRead | undefined> {
  const id = companionApprovalToRead(view);
  if (!id) return undefined;
  if (!auth.can("approval:read")) return { kind: "denied" };
  try {
    return { kind: "approval", approval: await api.approvals.get(id, { signal }) };
  } catch (error) {
    if ((error as Error)?.name === "AbortError") throw error;
    return { kind: beaconForbidden(error) ? "denied" : "unread" };
  }
}

const query = useAsyncData<BeaconRead | undefined>(
  async (signal) => {
    if (!canRead.value) return undefined;
    if (beaconRouteMissing) return { kind: "missing" };
    try {
      const view = await api.nodes.beacon.get(props.node.id, { signal });
      // Anything but the view (an HTML fallback) is a server without the route.
      if (!view || typeof view !== "object" || typeof view.state !== "string") {
        beaconRouteMissing = true;
        return { kind: "missing" };
      }
      beaconRouteSeen = true;
      return { kind: "view", view, companion: await readCompanion(view, signal) };
    } catch (error) {
      // A server before M2b has no such route: no card, never an error, and no further requests.
      if (isMissingRoute(error)) {
        beaconRouteMissing = true;
        return { kind: "missing" };
      }
      if (beaconForbidden(error)) return { kind: "denied" };
      throw error;
    }
  },
  { pollInterval: 20000, immediate: canRead.value && !beaconRouteMissing },
);

const read = computed(() => query.data.value);
watch(read, (r) => {
  if (r?.kind === "missing") query.stop();
});
const view = computed(() => (read.value?.kind === "view" ? read.value.view : undefined));
const companion = computed(() => (read.value?.kind === "view" ? read.value.companion : undefined));
/** How the NetGuard task went, when the card could read it. */
const companionState = computed(() => (companion.value?.kind === "approval" ? companionOutcome(companion.value.approval) : undefined));
/**
 * Drawn once the route has answered, or while it is read when this session
 * has seen it answer or the node's agent reports beacon facts (only an M2b
 * server sends them); a failed read draws its error.
 */
const visible = computed(() => {
  if (!canRead.value || beaconRouteMissing) return false;
  if (read.value) return read.value.kind !== "missing";
  if (query.error.value) return true;
  return beaconRouteSeen || !!props.node.beacon;
});

const state = computed(() => beaconState(view.value));
const tone = computed(() => beaconTone(state.value));
const enabled = computed(() => beaconEnabled(view.value));
const applied = computed(() => view.value?.applied ?? undefined);
const sources = computed(() => beaconSources(view.value));
const waiting = computed(() => waitingSources(view.value));
const reach = computed(() => reachState(view.value));
const cause = computed(() => notListeningCause(view.value));
const refuses = computed(() => nodeRefusesBeacon(view.value, props.node));
const responder = computed(() => agentHasResponder(view.value, props.node));
const version = computed(() => props.node.agent_version || t("fleet.monitoring.beacon.line.versionUnknown"));
const name = computed(() => props.node.name || props.node.id);
const actions = computed(() =>
  beaconActions(
    view.value,
    { monitorAdmin: auth.can("monitor:admin"), nodeAdmin: auth.can("node:admin"), networkPlan: auth.can("network:plan"), netguardAdmin: auth.can("netguard:admin") },
    props.node,
  ),
);
const anyAction = computed(() => actions.value.enable || actions.value.change || actions.value.disable || actions.value.rotate);
const canUpdateAgents = computed(() => auth.can("node:admin"));

const BADGE: Record<string, "success" | "warning" | "destructive" | "secondary"> = { success: "success", warning: "warning", destructive: "destructive", muted: "secondary" };
const LINE: Record<string, string> = { success: "text-foreground", warning: "text-warning-text", destructive: "text-destructive", muted: "text-muted-foreground" };

const port = computed(() => applied.value?.port ?? props.node.beacon?.port ?? "");
const bind = computed(() => applied.value?.bind ?? props.node.beacon?.bind ?? "");

/** The state in one sentence, with the agent's own words where it gave them. */
const stateLine = computed(() => {
  const v = view.value;
  if (!v) return "";
  switch (state.value) {
    case "off":
      return t("fleet.monitoring.beacon.line.off");
    case "pending":
      return t("fleet.monitoring.beacon.line.pending", { bind: bind.value, port: port.value });
    case "listening":
      return t("fleet.monitoring.beacon.line.listening", { bind: bind.value, port: port.value });
    case "refused_by_node":
      return t("fleet.monitoring.beacon.line.refused");
    case "agent_too_old":
      return t("fleet.monitoring.beacon.line.agentTooOld", { version: version.value });
    case "not_listening":
      if (cause.value.kind === "bind_failed") return t("fleet.monitoring.beacon.line.notListeningBind", { bind: bind.value, port: port.value });
      if (cause.value.kind === "circuit_open") return t("fleet.monitoring.beacon.line.notListeningCircuit");
      return t("fleet.monitoring.beacon.line.notListening", { bind: bind.value, port: port.value });
    default:
      return "";
  }
});

/**
 * The plan's NetGuard rule has not applied: its task runs, or the card
 * cannot tell and no source waits on a change plan (the server says
 * firewall pending for either reason).
 */
const companionClosed = computed(() => {
  const v = view.value;
  if (!v || !enabled.value || v.exposure !== "netguard" || !v.firewall_pending) return false;
  const kind = companionState.value?.kind;
  if (kind === "applying") return true;
  if (kind === "applied") return false;
  return companion.value?.kind === "denied" || !waiting.value.length;
});

/** The approved sources NetGuard admits, counted for the exposure line. */
const admitted = computed(() => sources.value.active.length + sources.value.idle.length);
const exposure = computed(() => {
  const v = view.value;
  if (!v || !enabled.value) return undefined;
  if (v.exposure === "netguard") {
    // Until the plan's NetGuard task succeeds the rule admits nobody (D12), whatever the plan approved.
    if (companionState.value?.kind === "failed") return t("fleet.monitoring.beacon.exposure.netguardFailed");
    if (companionClosed.value) return t("fleet.monitoring.beacon.exposure.netguardApplying");
    return admitted.value ? t("fleet.monitoring.beacon.exposure.netguard", { n: admitted.value }, admitted.value) : t("fleet.monitoring.beacon.exposure.netguardNone");
  }
  if (v.exposure === "internet") return t("fleet.monitoring.beacon.exposure.internetShort");
  return t("fleet.monitoring.beacon.exposure.unknown");
});
const openToInternet = computed(() => enabled.value && view.value?.exposure === "internet");
/** The applied endpoint is not the node's public or interface address: a line's edge, or an address the node has left. */
const endpointForeign = computed(() => enabled.value && !!applied.value?.endpoint && !endpointIsOwn(applied.value.endpoint, props.node));

const reachLine = computed(() => {
  const v = view.value;
  if (!v || !enabled.value) return undefined;
  const r = v.reachability ?? {};
  const age = r.checked_at ? formatRelativeTime(r.checked_at) : "";
  const source = (v.sources ?? []).find((s) => s.node_id === r.source)?.name || r.source || "";
  switch (reach.value) {
    case undefined:
      return { text: t("fleet.monitoring.beacon.reach.none"), warn: false };
    case "pending":
      return { text: t("fleet.monitoring.beacon.reach.pending", { source }), warn: false };
    case "reachable":
      return { text: t("fleet.monitoring.beacon.reach.reachable", { source, age }), warn: false };
    case "filtered":
      return { text: t("fleet.monitoring.beacon.reach.filtered", { source, age, port: port.value }), warn: true };
    case "not_listening":
      return { text: t("fleet.monitoring.beacon.reach.not_listening", { source, age, endpoint: applied.value?.endpoint ?? "" }), warn: true };
    case "no_source":
      // The server checks from an approved, current, online source with the client: say which half is missing.
      return { text: t(sources.value.active.length ? "fleet.monitoring.beacon.reach.no_source" : "fleet.monitoring.beacon.reach.noAdmitted"), warn: true };
    default:
      return undefined;
  }
});

const waitingNames = computed(() => waiting.value.map((s) => s.name || s.node_id).join(", "));
const sourceRows = computed(() => [
  ...sources.value.active.map((s) => ({ s, status: "active" as const })),
  ...sources.value.waiting.map((s) => ({ s, status: "waiting" as const })),
  ...sources.value.idle.map((s) => ({ s, status: "idle" as const })),
]);

/* ---- A link to this card (#node-beacon) scrolls to it once it has drawn. ---- */

let scrolled = false;
watch(
  view,
  async (v) => {
    if (!v || scrolled || route.hash !== "#node-beacon") return;
    scrolled = true;
    await nextTick();
    document.getElementById("node-beacon")?.scrollIntoView({ block: "start" });
  },
  { immediate: true },
);

/* ---- Plans ---- */

const sheetOpen = ref(false);
const sheetAction = ref<BeaconPlanAction>("enable");
function openPlan(action: BeaconPlanAction): void {
  sheetAction.value = action;
  sheetOpen.value = true;
}
function onFiled(): void {
  void query.refresh();
}

/* ---- Rotation ---- */

const rotateOpen = ref(false);
const rotating = ref(false);
async function rotate(): Promise<void> {
  if (rotating.value) return;
  rotating.value = true;
  try {
    const res = await api.nodes.beacon.rotate(props.node.id);
    toast.success(t("fleet.monitoring.beacon.rotate.toast", { name: name.value, epoch: res.epoch }));
    rotateOpen.value = false;
    void query.refresh();
  } catch (error) {
    toast.error(t("fleet.monitoring.beacon.rotate.failed", { reason: error instanceof Error ? error.message : String(error) }));
  } finally {
    rotating.value = false;
  }
}

const NOTE = "rounded-md px-2.5 py-2 text-xs";
const DT = "text-xs text-muted-foreground";
/** Addresses break anywhere; sentences break between words. */
const DD = "min-w-0 font-mono text-xs break-all";
const DD_TEXT = "min-w-0 text-xs break-words";
</script>

<template>
  <Card v-if="visible" id="node-beacon" class="scroll-mt-16" data-testid="node-beacon" :data-state="view ? state : undefined">
    <CardHeader>
      <div class="flex flex-wrap items-center justify-between gap-2">
        <CardTitle class="flex items-center gap-2">
          <RadioTower class="size-4 text-muted-foreground" aria-hidden="true" />
          {{ $t('fleet.monitoring.beacon.title') }}
        </CardTitle>
        <Badge v-if="view" :variant="BADGE[tone]" data-testid="beacon-state">{{ $t(`fleet.monitoring.beacon.state.${state}`) }}</Badge>
      </div>
      <CardDescription>{{ $t('fleet.monitoring.beacon.description') }}</CardDescription>
    </CardHeader>
    <CardContent class="space-y-4 text-sm">
      <DataState :loading="query.loading.value" :error="query.error.value ?? null" :has-data="!!read" :skeleton-rows="3" @retry="query.refresh">
        <p v-if="read?.kind === 'denied'" class="text-muted-foreground" data-testid="beacon-denied">{{ $t('fleet.monitoring.beacon.denied') }}</p>
        <div v-else-if="view" class="space-y-4">
          <!-- The state, and why. -->
          <div class="space-y-1.5">
            <p :class="cn('break-words', LINE[tone])" data-testid="beacon-line">{{ stateLine }}</p>
            <p v-if="state === 'not_listening' && cause.error" class="font-mono text-xs break-words text-foreground" data-testid="beacon-error">{{ cause.error }}</p>
            <template v-if="state === 'off'">
              <p v-if="refuses" :class="cn(NOTE, 'bg-warning/10 text-warning-text')" data-testid="beacon-off-refused">{{ $t('fleet.monitoring.beacon.line.offRefused') }}</p>
              <template v-else>
                <p class="text-xs text-muted-foreground">{{ view.suggested_port ? $t('fleet.monitoring.beacon.line.offPort', { port: view.suggested_port }) : $t('fleet.monitoring.beacon.line.offRandom') }}</p>
                <p v-if="!responder" :class="cn(NOTE, 'bg-warning/10 text-warning-text')" data-testid="beacon-off-old">
                  {{ $t('fleet.monitoring.beacon.line.offNoResponder', { version }) }}
                  <RouterLink v-if="canUpdateAgents" :to="{ name: 'platform-agent-updates' }" class="ms-1 font-medium text-foreground underline underline-offset-2">{{ $t('fleet.monitoring.beacon.updateAgent') }}</RouterLink>
                </p>
              </template>
            </template>
            <p v-if="state === 'agent_too_old' && canUpdateAgents" class="text-xs">
              <RouterLink :to="{ name: 'platform-agent-updates' }" class="font-medium underline underline-offset-2">{{ $t('fleet.monitoring.beacon.updateAgent') }}</RouterLink>
            </p>
          </div>

          <!-- A plan waiting for its decision. -->
          <p v-if="view.pending_approval_id" :class="cn(NOTE, 'flex flex-wrap items-center gap-x-2 gap-y-1 border border-border bg-muted/40')" data-testid="beacon-pending-approval">
            <span>{{ $t('fleet.monitoring.beacon.pendingApproval') }}</span>
            <RouterLink :to="{ name: 'approvals', query: { open: view.pending_approval_id } }" class="font-medium underline underline-offset-2 pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center">
              {{ $t('fleet.monitoring.beacon.reviewApproval') }}
            </RouterLink>
          </p>

          <!-- The settings an applied plan set. -->
          <dl v-if="enabled && applied" class="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-4 gap-y-1.5" :aria-label="$t('fleet.monitoring.beacon.facts.label')" data-testid="beacon-facts">
            <dt :class="DT">{{ $t('fleet.monitoring.beacon.facts.port') }}</dt>
            <dd :class="DD">{{ applied.port }}</dd>
            <dt :class="DT">{{ $t('fleet.monitoring.beacon.facts.endpoint') }}</dt>
            <dd :class="DD">{{ applied.endpoint }} <span class="break-normal font-sans text-muted-foreground">({{ $t('fleet.monitoring.beacon.facts.endpointHint') }})</span></dd>
            <dd v-if="endpointForeign" :class="cn(DD_TEXT, 'col-start-2 -mt-1 text-muted-foreground')" data-testid="beacon-endpoint-not-own">{{ $t('fleet.monitoring.beacon.facts.endpointNotOwn') }}</dd>
            <dt :class="DT">{{ $t('fleet.monitoring.beacon.facts.bind') }}</dt>
            <dd :class="DD">{{ applied.bind }}</dd>
            <template v-if="view.epoch">
              <dt :class="DT">{{ $t('fleet.monitoring.beacon.facts.epoch') }}</dt>
              <dd :class="DD">{{ view.rotated_at ? $t('fleet.monitoring.beacon.facts.epochRotated', { epoch: view.epoch, age: formatRelativeTime(view.rotated_at) }) : view.epoch }}</dd>
            </template>
            <dt :class="DT">{{ $t('fleet.monitoring.beacon.facts.lastAuth') }}</dt>
            <dd :class="DD_TEXT" :title="view.last_auth_at">{{ view.last_auth_at ? formatRelativeTime(view.last_auth_at) : $t('fleet.monitoring.beacon.facts.lastAuthNever') }}</dd>
            <dt :class="DT">{{ $t('fleet.monitoring.beacon.facts.exposure') }}</dt>
            <dd :class="cn(DD_TEXT, openToInternet && 'text-warning-text')" data-testid="beacon-exposure">{{ exposure }}</dd>
            <template v-if="reachLine">
              <dt :class="DT">{{ $t('fleet.monitoring.beacon.facts.reach') }}</dt>
              <dd :class="cn(DD_TEXT, reachLine.warn && 'text-warning-text')" data-testid="beacon-reach">{{ reachLine.text }}</dd>
            </template>
          </dl>

          <!-- D3: without NetGuard the console says the port is open to the internet. -->
          <div v-if="openToInternet" :class="cn(NOTE, 'space-y-0.5 border border-warning/40 bg-warning/5')" role="note" data-testid="beacon-internet">
            <p class="flex items-center gap-1.5 font-medium text-warning-text">
              <ShieldAlert class="size-4 shrink-0" aria-hidden="true" />
              {{ $t('fleet.monitoring.beacon.exposure.internetTitle') }}
            </p>
            <p class="text-muted-foreground">{{ $t('fleet.monitoring.beacon.exposure.internet', { port: applied?.port ?? '' }) }}</p>
          </div>

          <!-- D12: with a NetGuard companion the beacon stays closed to sources until its task succeeds, and stays closed if it fails. -->
          <div v-if="companionState?.kind === 'failed'" :class="cn(NOTE, 'space-y-1.5 border border-destructive/40 bg-destructive/5')" role="alert" data-testid="beacon-companion-failed">
            <p class="flex items-center gap-1.5 font-medium text-destructive">
              <ShieldAlert class="size-4 shrink-0" aria-hidden="true" />
              {{ $t('fleet.monitoring.beacon.companion.failedTitle') }}
            </p>
            <p v-if="companionState.reason" class="font-mono break-words text-foreground">{{ companionState.reason }}</p>
            <p class="text-muted-foreground">{{ $t('fleet.monitoring.beacon.companion.failed') }}</p>
            <p class="flex flex-wrap items-center gap-x-4 gap-y-1">
              <button v-if="actions.change && !view.pending_approval_id" type="button" class="font-medium text-foreground underline underline-offset-2 pointer-coarse:min-h-11" data-testid="beacon-companion-replan" @click="openPlan('change')">
                {{ $t('fleet.monitoring.beacon.waiting.action') }}
              </button>
              <RouterLink
                v-if="view.applied_approval_id"
                :to="{ name: 'approvals', query: { open: view.applied_approval_id } }"
                class="font-medium text-foreground underline underline-offset-2 pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center"
              >
                {{ $t('fleet.monitoring.beacon.companion.openPlan') }}
              </RouterLink>
            </p>
          </div>
          <div v-else-if="companionState?.kind === 'applying'" :class="cn(NOTE, 'space-y-1 bg-warning/10 text-warning-text')" role="status" data-testid="beacon-companion-applying" :data-blocked="companionState.blocked || undefined">
            <p class="break-words">{{ $t('fleet.monitoring.beacon.companion.applying') }}</p>
            <p v-if="companionState.reason" :class="cn('break-words', companionState.blocked ? 'font-medium' : 'text-foreground/80')">{{ companionState.reason }}</p>
          </div>
          <div v-else-if="companionClosed" :class="cn(NOTE, 'space-y-1 bg-warning/10 text-warning-text')" role="status" data-testid="beacon-companion-pending">
            <p class="break-words">{{ $t('fleet.monitoring.beacon.line.companionPending') }}</p>
            <p v-if="companion?.kind === 'denied'" class="break-words text-foreground/80" data-testid="beacon-companion-denied">{{ $t('fleet.monitoring.beacon.companion.denied') }}</p>
          </div>

          <!-- Sources that use the beacon but are not admitted yet: firewall pending under NetGuard. -->
          <div v-if="waiting.length" :class="cn(NOTE, 'space-y-1.5 bg-warning/10 text-warning-text')" role="status" data-testid="beacon-waiting">
            <p class="break-words">
              {{ view.firewall_pending || view.exposure === 'netguard'
                ? $t('fleet.monitoring.beacon.waiting.firewall', { names: waitingNames }, waiting.length)
                : $t('fleet.monitoring.beacon.waiting.plan', { names: waitingNames }, waiting.length) }}
            </p>
            <!-- A plan already waits: review it rather than file another. -->
            <RouterLink
              v-if="view.pending_approval_id"
              :to="{ name: 'approvals', query: { open: view.pending_approval_id } }"
              class="inline-block font-medium text-foreground underline underline-offset-2 pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center"
              data-testid="beacon-waiting-review"
            >{{ $t('fleet.monitoring.beacon.waiting.review') }}</RouterLink>
            <button v-else-if="actions.change" type="button" class="font-medium text-foreground underline underline-offset-2 pointer-coarse:min-h-11" data-testid="beacon-waiting-plan" @click="openPlan('change')">
              {{ $t('fleet.monitoring.beacon.waiting.action') }}
            </button>
          </div>

          <!-- Who may send, and who does. -->
          <section v-if="enabled" class="space-y-1.5" data-testid="beacon-sources">
            <h3 class="text-xs font-medium text-muted-foreground">
              {{ $t('fleet.monitoring.beacon.sources.title') }}
              <span v-if="sourceRows.length" class="font-normal tabular">{{ sourceRows.length }}</span>
            </h3>
            <ul v-if="sourceRows.length" class="divide-y divide-border border-y border-border text-xs">
              <li v-for="row in sourceRows" :key="row.s.node_id" class="flex min-w-0 items-baseline justify-between gap-3 py-1.5" :data-source-status="row.status">
                <span class="min-w-0 truncate" :title="row.s.name || row.s.node_id">{{ row.s.name || row.s.node_id }}</span>
                <span :class="cn('shrink-0 text-end', row.status === 'waiting' ? 'text-warning-text' : 'text-muted-foreground')">{{ $t(`fleet.monitoring.beacon.sources.${row.status}`) }}</span>
              </li>
            </ul>
            <p v-else class="text-xs text-muted-foreground">{{ $t('fleet.monitoring.beacon.sources.empty') }}</p>
          </section>

          <!-- What this session may do. -->
          <div v-if="anyAction" class="flex flex-wrap gap-2" data-testid="beacon-actions">
            <Button v-if="actions.enable" size="sm" :variant="view.pending_approval_id ? 'outline' : 'default'" :disabled="!!actions.enableBlocked" data-testid="beacon-enable" @click="openPlan('enable')">
              <Power class="size-4" aria-hidden="true" />
              {{ $t('fleet.monitoring.beacon.actions.enable') }}
            </Button>
            <Button v-if="actions.change" size="sm" variant="outline" data-testid="beacon-change" @click="openPlan('change')">
              <SlidersHorizontal class="size-4" aria-hidden="true" />
              {{ $t('fleet.monitoring.beacon.actions.change') }}
            </Button>
            <Button v-if="actions.rotate" size="sm" variant="outline" data-testid="beacon-rotate" @click="rotateOpen = true">
              <KeyRound class="size-4" aria-hidden="true" />
              {{ $t('fleet.monitoring.beacon.actions.rotate') }}
            </Button>
            <Button v-if="actions.disable" size="sm" variant="outline" class="text-destructive" data-testid="beacon-disable" @click="openPlan('disable')">
              <Power class="size-4" aria-hidden="true" />
              {{ $t('fleet.monitoring.beacon.actions.disable') }}
            </Button>
          </div>
          <p v-if="view.pending_approval_id && (actions.enable || actions.change)" class="text-xs text-muted-foreground" data-testid="beacon-another-plan">
            {{ $t('fleet.monitoring.beacon.actions.anotherPlan') }}
          </p>
          <p v-if="actions.missing.length" class="text-xs text-muted-foreground" data-testid="beacon-missing-scopes">
            {{ $t('fleet.monitoring.beacon.actions.missing', { scopes: actions.missing.join(', ') }) }}
          </p>
        </div>
      </DataState>
    </CardContent>
  </Card>

  <BeaconPlanSheet v-if="view" :open="sheetOpen" :action="sheetAction" :node="node" :view="view" @close="sheetOpen = false" @filed="onFiled" />
  <ConfirmDialog
    v-if="view"
    v-model:open="rotateOpen"
    :title="$t('fleet.monitoring.beacon.rotate.title', { name })"
    :description="$t('fleet.monitoring.beacon.rotate.description', { next: nextEpoch(view), epoch: view.epoch ?? 0 })"
    variant="default"
    :confirm-label="$t('fleet.monitoring.beacon.rotate.confirm')"
    :cancel-label="$t('fleet.monitoring.beacon.rotate.cancel')"
    :pending="rotating"
    @confirm="rotate"
  />
</template>

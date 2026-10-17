<script setup lang="ts">
/**
 * A node.beacon plan (design 29 D3, D12): enable, change or turn off a
 * node's beacon. Opening a port on a node is never a direct write; the sheet
 * files a plan, and someone with network:apply approves it in Approvals.
 *
 * Two stages. The form says what the plan will ask before anything exists:
 * what opens and where, where sources send, which sources will hold a key,
 * the exposure and the limits, with the address rules of lattice-sdk package
 * beacon applied as the operator types. Create plan files it; the sheet then
 * shows the server's own document, which is what the approval binds: the
 * settings before and after, the sources with the addresses NetGuard will
 * admit, the NetGuard companion and its ruleset hash, the findings, and the
 * plan text with its SHA-256. A plan a finding blocks (409) is refused with
 * the findings, in the form.
 *
 * Opened for a re-plan (the server's replan: sources that use the beacon and
 * are not admitted, or that NetGuard still admits after they left), the form
 * says first, in plain words, who cannot measure the node until the plan is
 * approved; its fields open on the applied settings, so untouched they file
 * exactly the server's request.
 */
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink } from "vue-router";
import { FilePlus2, RefreshCw, ShieldAlert } from "lucide-vue-next";

import { api, unwrap, type BeaconFinding, type BeaconPlanAction, type BeaconPlanResponse, type BeaconView, type Node } from "@/lib/api";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { usePlanDigest } from "@/composables/usePlanDigest";

import ConfirmDialog from "@/components/common/ConfirmDialog.vue";
import CopyButton from "@/components/common/CopyButton.vue";
import ObjectSheet from "@/components/common/ObjectSheet.vue";
import ScriptView from "@/components/common/ScriptView.vue";
import BeaconReplanNote from "./BeaconReplanNote.vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { publicIPv4 } from "./checkRulesModel";
import {
  BEACON_PORT_MAX,
  BEACON_PORT_MIN,
  DEFAULT_BEACON_LIMITS,
  buildBeaconPlanRequest,
  changedSettings,
  companionAllowCount,
  OTHER_ADDRESS,
  beaconForbidden,
  defaultBind,
  endpointAddresses,
  formFor,
  plannedSettings,
  readBeaconPlan,
  refusalField,
  replanNames,
  refusedFindings,
  settingsRows,
  shortHash,
  sortFindings,
  type BeaconForm,
  type BeaconFormField,
  type BeaconFormProblem,
  type BeaconReplanItem,
  type EndpointAddress,
} from "./beaconModel";

const props = defineProps<{
  open: boolean;
  action: BeaconPlanAction;
  node: Pick<Node, "id" | "name" | "internal_ip" | "public_ip">;
  view: BeaconView;
  /** Why the sources need this change plan, when it was opened for one. */
  replan?: BeaconReplanItem;
}>();
const emit = defineEmits<{ close: []; filed: [approvalId: string] }>();

const { t } = useI18n();
const planDigest = usePlanDigest();

const form = ref<BeaconForm>(formFor(props.action, props.view, props.node));
const stage = ref<"form" | "filed">("form");
const pending = ref(false);
const refusal = ref<string>();
/** The field a refusal is about, marked beside the server's words. */
const refusalAt = ref<BeaconFormField>();
const blocked = ref<BeaconFinding[]>([]);
/** The form as it opened, so closing over typed edits asks first, as the check editor does. */
const opened = ref("");
/** "Another address" says what is missing only once something was typed there. */
const otherTouched = ref(false);
const discardOpen = ref(false);
const filed = ref<BeaconPlanResponse>();
const digest = ref("");
const showText = ref(false);

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    form.value = formFor(props.action, props.view, props.node);
    opened.value = JSON.stringify(form.value);
    otherTouched.value = false;
    stage.value = "form";
    refusal.value = undefined;
    refusalAt.value = undefined;
    blocked.value = [];
    filed.value = undefined;
    digest.value = "";
    showText.value = false;
  },
  { immediate: true },
);
// A refusal answers the form it was given; a changed form is another request.
watch(form, () => {
  refusal.value = undefined;
  refusalAt.value = undefined;
  blocked.value = [];
}, { deep: true });
const dirty = computed(() => stage.value === "form" && JSON.stringify(form.value) !== opened.value);

const name = computed(() => props.node.name || props.node.id);
const title = computed(() => (stage.value === "filed" ? t("fleet.monitoring.beacon.plan.filed.title") : t(`fleet.monitoring.beacon.plan.title.${props.action}`, { name: name.value })));
const planned = computed(() => plannedSettings(props.action, form.value, props.view, props.node));
const problemOf = (field: BeaconFormProblem["field"]) => planned.value.problems.find((p) => p.field === field);

function problemText(p: BeaconFormProblem | undefined): string {
  if (!p) return "";
  switch (p.field) {
    case "port":
      return t("fleet.monitoring.beacon.plan.problem.port");
    case "bind":
      return t(p.code === "noDefault" ? "fleet.monitoring.beacon.plan.problem.noDefaultBind" : `fleet.monitoring.beacon.plan.problem.${p.code}`);
    case "endpointAddress":
      return t(`fleet.monitoring.beacon.plan.problem.${p.code}`);
    case "endpointPort":
      return t(p.code === "needed" ? "fleet.monitoring.beacon.plan.problem.endpointPortNeeded" : "fleet.monitoring.beacon.plan.problem.endpointPort");
  }
}

/**
 * The line under a field: what the form refuses, else that the server
 * refused the plan over it (its words are in the body). An empty "Another
 * address" says so only once something was typed there.
 */
function fieldError(field: BeaconFormField): string {
  const p = problemOf(field);
  const untouched = p?.field === "endpointAddress" && p.code === "missing" && form.value.endpointAddress === OTHER_ADDRESS && !otherTouched.value;
  if (p && !untouched) return problemText(p);
  return refusalAt.value === field ? t("fleet.monitoring.beacon.plan.refusedHere") : "";
}
/** The preview cannot say what opens, or where sources send, until the fields it depends on are fixed. */
const opensUnknown = computed(() => !!problemOf("port") || !!problemOf("bind"));
const sendUnknown = computed(() => !!problemOf("endpointAddress") || !!problemOf("endpointPort") || (!!problemOf("port") && !form.value.endpointPort.trim()));

const isChange = computed(() => props.action === "change");
const applied = computed(() => props.view.applied ?? undefined);
const fallbackBind = computed(() => defaultBind(props.node));
const publicIp = computed(() => publicIPv4(props.node.public_ip));
/** The node's own addresses, and on a change the applied endpoint's when it is neither; a line's edge is typed. */
const addresses = computed(() => endpointAddresses(props.node, isChange.value ? applied.value : undefined));
const chosen = computed(() => addresses.value.find((a) => a.address === form.value.endpointAddress));
function addressLabel(a: EndpointAddress): string {
  return t(`fleet.monitoring.beacon.plan.addressKind.${a.kind}`, { address: a.address });
}
/** What an empty send port means: the listen port the plan opens, or the one the control plane draws. */
const listenPortText = computed(() => (planned.value.port ? String(planned.value.port) : t("fleet.monitoring.beacon.plan.portRandom")));

/** The sources that will hold a key: the current set, which the plan approves. */
const keySources = computed(() =>
  (props.view.sources ?? [])
    .filter((s) => s.current)
    .map((s) => s.name || s.node_id)
    .sort((a, b) => a.localeCompare(b)),
);
const changed = computed(() => (isChange.value ? changedSettings(form.value, props.view, props.node) : []));
const replanFor = computed(() => (isChange.value && props.replan ? { item: props.replan, names: replanNames(props.replan, props.view) } : undefined));
const limits = DEFAULT_BEACON_LIMITS;

const canSubmit = computed(() => !pending.value && planned.value.problems.length === 0);

async function submit(): Promise<void> {
  if (!canSubmit.value) return;
  pending.value = true;
  refusal.value = undefined;
  refusalAt.value = undefined;
  blocked.value = [];
  let response: BeaconPlanResponse;
  try {
    response = await api.nodes.beacon.plan(buildBeaconPlanRequest(props.node, props.action, form.value, props.view));
  } catch (error) {
    const findings = refusedFindings(error);
    const message = error instanceof Error ? error.message : String(error);
    refusalAt.value = beaconForbidden(error) ? undefined : refusalField(message, findings);
    if (findings.length) blocked.value = findings;
    // D12: a plan names every source with its addresses, so a session that cannot read one of them is refused.
    else if (beaconForbidden(error)) refusal.value = t("fleet.monitoring.beacon.plan.forbidden");
    else refusal.value = t("fleet.monitoring.beacon.plan.failed", { reason: message });
    pending.value = false;
    await nextTick();
    document.querySelector("[data-refusal]")?.scrollIntoView({ block: "nearest" });
    return;
  }
  // The approval exists from here on: the sheet shows it even if the digest cannot be computed, so a second click never files another.
  filed.value = response;
  stage.value = "filed";
  pending.value = false;
  toast.success(t("fleet.monitoring.beacon.plan.filed.toast"));
  emit("filed", response.approval.id);
  try {
    digest.value = await planDigest.digestFor(response.approval);
  } catch {
    digest.value = "";
  }
}

function requestClose(): void {
  if (pending.value) return;
  if (dirty.value) {
    discardOpen.value = true;
    return;
  }
  emit("close");
}

function discard(): void {
  discardOpen.value = false;
  emit("close");
}

/* ---- What turning it off stops ---- */

/** The Beacon checks that name this node: turning the beacon off leaves each of them unknown. */
const stoppedChecks = ref<string[]>([]);
watch(
  () => props.open && props.action === "disable",
  async (reading) => {
    stoppedChecks.value = [];
    if (!reading) return;
    try {
      const monitors = unwrap(await api.monitors.list(), "monitors");
      stoppedChecks.value = monitors
        .filter((m) => m.type === "beacon" && m.target_node === props.node.id && !m.managed_by)
        .map((m) => m.name || m.id)
        .sort((a, b) => a.localeCompare(b));
    } catch {
      // The line is left out; the plan says the rest.
    }
  },
  { immediate: true },
);

/* ---- The filed plan ---- */

const plan = computed(() => (filed.value ? readBeaconPlan(filed.value.approval.plan, filed.value.plan) : undefined));
const rows = computed(() => (plan.value ? settingsRows(plan.value) : []));
const findings = computed(() => sortFindings(filed.value?.findings));
const planSources = computed(() => [...(plan.value?.sources ?? [])].sort((a, b) => (a.name || a.node_id).localeCompare(b.name || b.node_id)));
const approvalId = computed(() => filed.value?.approval.id ?? "");

function rowValue(key: string, value: string | undefined): string {
  if (key === "state") return value === "on" ? t("fleet.monitoring.beacon.plan.filed.on") : t("fleet.monitoring.beacon.plan.filed.off");
  return value ?? "";
}

const SECTION = "grid min-w-0 gap-2.5 border-0 p-0";
const STEP = "text-xs font-medium uppercase tracking-wide text-muted-foreground";
const NOTE = "rounded-md px-2.5 py-2 text-xs";
</script>

<template>
  <ObjectSheet :open="open" :title="title" :subtitle="stage === 'filed' ? approvalId : node.id" mono-subtitle @close="requestClose">
    <!-- ───── The form, and what the plan will ask ───── -->
    <form v-if="stage === 'form'" id="beacon-plan" class="space-y-6 text-sm" data-testid="beacon-plan-form" @submit.prevent="submit">
      <!-- Why this plan: who cannot measure the node until it is approved. -->
      <BeaconReplanNote v-if="replanFor" :item="replanFor.item" :target="name" :names="replanFor.names" :action="false" tone="warning" />
      <template v-if="action !== 'disable'">
        <fieldset :class="SECTION">
          <legend :class="STEP" class="mb-2.5">{{ $t('fleet.monitoring.beacon.plan.step.where') }}</legend>
          <div class="grid max-w-48 gap-1.5">
            <Label for="beacon-port">{{ $t('fleet.monitoring.beacon.plan.port') }}</Label>
            <Input
              id="beacon-port"
              v-model="form.port"
              inputmode="numeric"
              class="font-mono"
              :placeholder="isChange && applied?.port ? String(applied.port) : view.suggested_port ? String(view.suggested_port) : $t('fleet.monitoring.beacon.plan.portRandom')"
              :aria-invalid="!!fieldError('port') || undefined"
              :aria-describedby="fieldError('port') ? 'beacon-port-error' : 'beacon-port-hint'"
            />
          </div>
          <p id="beacon-port-hint" class="text-xs text-muted-foreground">
            {{ $t('fleet.monitoring.beacon.plan.portHint', { min: BEACON_PORT_MIN, max: BEACON_PORT_MAX }) }}
            <template v-if="isChange && applied?.port">{{ $t('fleet.monitoring.beacon.plan.keepHint', { value: applied.port }) }}</template>
          </p>
          <p v-if="fieldError('port')" id="beacon-port-error" role="alert" class="text-xs text-destructive">{{ fieldError('port') }}</p>

          <div class="grid max-w-72 gap-1.5">
            <Label for="beacon-bind">{{ $t('fleet.monitoring.beacon.plan.bind') }}</Label>
            <Input
              id="beacon-bind"
              v-model="form.bind"
              class="font-mono"
              spellcheck="false"
              :placeholder="isChange ? applied?.bind : fallbackBind"
              :aria-invalid="!!fieldError('bind') || undefined"
              :aria-describedby="fieldError('bind') ? 'beacon-bind-error' : 'beacon-bind-hint'"
            />
          </div>
          <p id="beacon-bind-hint" class="text-xs text-muted-foreground">
            <template v-if="isChange && applied?.bind">{{ $t('fleet.monitoring.beacon.plan.keepHint', { value: applied.bind }) }}</template>
            <template v-else>{{ fallbackBind ? $t('fleet.monitoring.beacon.plan.bindHint', { address: fallbackBind }) : $t('fleet.monitoring.beacon.plan.bindHintNone') }}</template>
          </p>
          <p v-if="fieldError('bind')" id="beacon-bind-error" role="alert" class="text-xs text-destructive">{{ fieldError('bind') }}</p>
        </fieldset>

        <fieldset :class="SECTION">
          <legend :class="STEP" class="mb-2.5">{{ $t('fleet.monitoring.beacon.plan.step.send') }}</legend>
          <div class="grid max-w-96 gap-1.5">
            <Label for="beacon-endpoint-address">{{ $t('fleet.monitoring.beacon.plan.endpointAddress') }}</Label>
            <select
              id="beacon-endpoint-address"
              v-model="form.endpointAddress"
              class="h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm tabular-nums shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:min-h-11"
              :aria-invalid="(form.endpointAddress !== OTHER_ADDRESS && !!fieldError('endpointAddress')) || undefined"
              :aria-describedby="form.endpointAddress === OTHER_ADDRESS ? undefined : fieldError('endpointAddress') ? 'beacon-endpoint-address-error' : 'beacon-endpoint-address-hint'"
              data-testid="beacon-endpoint-address"
            >
              <option v-for="a in addresses" :key="a.address" :value="a.address">{{ addressLabel(a) }}</option>
              <option :value="OTHER_ADDRESS">{{ $t('fleet.monitoring.beacon.plan.addressKind.other') }}</option>
            </select>
          </div>
          <p v-if="form.endpointAddress !== OTHER_ADDRESS" id="beacon-endpoint-address-hint" :class="cn('text-xs', chosen?.kind === 'current' ? 'text-warning-text' : 'text-muted-foreground')">
            {{ chosen?.kind === 'current' ? $t('fleet.monitoring.beacon.plan.endpointCurrentHint') : $t('fleet.monitoring.beacon.plan.endpointAddressHint') }}
          </p>
          <p v-if="form.endpointAddress !== OTHER_ADDRESS && fieldError('endpointAddress')" id="beacon-endpoint-address-error" role="alert" class="text-xs text-destructive">{{ fieldError('endpointAddress') }}</p>

          <template v-if="form.endpointAddress === OTHER_ADDRESS">
            <div class="grid max-w-72 gap-1.5">
              <Label for="beacon-endpoint-other">{{ $t('fleet.monitoring.beacon.plan.endpointOther') }}</Label>
              <Input
                id="beacon-endpoint-other"
                v-model="form.endpointOther"
                class="font-mono"
                spellcheck="false"
                inputmode="decimal"
                placeholder="198.51.100.40"
                :aria-invalid="!!fieldError('endpointAddress') || undefined"
                :aria-describedby="fieldError('endpointAddress') ? 'beacon-endpoint-other-error' : 'beacon-endpoint-other-hint'"
                data-testid="beacon-endpoint-other"
                @input="otherTouched = true"
              />
            </div>
            <p id="beacon-endpoint-other-hint" class="text-xs text-muted-foreground">{{ $t('fleet.monitoring.beacon.plan.endpointOtherHint') }}</p>
            <p v-if="fieldError('endpointAddress')" id="beacon-endpoint-other-error" role="alert" class="text-xs text-destructive">{{ fieldError('endpointAddress') }}</p>
          </template>

          <div class="grid max-w-48 gap-1.5">
            <Label for="beacon-endpoint-port">{{ $t('fleet.monitoring.beacon.plan.endpointPort') }}</Label>
            <Input
              id="beacon-endpoint-port"
              v-model="form.endpointPort"
              inputmode="numeric"
              class="font-mono"
              :placeholder="listenPortText"
              :aria-invalid="!!fieldError('endpointPort') || undefined"
              :aria-describedby="fieldError('endpointPort') ? 'beacon-endpoint-port-error' : 'beacon-endpoint-port-hint'"
              data-testid="beacon-endpoint-port"
            />
          </div>
          <p id="beacon-endpoint-port-hint" class="text-xs text-muted-foreground">{{ $t('fleet.monitoring.beacon.plan.endpointPortHint') }}</p>
          <p v-if="fieldError('endpointPort')" id="beacon-endpoint-port-error" role="alert" class="text-xs text-destructive">{{ fieldError('endpointPort') }}</p>
        </fieldset>
      </template>

      <!-- What the plan will ask, before it exists. -->
      <fieldset :class="SECTION" data-testid="beacon-plan-asks">
        <legend :class="STEP" class="mb-2.5">{{ $t('fleet.monitoring.beacon.plan.step.asks') }}</legend>
        <ul class="grid gap-1.5 rounded-md border border-border p-3 text-xs">
          <template v-if="action === 'disable'">
            <li>{{ $t('fleet.monitoring.beacon.plan.asks.closes', { port: applied?.port ?? '' }) }}</li>
            <li v-if="view.exposure === 'netguard'">{{ $t('fleet.monitoring.beacon.plan.asks.closesNetguard') }}</li>
            <!-- What stops, by name: the sources using it now and the Beacon checks to this node. -->
            <li v-if="keySources.length" class="break-words" data-testid="beacon-plan-stops-sources">{{ $t('fleet.monitoring.beacon.plan.asks.closesSources', { names: keySources.join(', ') }, keySources.length) }}</li>
            <li v-if="stoppedChecks.length" class="break-words text-warning-text" data-testid="beacon-plan-stops-checks">{{ $t('fleet.monitoring.beacon.plan.asks.closesChecks', { names: stoppedChecks.join(', ') }, stoppedChecks.length) }}</li>
            <li v-if="!publicIp" class="break-words text-warning-text">{{ $t('fleet.monitoring.beacon.plan.asks.closesNoIcmp') }}</li>
          </template>
          <template v-else>
            <li v-if="isChange && changed.length === 0 && !planned.problems.length">{{ $t('fleet.monitoring.beacon.plan.asks.resources') }}</li>
            <!-- A field the form refuses leaves its line saying so, never the applied value or nothing. -->
            <li v-if="opensUnknown" class="text-muted-foreground">{{ $t('fleet.monitoring.beacon.plan.asks.fixOpens') }}</li>
            <li v-else-if="planned.port && planned.bind" class="font-mono break-all">{{ $t('fleet.monitoring.beacon.plan.asks.opens', { port: planned.port, bind: planned.bind }) }}</li>
            <li v-else-if="planned.portRandom && planned.bind" class="break-words">{{ $t('fleet.monitoring.beacon.plan.asks.opensRandom', { bind: planned.bind }) }}</li>
            <li v-if="sendUnknown" class="text-muted-foreground">{{ $t('fleet.monitoring.beacon.plan.asks.fixSend') }}</li>
            <li v-else-if="planned.endpoint" class="font-mono break-all">{{ $t('fleet.monitoring.beacon.plan.asks.send', { endpoint: planned.endpoint }) }}</li>
            <li v-else-if="planned.endpointDefault && publicIp" class="break-words">{{ $t('fleet.monitoring.beacon.plan.asks.sendRandom', { ip: publicIp }) }}</li>
            <li v-if="keySources.length" class="break-words">{{ $t('fleet.monitoring.beacon.plan.asks.sources', { names: keySources.join(', ') }, keySources.length) }}</li>
            <li v-else class="text-muted-foreground">{{ $t('fleet.monitoring.beacon.plan.asks.noSources') }}</li>
            <li v-if="view.exposure === 'netguard'">{{ $t('fleet.monitoring.beacon.plan.asks.netguard') }}</li>
            <li v-else-if="view.exposure === 'internet'" class="text-warning-text">{{ $t('fleet.monitoring.beacon.plan.asks.internet') }}</li>
            <li v-else class="text-warning-text">{{ $t('fleet.monitoring.beacon.plan.asks.exposureUnknown') }}</li>
            <li class="text-muted-foreground">{{ $t('fleet.monitoring.beacon.plan.asks.limits', { rate: limits.source_rate_per_second, interval: limits.min_interval_sec, pps: limits.packets_per_second_max }) }}</li>
          </template>
          <li class="font-medium">{{ $t('fleet.monitoring.beacon.plan.asks.unchanged') }}</li>
        </ul>
      </fieldset>

      <!-- Every refusal lands here, one place, scrolled into view; the field it names is marked above. -->
      <p v-if="refusal" :class="cn(NOTE, 'flex scroll-mt-4 items-start gap-1.5 border border-destructive/40 bg-destructive/5 text-destructive')" role="alert" data-refusal data-testid="beacon-plan-refused">
        <ShieldAlert class="mt-px size-4 shrink-0" aria-hidden="true" />
        <span class="min-w-0 break-words">{{ refusal }}</span>
      </p>
      <div v-if="blocked.length" :class="cn(NOTE, 'scroll-mt-4 space-y-1.5 border border-destructive/40 bg-destructive/5')" role="alert" data-refusal data-testid="beacon-plan-blocked">
        <p class="flex items-center gap-1.5 font-medium text-destructive">
          <ShieldAlert class="size-4 shrink-0" aria-hidden="true" />
          {{ $t('fleet.monitoring.beacon.plan.blocked') }}
        </p>
        <ul class="space-y-1">
          <li v-for="f in blocked" :key="f.code + f.message" class="flex items-start gap-2">
            <Badge class="mt-px shrink-0" :variant="f.severity === 'block' ? 'destructive' : 'warning'">{{ $t(`fleet.monitoring.beacon.plan.filed.severity.${f.severity === 'block' ? 'block' : 'warn'}`) }}</Badge>
            <span class="min-w-0 break-words"><code class="font-mono">{{ f.code }}</code> <span class="text-muted-foreground">{{ f.message }}</span></span>
          </li>
        </ul>
      </div>
    </form>

    <!-- ───── The filed plan: the server's document ───── -->
    <div v-else-if="plan && filed" class="space-y-6 text-sm" data-testid="beacon-plan-filed">
      <div class="space-y-1.5">
        <div class="flex flex-wrap items-center gap-2">
          <Badge variant="warning">{{ $t(`common.status.${filed.approval.status}`) }}</Badge>
          <Badge variant="outline">{{ $t('operations.approvals.kinds.nodeBeacon') }}</Badge>
        </div>
        <p class="text-muted-foreground">{{ $t('fleet.monitoring.beacon.plan.filed.lead') }}</p>
      </div>

      <section :class="SECTION" :aria-label="$t('fleet.monitoring.beacon.plan.filed.settings')">
        <h3 :class="STEP">{{ $t('fleet.monitoring.beacon.plan.filed.settings') }}</h3>
        <table class="w-full table-fixed text-xs" data-testid="beacon-plan-settings">
          <thead class="text-muted-foreground">
            <tr class="border-b border-border">
              <th scope="col" class="w-[30%] py-1.5 text-start font-medium">{{ $t('fleet.monitoring.beacon.plan.filed.setting') }}</th>
              <th scope="col" class="py-1.5 text-start font-medium">{{ $t('fleet.monitoring.beacon.plan.filed.before') }}</th>
              <th scope="col" class="py-1.5 text-start font-medium">{{ $t('fleet.monitoring.beacon.plan.filed.after') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in rows" :key="row.key" class="border-b border-border/60 align-top" :data-changed="row.changed || undefined">
              <th scope="row" class="py-1.5 pe-2 text-start font-normal text-muted-foreground">{{ $t(`fleet.monitoring.beacon.plan.filed.rows.${row.key}`) }}</th>
              <td class="py-1.5 pe-2 font-mono break-all text-muted-foreground">{{ rowValue(row.key, row.before) }}</td>
              <td :class="cn('py-1.5 font-mono break-all', row.changed && 'font-medium text-foreground')">{{ rowValue(row.key, row.after) }}</td>
            </tr>
          </tbody>
        </table>
        <p v-if="plan.beacon.enabled" class="text-xs text-muted-foreground">
          <span class="font-medium text-foreground">{{ $t('fleet.monitoring.beacon.plan.filed.limits') }}</span>
          {{ $t('fleet.monitoring.beacon.plan.filed.limitsValue', { rate: plan.beacon.limits.source_rate_per_second, interval: plan.beacon.limits.min_interval_sec, pps: plan.beacon.limits.packets_per_second_max }) }}
        </p>
      </section>

      <section v-if="plan.beacon.enabled" :class="SECTION" data-testid="beacon-plan-sources">
        <h3 :class="STEP">{{ $t('fleet.monitoring.beacon.plan.filed.sources') }} <span class="font-normal normal-case tabular">{{ planSources.length }}</span></h3>
        <ul v-if="planSources.length" class="divide-y divide-border rounded-md border border-border text-xs">
          <li v-for="s in planSources" :key="s.node_id" class="grid gap-0.5 px-2.5 py-2">
            <span class="flex min-w-0 items-baseline justify-between gap-2">
              <span class="truncate font-medium" :title="s.name || s.node_id">{{ s.name || s.node_id }}</span>
              <span class="shrink-0 font-mono text-muted-foreground">{{ $t('fleet.monitoring.beacon.sources.id', { id: s.source_id }) }}</span>
            </span>
            <span v-if="s.allow?.length" class="font-mono break-all text-muted-foreground">{{ s.allow.join(' ') }}</span>
          </li>
        </ul>
        <p v-else class="text-xs text-muted-foreground">{{ $t('fleet.monitoring.beacon.plan.filed.noSources') }}</p>
      </section>

      <section v-if="plan.beacon.enabled" :class="SECTION" data-testid="beacon-plan-exposure">
        <h3 :class="STEP">{{ $t('fleet.monitoring.beacon.plan.filed.exposure') }}</h3>
        <div v-if="plan.netguard" class="space-y-1 rounded-md border border-border p-3 text-xs">
          <p>{{ $t('fleet.monitoring.beacon.plan.filed.netguard', { port: plan.netguard.port, n: companionAllowCount(plan) }, companionAllowCount(plan)) }}</p>
          <p class="flex flex-wrap items-center gap-1.5 font-mono text-muted-foreground">
            <span :title="plan.netguard.ruleset_sha256">{{ $t('fleet.monitoring.beacon.plan.filed.ruleset', { hash: shortHash(plan.netguard.ruleset_sha256), version: plan.netguard.binding_version }) }}</span>
            <CopyButton :value="plan.netguard.ruleset_sha256" />
          </p>
        </div>
        <p v-else :class="cn(NOTE, 'flex items-start gap-1.5 border border-warning/40 bg-warning/5 text-warning-text')" role="status">
          <ShieldAlert class="mt-px size-4 shrink-0" aria-hidden="true" />
          {{ $t('fleet.monitoring.beacon.plan.filed.internet') }}
        </p>
      </section>

      <section v-if="findings.length" :class="SECTION" data-testid="beacon-plan-findings">
        <h3 :class="STEP">{{ $t('fleet.monitoring.beacon.plan.filed.findings') }}</h3>
        <ul class="space-y-1.5 text-xs">
          <li v-for="f in findings" :key="f.code + f.message" class="flex items-start gap-2">
            <Badge class="mt-px shrink-0" :variant="f.severity === 'block' ? 'destructive' : 'warning'">{{ $t(`fleet.monitoring.beacon.plan.filed.severity.${f.severity === 'block' ? 'block' : 'warn'}`) }}</Badge>
            <span class="min-w-0 break-words"><code class="font-mono">{{ f.code }}</code> <span class="text-muted-foreground">{{ f.message }}</span></span>
          </li>
        </ul>
      </section>

      <section :class="SECTION">
        <h3 :class="STEP">{{ $t('fleet.monitoring.beacon.plan.filed.planText') }}</h3>
        <div v-if="digest" class="flex flex-wrap items-center gap-2 rounded-md bg-muted/40 p-2.5 text-xs" data-testid="beacon-plan-digest">
          <span class="font-medium">{{ $t('fleet.monitoring.beacon.plan.filed.digest') }}</span>
          <code class="min-w-0 break-all font-mono">{{ digest }}</code>
          <CopyButton :value="digest" />
        </div>
        <Button type="button" variant="outline" size="sm" class="justify-self-start" :aria-expanded="showText" @click="showText = !showText">
          {{ showText ? $t('fleet.monitoring.beacon.plan.filed.hide') : $t('fleet.monitoring.beacon.plan.filed.show') }}
        </Button>
        <ScriptView v-if="showText" :text="filed.approval.plan || ''" language="plain" wrap max-height="360px" :label="$t('fleet.monitoring.beacon.plan.filed.planText')" />
      </section>
    </div>

    <template #actions>
      <template v-if="stage === 'form'">
        <Button variant="outline" size="sm" type="button" @click="requestClose">{{ $t('common.actions.cancel') }}</Button>
        <Button type="submit" form="beacon-plan" size="sm" :variant="action === 'disable' ? 'destructive' : 'default'" :disabled="!canSubmit" data-testid="beacon-plan-submit">
          <RefreshCw v-if="pending" class="size-4 animate-spin" aria-hidden="true" />
          <FilePlus2 v-else class="size-4" aria-hidden="true" />
          {{ $t('fleet.monitoring.beacon.plan.create') }}
        </Button>
      </template>
      <template v-else>
        <Button variant="outline" size="sm" type="button" @click="requestClose">{{ $t('common.actions.close') }}</Button>
        <Button as-child size="sm">
          <RouterLink :to="{ name: 'approvals', query: { open: approvalId } }" data-testid="beacon-plan-review">{{ $t('fleet.monitoring.beacon.plan.filed.review') }}</RouterLink>
        </Button>
      </template>
    </template>
  </ObjectSheet>
  <ConfirmDialog
    v-model:open="discardOpen"
    :title="$t('fleet.monitoring.beacon.plan.discard.title')"
    :description="$t('fleet.monitoring.beacon.plan.discard.description')"
    :confirm-label="$t('fleet.monitoring.beacon.plan.discard.confirm')"
    :cancel-label="$t('fleet.monitoring.beacon.plan.discard.keep')"
    @confirm="discard"
  />
</template>

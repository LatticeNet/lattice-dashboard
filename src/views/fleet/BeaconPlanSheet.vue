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
 */
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink } from "vue-router";
import { FilePlus2, RefreshCw, ShieldAlert } from "lucide-vue-next";

import { api, type BeaconFinding, type BeaconPlanAction, type BeaconPlanResponse, type BeaconView, type Node } from "@/lib/api";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { usePlanDigest } from "@/composables/usePlanDigest";

import CopyButton from "@/components/common/CopyButton.vue";
import ObjectSheet from "@/components/common/ObjectSheet.vue";
import ScriptView from "@/components/common/ScriptView.vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import {
  BEACON_PORT_MAX,
  BEACON_PORT_MIN,
  DEFAULT_BEACON_LIMITS,
  buildBeaconPlanRequest,
  changedSettings,
  companionAllowCount,
  defaultBind,
  defaultEndpoint,
  formFor,
  plannedSettings,
  readBeaconPlan,
  refusedFindings,
  settingsRows,
  shortHash,
  sortFindings,
  type BeaconForm,
  type BeaconFormProblem,
} from "./beaconModel";

const props = defineProps<{
  open: boolean;
  action: BeaconPlanAction;
  node: Pick<Node, "id" | "name" | "internal_ip" | "public_ip">;
  view: BeaconView;
}>();
const emit = defineEmits<{ close: []; filed: [approvalId: string] }>();

const { t } = useI18n();
const planDigest = usePlanDigest();

const form = ref<BeaconForm>(formFor(props.action, props.view));
const stage = ref<"form" | "filed">("form");
const pending = ref(false);
const refusal = ref<string>();
const blocked = ref<BeaconFinding[]>([]);
const filed = ref<BeaconPlanResponse>();
const digest = ref("");
const showText = ref(false);

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    form.value = formFor(props.action, props.view);
    stage.value = "form";
    refusal.value = undefined;
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
  blocked.value = [];
}, { deep: true });

const name = computed(() => props.node.name || props.node.id);
const title = computed(() => (stage.value === "filed" ? t("fleet.monitoring.beacon.plan.filed.title") : t(`fleet.monitoring.beacon.plan.title.${props.action}`, { name: name.value })));
const planned = computed(() => plannedSettings(props.action, form.value, props.view, props.node));
const problemOf = (field: BeaconFormProblem["field"]) => planned.value.problems.find((p) => p.field === field);

function problemText(p: BeaconFormProblem | undefined): string {
  if (!p) return "";
  if (p.field === "port") return t("fleet.monitoring.beacon.plan.problem.port");
  if (p.code === "noDefault") return t(p.field === "bind" ? "fleet.monitoring.beacon.plan.problem.noDefaultBind" : "fleet.monitoring.beacon.plan.problem.noDefaultEndpoint");
  if (p.field === "endpoint" && p.code === "port") return t("fleet.monitoring.beacon.plan.problem.endpointPort");
  return t(`fleet.monitoring.beacon.plan.problem.${p.code}`);
}

const isChange = computed(() => props.action === "change");
const applied = computed(() => props.view.applied ?? undefined);
const fallbackBind = computed(() => defaultBind(props.node));
// The default follows the port when it is valid, else the node's suggested one, so a bad port never reads as "no public IPv4".
const fallbackEndpoint = computed(() => defaultEndpoint(props.node, planned.value.port ?? applied.value?.port ?? props.view.suggested_port));

/** The sources that will hold a key: the current set, which the plan approves. */
const keySources = computed(() =>
  (props.view.sources ?? [])
    .filter((s) => s.current)
    .map((s) => s.name || s.node_id)
    .sort((a, b) => a.localeCompare(b)),
);
const changed = computed(() => (isChange.value ? changedSettings(form.value, props.view) : []));
const limits = DEFAULT_BEACON_LIMITS;

const missing = computed(() => {
  const out: string[] = [];
  if (props.action === "disable") return out;
  if (!planned.value.port && !problemOf("port")) out.push(t("fleet.monitoring.beacon.plan.port"));
  return out;
});
const canSubmit = computed(() => !pending.value && planned.value.problems.length === 0 && missing.value.length === 0);

async function submit(): Promise<void> {
  if (!canSubmit.value) return;
  pending.value = true;
  refusal.value = undefined;
  blocked.value = [];
  try {
    const response = await api.nodes.beacon.plan(buildBeaconPlanRequest(props.node.id, props.action, form.value, props.view));
    filed.value = response;
    digest.value = await planDigest.digestFor(response.approval);
    stage.value = "filed";
    toast.success(t("fleet.monitoring.beacon.plan.filed.toast"));
    emit("filed", response.approval.id);
  } catch (error) {
    const findings = refusedFindings(error);
    if (findings.length) blocked.value = findings;
    else refusal.value = error instanceof Error ? error.message : String(error);
  } finally {
    pending.value = false;
  }
}

function requestClose(): void {
  if (pending.value) return;
  emit("close");
}

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
              :placeholder="isChange && applied?.port ? String(applied.port) : String(view.suggested_port ?? '')"
              :aria-invalid="!!problemOf('port') || undefined"
              :aria-describedby="problemOf('port') ? 'beacon-port-error' : 'beacon-port-hint'"
            />
          </div>
          <p id="beacon-port-hint" class="text-xs text-muted-foreground">
            {{ $t('fleet.monitoring.beacon.plan.portHint', { min: BEACON_PORT_MIN, max: BEACON_PORT_MAX }) }}
            <template v-if="isChange && applied?.port">{{ $t('fleet.monitoring.beacon.plan.keepHint', { value: applied.port }) }}</template>
          </p>
          <p v-if="problemOf('port')" id="beacon-port-error" role="alert" class="text-xs text-destructive">{{ problemText(problemOf('port')) }}</p>

          <div class="grid max-w-72 gap-1.5">
            <Label for="beacon-bind">{{ $t('fleet.monitoring.beacon.plan.bind') }}</Label>
            <Input
              id="beacon-bind"
              v-model="form.bind"
              class="font-mono"
              spellcheck="false"
              :placeholder="isChange ? applied?.bind : fallbackBind"
              :aria-invalid="!!problemOf('bind') || undefined"
              :aria-describedby="problemOf('bind') ? 'beacon-bind-error' : 'beacon-bind-hint'"
            />
          </div>
          <p id="beacon-bind-hint" class="text-xs text-muted-foreground">
            <template v-if="isChange && applied?.bind">{{ $t('fleet.monitoring.beacon.plan.keepHint', { value: applied.bind }) }}</template>
            <template v-else>{{ fallbackBind ? $t('fleet.monitoring.beacon.plan.bindHint', { address: fallbackBind }) : $t('fleet.monitoring.beacon.plan.bindHintNone') }}</template>
          </p>
          <p v-if="problemOf('bind')" id="beacon-bind-error" role="alert" class="text-xs text-destructive">{{ problemText(problemOf('bind')) }}</p>
        </fieldset>

        <fieldset :class="SECTION">
          <legend :class="STEP" class="mb-2.5">{{ $t('fleet.monitoring.beacon.plan.step.send') }}</legend>
          <div class="grid max-w-72 gap-1.5">
            <Label for="beacon-endpoint">{{ $t('fleet.monitoring.beacon.plan.endpoint') }}</Label>
            <Input
              id="beacon-endpoint"
              v-model="form.endpoint"
              class="font-mono"
              spellcheck="false"
              :placeholder="planned.endpointDefault ? fallbackEndpoint : applied?.endpoint"
              :aria-invalid="!!problemOf('endpoint') || undefined"
              :aria-describedby="problemOf('endpoint') ? 'beacon-endpoint-error' : 'beacon-endpoint-hint'"
            />
          </div>
          <p id="beacon-endpoint-hint" class="text-xs text-muted-foreground">
            <template v-if="isChange && applied?.endpoint">{{ $t('fleet.monitoring.beacon.plan.keepHint', { value: applied.endpoint }) }}</template>
            <template v-else>{{ fallbackEndpoint ? $t('fleet.monitoring.beacon.plan.endpointHint', { endpoint: fallbackEndpoint }) : $t('fleet.monitoring.beacon.plan.endpointHintNone') }}</template>
          </p>
          <p v-if="problemOf('endpoint')" id="beacon-endpoint-error" role="alert" class="text-xs text-destructive">{{ problemText(problemOf('endpoint')) }}</p>
        </fieldset>
      </template>

      <!-- What the plan will ask, before it exists. -->
      <fieldset :class="SECTION" data-testid="beacon-plan-asks">
        <legend :class="STEP" class="mb-2.5">{{ $t('fleet.monitoring.beacon.plan.step.asks') }}</legend>
        <ul class="grid gap-1.5 rounded-md border border-border p-3 text-xs">
          <template v-if="action === 'disable'">
            <li>{{ $t('fleet.monitoring.beacon.plan.asks.closes', { port: applied?.port ?? '' }) }}</li>
            <li v-if="view.exposure === 'netguard'">{{ $t('fleet.monitoring.beacon.plan.asks.closesNetguard') }}</li>
          </template>
          <template v-else>
            <li v-if="isChange && changed.length === 0">{{ $t('fleet.monitoring.beacon.plan.asks.resources') }}</li>
            <li v-if="planned.port && planned.bind" class="font-mono break-all">{{ $t('fleet.monitoring.beacon.plan.asks.opens', { port: planned.port, bind: planned.bind }) }}</li>
            <li v-if="planned.endpoint" class="font-mono break-all">{{ $t('fleet.monitoring.beacon.plan.asks.send', { endpoint: planned.endpoint }) }}</li>
            <li v-if="keySources.length" class="break-words">{{ $t('fleet.monitoring.beacon.plan.asks.sources', { names: keySources.join(', ') }, keySources.length) }}</li>
            <li v-else class="text-muted-foreground">{{ $t('fleet.monitoring.beacon.plan.asks.noSources') }}</li>
            <li v-if="view.exposure === 'netguard'">{{ $t('fleet.monitoring.beacon.plan.asks.netguard') }}</li>
            <li v-else-if="view.exposure === 'internet'" class="text-warning-text">{{ $t('fleet.monitoring.beacon.plan.asks.internet') }}</li>
            <li v-else class="text-muted-foreground">{{ $t('fleet.monitoring.beacon.plan.asks.exposureUnknown') }}</li>
            <li class="text-muted-foreground">{{ $t('fleet.monitoring.beacon.plan.asks.limits', { rate: limits.source_rate_per_second, interval: limits.min_interval_sec, pps: limits.packets_per_second_max }) }}</li>
          </template>
          <li class="font-medium">{{ $t('fleet.monitoring.beacon.plan.asks.unchanged') }}</li>
        </ul>
      </fieldset>

      <div v-if="blocked.length" :class="cn(NOTE, 'space-y-1.5 border border-destructive/40 bg-destructive/5')" role="alert" data-testid="beacon-plan-blocked">
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
        <div class="flex flex-wrap items-center gap-2 rounded-md bg-muted/40 p-2.5 text-xs" data-testid="beacon-plan-digest">
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
        <p v-if="refusal" role="alert" class="basis-full text-xs text-destructive" data-testid="beacon-plan-refused">{{ $t('fleet.monitoring.beacon.plan.failed', { reason: refusal }) }}</p>
        <p v-if="missing.length" class="me-auto text-xs text-muted-foreground">{{ $t('fleet.monitoring.beacon.plan.missing', { fields: missing.join(', ') }) }}</p>
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
</template>

<script setup lang="ts">
/**
 * The agent's work loop on the node page (node-agent 0.3.10 and later): is
 * the agent doing what the control plane asks, or only beating.
 *
 *   Agent loop                         last full cycle 8s ago, took 2.1s
 *   (!) Stalled in step usage for 26m. Heartbeats still arrive.  Opens an incident
 *   Step          Last OK    Errors       Last error
 *   Config        9s         0
 *   Usage         25m        9 in a row   post /api/agent/usage: 502 Bad Gateway
 *
 * Every age is the agent's own clock carried forward by when its beat
 * arrived (loopHealthModel.agentAge), so a node whose clock is off still
 * reads right. The problems are the server's verdicts (agent_health.go),
 * worded here; the step table is the evidence under them. Rows are a list
 * at every width: from 640 px the four columns line up, below it each step
 * stacks its error under its name.
 */
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { AlertTriangle, Workflow } from "lucide-vue-next";

import type { AgentLoopHealth } from "@/lib/api";
import { formatAge } from "@/lib/format";
import { cn } from "@/lib/utils";
import { LOOP_STEP_ORDER, loopProblems, loopStepRows, loopSummary, type LoopStepTone } from "@/views/fleet/loopHealthModel";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const props = defineProps<{
  health?: AgentLoopHealth | null;
  now: number;
}>();

const { t, locale } = useI18n();

const KNOWN_STEPS = new Set<string>(LOOP_STEP_ORDER);

function age(ms: number | undefined): string {
  return ms === undefined ? "" : formatAge(ms, locale.value);
}

/** How long a cycle took: "840 ms" under a second, "2.1 s" above. */
function took(ms: number): string {
  return ms < 1000 ? t("fleet.loop.milliseconds", { n: ms }) : t("fleet.loop.seconds", { n: (ms / 1000).toFixed(1) });
}

function stepLabel(name: string): string {
  return KNOWN_STEPS.has(name) ? t(`fleet.loop.step.${name}`) : name;
}

const summary = computed(() => (props.health ? loopSummary(props.health, props.now) : undefined));
const rows = computed(() => (props.health ? loopStepRows(props.health, props.now) : []));

const headline = computed(() => {
  const s = summary.value;
  if (!s) return "";
  if (s.cycleAgeMs === undefined) return t("fleet.loop.noCycle", { age: age(s.uptimeMs) });
  return s.cycleDurationMs
    ? t("fleet.loop.cycle", { age: age(s.cycleAgeMs), took: took(s.cycleDurationMs) })
    : t("fleet.loop.cycleNoDuration", { age: age(s.cycleAgeMs) });
});

/** The facts under the headline, one short clause each. */
const facts = computed(() => {
  const s = summary.value;
  if (!s) return [];
  const out: string[] = [];
  if (s.step && s.stepAgeMs !== undefined) out.push(t("fleet.loop.inStep", { step: stepLabel(s.step), age: age(s.stepAgeMs) }));
  if (s.taskBusyAgeMs !== undefined) out.push(t("fleet.loop.taskBusy", { age: age(s.taskBusyAgeMs) }));
  out.push(s.watchdog ? t("fleet.loop.watchdogOn") : t("fleet.loop.watchdogOff"));
  if (s.uptimeMs !== undefined) out.push(t("fleet.loop.uptime", { age: age(s.uptimeMs) }));
  if (s.queued > 0) out.push(t("fleet.loop.queued", { n: s.queued }, s.queued));
  if (s.dropped > 0) out.push(t("fleet.loop.dropped", { n: s.dropped }, s.dropped));
  return out;
});

const problems = computed(() => {
  const h = props.health;
  const s = summary.value;
  if (!h || !s) return [];
  return loopProblems(h).map((p, index) => {
    let text: string;
    switch (p.kind) {
      case "stalled":
        text = s.step && s.stepAgeMs !== undefined
          ? t("fleet.loop.problem.stalledIn", { step: stepLabel(s.step), age: age(s.stepAgeMs) })
          : t("fleet.loop.problem.stalled", { age: age(s.cycleAgeMs) });
        break;
      case "linechain_blocked":
        text = s.blocked?.ageMs !== undefined
          ? t("fleet.loop.problem.linechainBlocked", { age: age(s.blocked.ageMs), reason: s.blocked.reason })
          : t("fleet.loop.problem.linechainBlockedNoAge", { reason: s.blocked?.reason ?? p.reason });
        break;
      case "step_stale": {
        const row = rows.value.find((r) => r.name === p.step);
        const step = stepLabel(p.step ?? "");
        const n = row?.errors ?? 0;
        text = row?.lastOkAgeMs !== undefined
          ? t("fleet.loop.problem.stepStale", { step, n, age: age(row.lastOkAgeMs) }, n)
          : t("fleet.loop.problem.stepStaleNever", { step, n }, n);
        break;
      }
      case "results_dropped":
        text = t("fleet.loop.problem.resultsDropped", { n: s.dropped }, s.dropped);
        break;
      default:
        text = p.reason;
    }
    return { key: `${p.kind}:${p.step ?? index}`, text, pages: p.pages };
  });
});

const TONE: Record<LoopStepTone, string> = {
  ok: "text-muted-foreground",
  idle: "text-muted-foreground",
  failing: "text-warning-text",
  stale: "text-destructive",
};
</script>

<template>
  <Card data-testid="agent-loop">
    <CardHeader>
      <CardTitle class="flex items-center gap-2">
        <Workflow class="size-4 text-muted-foreground" aria-hidden="true" />
        {{ $t('fleet.loop.title') }}
      </CardTitle>
      <CardDescription>{{ $t('fleet.loop.description') }}</CardDescription>
    </CardHeader>
    <CardContent class="space-y-4">
      <p v-if="!health || !summary" class="text-sm text-muted-foreground">{{ $t('fleet.loop.absent') }}</p>
      <template v-else>
        <div class="space-y-1">
          <p class="text-sm">{{ headline }}</p>
          <p class="text-xs text-muted-foreground">{{ facts.join(' · ') }}</p>
          <p v-if="summary.stale" class="text-xs text-warning-text">{{ $t('fleet.loop.stale', { age: age(summary.beatAgeMs) }) }}</p>
        </div>

        <ul v-if="problems.length" class="space-y-1.5" :aria-label="$t('fleet.loop.problemsLabel')">
          <li v-for="problem in problems" :key="problem.key" class="flex items-start gap-2 text-sm">
            <AlertTriangle class="mt-0.5 size-4 shrink-0 text-warning-text" aria-hidden="true" />
            <span class="min-w-0 flex-1 break-words">{{ problem.text }}</span>
            <Badge v-if="problem.pages" variant="outline" class="shrink-0 font-normal">{{ $t('fleet.loop.pages') }}</Badge>
          </li>
        </ul>

        <div v-if="rows.length" class="overflow-hidden rounded-md border border-border">
          <div class="hidden grid-cols-[9rem_6rem_7rem_minmax(0,1fr)] gap-3 border-b border-border bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground sm:grid" aria-hidden="true">
            <span>{{ $t('fleet.loop.col.step') }}</span>
            <span>{{ $t('fleet.loop.col.lastOk') }}</span>
            <span>{{ $t('fleet.loop.col.errors') }}</span>
            <span>{{ $t('fleet.loop.col.lastError') }}</span>
          </div>
          <ul class="divide-y divide-border" :aria-label="$t('fleet.loop.stepsLabel')">
            <li
              v-for="row in rows"
              :key="row.name"
              class="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 px-3 py-1.5 text-sm sm:grid-cols-[9rem_6rem_7rem_minmax(0,1fr)] sm:items-baseline"
              :data-tone="row.tone"
            >
              <span class="flex min-w-0 items-baseline gap-1.5" :title="row.name">
                <span class="truncate">{{ stepLabel(row.name) }}</span>
                <span v-if="row.running" class="shrink-0 text-xs text-info-text">{{ $t('fleet.loop.running') }}</span>
              </span>
              <span class="font-mono text-xs text-muted-foreground tabular">
                <span class="sr-only sm:hidden">{{ $t('fleet.loop.col.lastOk') }}: </span>
                {{ row.lastOkAgeMs !== undefined ? $t('fleet.loop.ago', { age: age(row.lastOkAgeMs) }) : $t('fleet.loop.never') }}
              </span>
              <span :class="cn('col-span-2 text-xs sm:col-span-1', TONE[row.tone])">
                {{ row.errors > 0 ? $t('fleet.loop.errorsInRow', { n: row.errors }, row.errors) : row.tone === 'idle' ? $t('fleet.loop.notRun') : $t('fleet.loop.noErrors') }}
              </span>
              <span v-if="row.lastError" class="col-span-2 break-words font-mono text-xs text-muted-foreground sm:col-span-1">{{ row.lastError }}</span>
              <span v-else class="hidden sm:block" aria-hidden="true" />
            </li>
          </ul>
        </div>
      </template>
    </CardContent>
  </Card>
</template>

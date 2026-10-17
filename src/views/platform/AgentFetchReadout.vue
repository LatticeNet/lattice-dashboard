<script setup lang="ts">
/**
 * A node's last agent update download (design 31), from the fetch summary
 * the update script prints on every exit path: how it ended, which source
 * delivered, how much and how long.
 *
 * Words, not a dot, as EvidenceReadinessCell does: a failure says the stage
 * it stopped in and is in --destructive; nothing else is coloured. The row
 * cell keeps to the outcome and one line per source that delivered bytes,
 * the source that completed its file first. The sheet adds what the record is for (version,
 * plan, time) and each fetch in the order the script made it, with its exit
 * status, so a source left early by the cutoff reads as such.
 *
 * Below the table's 768 px breakpoint the name and actions columns are
 * pinned and leave this cell about 144 px, so the row view caps its width
 * there and lets every line wrap; it must never need to be scrolled past.
 *
 * The record comes from the node: it is shown, never acted on.
 */
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink } from "vue-router";

import type { AgentUpdateFetch } from "@/lib/api";
import { formatBytes, formatBytesPerSec, formatDateTime, formatRelativeTime, isZeroTime } from "@/lib/format";
import { cn } from "@/lib/utils";

import { fetchExitReading, fetchKindKey, fetchRate, fetchReadout, fetchSecondsText, idToken } from "./agentUpdatesModel";

const props = defineProps<{
  fetch: AgentUpdateFetch;
  /** The sheet: what the record is for and every fetch. */
  detailed?: boolean;
}>();

const { t } = useI18n();

const readout = computed(() => fetchReadout(props.fetch));
const at = computed(() => (isZeroTime(props.fetch.at) ? undefined : props.fetch.at));

const outcome = computed(() => {
  const r = readout.value;
  if (r.outcome !== "failed") return t(`platform.agentUpdatesPage.fetch.outcome.${r.outcome}`);
  return r.stageKnown
    ? t(`platform.agentUpdatesPage.fetch.failed.${r.stage}`)
    : t("platform.agentUpdatesPage.fetch.failed.unknown", { stage: r.stage });
});

function kindLabel(kind: string): string {
  const key = fetchKindKey(kind);
  return key ? t(`platform.agentUpdatesPage.fetch.kind.${key}`) : kind;
}

// A narrow cell wraps, but never between a number and its unit.
const keep = (text: string) => text.replace(/ /g, "\u00a0");

function amount(bytes: number, seconds: number | null | undefined): string {
  const time = fetchSecondsText(seconds);
  return time
    ? t("platform.agentUpdatesPage.fetch.amount", { bytes: keep(formatBytes(bytes)), time: keep(time) })
    : t("platform.agentUpdatesPage.fetch.amountNoClock", { bytes: keep(formatBytes(bytes)) });
}

function exitText(code: number): string {
  const reading = fetchExitReading(code);
  const words = t(`platform.agentUpdatesPage.fetch.exit.${reading}`);
  return code === 0 ? words : t("platform.agentUpdatesPage.fetch.exitCode", { words, code });
}

const fetches = computed(() => props.fetch.fetches ?? []);
</script>

<template>
  <div class="min-w-0 text-xs" data-testid="agent-fetch">
    <p class="flex flex-wrap items-baseline gap-x-1.5">
      <span :class="cn('font-medium', readout.outcome === 'failed' ? 'text-destructive' : 'text-foreground')">{{ outcome }}</span>
      <span v-if="!detailed && at" class="whitespace-nowrap text-muted-foreground" :title="formatDateTime(at)">{{ formatRelativeTime(at) }}</span>
      <span v-if="detailed && readout.exitCode !== 0" class="whitespace-nowrap text-muted-foreground">{{ $t('platform.agentUpdatesPage.fetch.scriptExit', { code: readout.exitCode }) }}</span>
    </p>
    <ul v-if="readout.sources.length" class="text-muted-foreground">
      <li v-for="source in readout.sources" :key="source.kind">
        <span :class="cn('block md:inline', source.finished && 'text-foreground')">{{ kindLabel(source.kind) }}</span>
        {{ ' ' }}<span class="font-mono tabular-nums md:whitespace-nowrap">{{ amount(source.bytes, source.seconds) }}</span>
      </li>
    </ul>
    <p v-else-if="readout.outcome === 'failed'" class="text-muted-foreground">{{ $t('platform.agentUpdatesPage.fetch.noFetch') }}</p>

    <template v-if="detailed">
      <p class="mt-1 text-muted-foreground">
        <span v-if="fetch.target_version" class="font-mono">v{{ fetch.target_version }}</span>
        <span v-if="fetch.target_version && fetch.approval_id"> · </span>
        <RouterLink
          v-if="fetch.approval_id"
          :to="{ name: 'approvals', query: { open: fetch.approval_id } }"
          class="text-primary underline-offset-4 hover:underline"
        >{{ $t('platform.agentUpdatesPage.fetch.plan', { id: idToken(fetch.approval_id) }) }}</RouterLink>
        <template v-if="at">
          <span> · </span>
          <time :datetime="at">{{ formatDateTime(at) }}</time>
        </template>
      </p>
      <ol v-if="fetches.length" class="mt-2 divide-y divide-border rounded-md border border-border" :aria-label="$t('platform.agentUpdatesPage.fetch.listLabel')">
        <li v-for="(attempt, index) in fetches" :key="index" class="grid grid-cols-[4.5rem_1fr] gap-x-3 px-3 py-2">
          <span class="row-span-2 font-mono tabular-nums text-muted-foreground">{{ attempt.second_pass ? $t('platform.agentUpdatesPage.fetch.secondPass') : attempt.source ?? index + 1 }}</span>
          <span class="flex flex-wrap gap-x-1.5">
            <span class="font-medium text-foreground">{{ kindLabel(attempt.kind) }}</span>
            <span class="text-muted-foreground">{{ exitText(attempt.exit_code) }}</span>
          </span>
          <span class="font-mono tabular-nums text-muted-foreground">
            {{ amount(attempt.bytes, attempt.seconds) }}<template v-if="fetchRate(attempt.bytes, attempt.seconds) !== undefined"> · {{ formatBytesPerSec(fetchRate(attempt.bytes, attempt.seconds)) }}</template>
          </span>
        </li>
      </ol>
      <p v-else-if="readout.outcome === 'kept'" class="mt-1 text-muted-foreground">{{ $t('platform.agentUpdatesPage.fetch.keptDetail') }}</p>
    </template>
  </div>
</template>

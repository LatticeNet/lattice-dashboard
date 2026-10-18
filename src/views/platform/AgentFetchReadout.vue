<script setup lang="ts">
/**
 * A node's last agent update download (design 31), from the fetch summary
 * the update script prints on every exit path: how it ended, which source
 * delivered, how much and how long.
 *
 * Words, not a dot, as EvidenceReadinessCell does: a failure says the stage
 * it stopped in and is in --destructive; nothing else is coloured, and the
 * source that completed its file is named as such for a screen reader, not
 * by its colour alone. The line under the outcome carries the version the
 * record is for, so "Installed" beside a node whose Runs cell still says
 * behind reads as the mismatch it is.
 *
 * The row cell adds one line per source the walk tried, the one that
 * completed its file first and one that delivered nothing last, with why:
 * a control plane the node cannot reach shows in the table, not only in the
 * sheet. Below the table's 768 px breakpoint the name and actions columns
 * are pinned and leave this cell about 144 px, so the row keeps to the
 * outcome, version and time there and the sources are the sheet's. The sheet adds the plan, the
 * time, and every fetch in the order the node made it with its exit status,
 * so a source left by the cutoff reads "cut off" and a fetch that ran out of
 * budget reads "out of time".
 *
 * A registry mirror's fetch (m.<id>, design 31 S5) is named by its id. A
 * fetch that wrote chunks failing the plan's chunk manifest is the one
 * problem flagged in --destructive on a source line: the source sent wrong
 * bytes, the script cut them back, and the row says so even when another
 * source finished the download.
 *
 * The record comes from the node: it is shown, never acted on.
 */
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink } from "vue-router";

import type { AgentUpdateFetch } from "@/lib/api";
import { formatBytes, formatBytesPerSec, formatDateTime, formatRelativeTime, isZeroTime } from "@/lib/format";
import { cn } from "@/lib/utils";

import {
  fetchAttemptReading,
  fetchKindKey,
  fetchMirrorId,
  fetchRate,
  fetchReadout,
  fetchSecondsText,
  idToken,
  type FetchAttemptLike,
  type FetchExitReading,
  type FetchSourceTotal,
} from "./agentUpdatesModel";

const props = defineProps<{
  fetch: AgentUpdateFetch;
  /** The sheet: what the record is for and every fetch. */
  detailed?: boolean;
}>();

const { t } = useI18n();

const readout = computed(() => fetchReadout(props.fetch));
const at = computed(() => (isZeroTime(props.fetch.at) ? undefined : props.fetch.at));
const fetches = computed(() => props.fetch.fetches ?? []);

const outcome = computed(() => {
  const r = readout.value;
  if (r.outcome !== "failed") return t(`platform.agentUpdatesPage.fetch.outcome.${r.outcome}`);
  return r.stageKnown
    ? t(`platform.agentUpdatesPage.fetch.failed.${r.stage}`)
    : t("platform.agentUpdatesPage.fetch.failed.unknown", { stage: r.stage });
});

function kindLabel(kind: string): string {
  const key = fetchKindKey(kind);
  if (key) return t(`platform.agentUpdatesPage.fetch.kind.${key}`);
  const mirror = fetchMirrorId(kind);
  return mirror ? t("platform.agentUpdatesPage.fetch.kind.mirror", { id: mirror }) : kind;
}

function badChunksText(n: number): string {
  return t("platform.agentUpdatesPage.fetch.badChunks", { n }, n);
}

// A narrow cell wraps, but never between a number and its unit.
const keep = (text: string) => text.replace(/ /g, " ");

function amount(bytes: number, seconds: number | null | undefined): string {
  const time = fetchSecondsText(seconds);
  return time
    ? t("platform.agentUpdatesPage.fetch.amount", { bytes: keep(formatBytes(bytes)), time: keep(time) })
    : t("platform.agentUpdatesPage.fetch.amountNoClock", { bytes: keep(formatBytes(bytes)) });
}

function exitText(reading: FetchExitReading, code: number): string {
  const words = t(`platform.agentUpdatesPage.fetch.exit.${reading}`);
  return code === 0 ? words : t("platform.agentUpdatesPage.fetch.exitCode", { words, code });
}

function sourceAmount(source: FetchSourceTotal): string {
  return source.bytes > 0
    ? amount(source.bytes, source.seconds)
    : t("platform.agentUpdatesPage.fetch.nothing", { why: exitText(source.lastReading, source.lastExit) });
}

function attemptAmount(attempt: FetchAttemptLike): string {
  if (attempt.bytes <= 0) return t("platform.agentUpdatesPage.fetch.nothingShort");
  const rate = fetchRate(attempt.bytes, attempt.seconds);
  const base = amount(attempt.bytes, attempt.seconds);
  return rate === undefined ? base : `${base} · ${keep(formatBytesPerSec(rate))}`;
}

function attemptLabel(attempt: FetchAttemptLike, index: number): string {
  if (attempt.second_pass) return t("platform.agentUpdatesPage.fetch.secondPass");
  return t("platform.agentUpdatesPage.fetch.source", { n: attempt.source ?? index + 1 });
}
</script>

<template>
  <div class="min-w-0 text-xs" data-testid="agent-fetch">
    <p :class="cn('flex flex-wrap items-baseline gap-x-1.5', detailed && 'text-sm')">
      <span :class="cn('font-medium', readout.outcome === 'failed' ? 'text-destructive' : 'text-foreground')">{{ outcome }}</span>
      <span v-if="detailed && readout.outcome === 'failed'" class="whitespace-nowrap text-xs text-muted-foreground">{{ $t('platform.agentUpdatesPage.fetch.scriptExit', { code: readout.exitCode }) }}</span>
    </p>
    <p v-if="!detailed && (fetch.target_version || at)" class="flex flex-wrap gap-x-1.5 text-muted-foreground">
      <span v-if="fetch.target_version" class="whitespace-nowrap font-mono">v{{ fetch.target_version }}</span>
      <span v-if="at" class="whitespace-nowrap" :title="formatDateTime(at)">{{ formatRelativeTime(at) }}</span>
    </p>
    <ul v-if="readout.sources.length" :class="cn('text-muted-foreground', !detailed && 'hidden md:block')">
      <li v-for="source in readout.sources" :key="source.kind">
        <span :class="cn('break-words', source.finished && 'text-foreground')">{{ kindLabel(source.kind) }}<span v-if="source.finished" class="sr-only"> ({{ $t('platform.agentUpdatesPage.fetch.finishedSource') }})</span></span>
        {{ ' ' }}<span class="font-mono tabular-nums md:whitespace-nowrap">{{ sourceAmount(source) }}</span>
        <span v-if="source.badChunks" class="block text-destructive" data-testid="fetch-bad-chunks">{{ badChunksText(source.badChunks) }}</span>
      </li>
    </ul>
    <p v-else-if="readout.outcome === 'failed' && readout.stage !== 'prepare'" :class="cn('text-muted-foreground', !detailed && 'hidden md:block')">{{ $t('platform.agentUpdatesPage.fetch.noFetch') }}</p>
    <!-- Below 768 px the row hides its source lines; bad chunks still show, since they are the one problem a source line flags. -->
    <p v-if="!detailed && readout.badChunks" class="text-destructive md:hidden">{{ badChunksText(readout.badChunks) }}</p>
    <p v-if="detailed && readout.outcome === 'kept'" class="text-muted-foreground">{{ $t('platform.agentUpdatesPage.fetch.keptDetail') }}</p>

    <template v-if="detailed">
      <p class="mt-1 text-muted-foreground">
        <span v-if="fetch.target_version" class="font-mono">v{{ fetch.target_version }}</span>
        <span v-if="fetch.target_version && fetch.approval_id"> · </span>
        <RouterLink
          v-if="fetch.approval_id"
          :to="{ name: 'approvals', query: { open: fetch.approval_id } }"
          class="touch-target text-primary underline-offset-4 hover:underline"
        >{{ $t('platform.agentUpdatesPage.fetch.plan', { id: idToken(fetch.approval_id) }) }}</RouterLink>
        <template v-if="at">
          <span> · </span>
          <time :datetime="at">{{ formatDateTime(at) }}</time>
        </template>
      </p>
      <ol v-if="fetches.length" class="mt-2 divide-y divide-border rounded-md border border-border" :aria-label="$t('platform.agentUpdatesPage.fetch.listLabel')">
        <li v-for="(attempt, index) in fetches" :key="index" class="grid grid-cols-[4.5rem_1fr] gap-x-3 px-3 py-2">
          <span class="row-span-2 text-muted-foreground">{{ attemptLabel(attempt, index) }}</span>
          <span class="flex flex-wrap gap-x-1.5">
            <span class="break-words font-medium text-foreground">{{ kindLabel(attempt.kind) }}</span>
            <span class="text-muted-foreground">{{ exitText(fetchAttemptReading(fetch, attempt), attempt.exit_code) }}</span>
          </span>
          <span class="font-mono tabular-nums text-muted-foreground">{{ attemptAmount(attempt) }}</span>
          <span v-if="attempt.bad_chunks" class="col-start-2 text-destructive">{{ $t('platform.agentUpdatesPage.fetch.badChunksDetail', { n: attempt.bad_chunks }, attempt.bad_chunks) }}</span>
        </li>
      </ol>
    </template>
  </div>
</template>

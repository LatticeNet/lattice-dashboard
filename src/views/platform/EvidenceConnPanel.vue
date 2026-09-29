<script setup lang="ts">
/**
 * One connection, in a side panel addressed by `?conn=<key>` (design 22, L2
 * peek): identity, the connection itself, its lifecycle, the hop path the
 * server stitched, and the raw lines a capture kept for it.
 *
 * Opened from a row, the panel has the record already. Opened from a pasted
 * link, it asks the hops endpoint, which answers with the records on the path
 * including this one, so a link to a connection outside the loaded window
 * still lands on it. A hop path short of "exact" says in words that it was
 * inferred before it shows anything.
 */
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import { api, type ConnRecord, type HopPath, type TraceLine } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import DataState from "@/components/common/DataState.vue";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { SheetContent } from "@/components/ui/sheet";

import {
  connCloseCell,
  connRecordKey,
  destinationText,
  hopConfidenceDisplay,
  traceBytesCell,
  traceDurationCell,
  userCellDisplay,
} from "./connTraceModel";
import { useEvidenceContext } from "./evidenceContext";
import { parseConnKey } from "./evidenceModel";

const props = defineProps<{
  /** The open connection's key, "" when the panel is closed. */
  connKey: string;
  /** The row it was opened from, when the list had it. */
  record?: ConnRecord;
}>();
const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();
const ctx = useEvidenceContext();

const open = computed(() => props.connKey !== "");
const selected = ref<ConnRecord | null>(null);

const hopPath = ref<HopPath | null>(null);
const hopRecords = ref<ConnRecord[]>([]);
const hopError = ref<Error | null>(null);
const hopLoading = ref(false);

const recordLines = ref<TraceLine[]>([]);
const linesLoading = ref(false);
const linesError = ref<Error | null>(null);

const selectedClose = computed(() => (selected.value ? connCloseCell(selected.value) : null));
const selectedUser = computed(() => (selected.value ? userCellDisplay(selected.value, ctx.userNames.value) : null));
const hopConfidence = computed(() => hopConfidenceDisplay(hopPath.value?.confidence));

async function loadHops(key: NonNullable<ReturnType<typeof parseConnKey>>): Promise<void> {
  hopLoading.value = true;
  hopError.value = null;
  try {
    const res = await api.trace.hops({
      node_id: key.node_id,
      core_generation: key.core_generation,
      log_id: key.log_id,
      // Without the start time a reused log id resolves to whichever
      // connection the server ordered first.
      started_at: key.started_at || undefined,
    });
    hopPath.value = res.path ?? null;
    hopRecords.value = res.records ?? [];
  } catch (error) {
    hopError.value = error as Error;
  } finally {
    hopLoading.value = false;
  }
}

/**
 * The lines endpoint is session-scoped, not connection-scoped, so the lines
 * for one connection are found by asking each session that captured it and
 * keeping the lines carrying this node and this log id.
 */
async function loadLines(row: ConnRecord): Promise<void> {
  const sessionIds = row.session_ids ?? [];
  recordLines.value = [];
  linesError.value = null;
  if (sessionIds.length === 0) return;
  linesLoading.value = true;
  try {
    const pages = await Promise.all(sessionIds.map((id) => api.trace.lines({ session_id: id, limit: 1000 })));
    recordLines.value = pages
      .flatMap((page) => page.lines ?? [])
      .filter((line) => line.node_id === row.node_id && line.log_id === row.log_id)
      .sort((a, b) => a.seq - b.seq);
  } catch (error) {
    linesError.value = error as Error;
  } finally {
    linesLoading.value = false;
  }
}

watch(
  () => [props.connKey, props.record] as const,
  async ([key, record], before) => {
    if (!key) return;
    if (before && before[0] === key && selected.value) return;
    const parts = parseConnKey(key);
    selected.value = record && connRecordKey(record) === key ? record : null;
    hopPath.value = null;
    hopRecords.value = [];
    if (!parts) return;
    await loadHops(parts);
    if (!selected.value) {
      selected.value = hopRecords.value.find((candidate) => connRecordKey(candidate) === key) ?? null;
    }
    if (selected.value) void loadLines(selected.value);
  },
  { immediate: true },
);

function hopRecordFor(key: { node_id: string; core_generation: number; log_id: number }): ConnRecord | undefined {
  return hopRecords.value.find(
    (record) =>
      record.node_id === key.node_id &&
      (record.core_generation ?? 0) === key.core_generation &&
      record.log_id === key.log_id,
  );
}

const upload = computed(() => (selected.value ? traceBytesCell(selected.value.upload, selected.value.bytes_known) : null));
const download = computed(() => (selected.value ? traceBytesCell(selected.value.download, selected.value.bytes_known) : null));
const duration = computed(() => (selected.value ? traceDurationCell(selected.value.duration_ms) : null));
const title = computed(() =>
  selected.value ? destinationText(selected.value) || t("platform.trace.detailTitle") : t("platform.trace.detailTitle"),
);
</script>

<template>
  <Dialog :open="open" @update:open="(value) => { if (!value) emit('close'); }">
    <SheetContent :aria-describedby="undefined">
      <header class="space-y-1 border-b border-border px-5 pt-5 pb-4 pr-12">
        <DialogTitle :class="cn('truncate text-base font-semibold tracking-[-0.01em]', selected && destinationText(selected) && 'font-mono')" :title="title">{{ title }}</DialogTitle>
        <DialogDescription class="font-mono text-xs break-all text-muted-foreground">{{ connKey }}</DialogDescription>
      </header>

      <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <DataState
          :loading="!selected && hopLoading"
          :error="!selected ? hopError : null"
          :has-data="!!selected"
          :is-empty="!selected"
          :skeleton-rows="6"
          :empty-title="$t('platform.evidence.panel.missingTitle')"
          :empty-description="$t('platform.evidence.panel.missingDescription')"
          @retry="() => { const parts = parseConnKey(connKey); if (parts) loadHops(parts); }"
        >
          <div v-if="selected" class="space-y-6">
            <!-- Identity -->
            <section class="space-y-2">
              <h3 class="text-sm font-medium">{{ $t('platform.trace.detailIdentity') }}</h3>
              <dl class="grid gap-2 text-xs sm:grid-cols-2">
                <div>
                  <dt class="text-muted-foreground">{{ $t('platform.trace.colUser') }}</dt>
                  <dd :class="cn('mt-0.5', selectedUser?.monospace && 'font-mono')">
                    {{ selectedUser?.primary || $t('platform.trace.userNoneLogged') }}
                  </dd>
                </div>
                <div>
                  <dt class="text-muted-foreground">{{ $t('platform.trace.userKindLabel') }}</dt>
                  <dd class="mt-0.5">
                    {{ $t(`platform.trace.userKind.${selectedUser?.kind ?? 'unknown'}`) }}
                    <span v-if="selectedUser?.marker" class="text-muted-foreground">{{ $t('platform.trace.userUnresolvedHint') }}</span>
                  </dd>
                </div>
                <div v-if="selectedUser?.userId">
                  <dt class="text-muted-foreground">{{ $t('platform.trace.detailUserId') }}</dt>
                  <dd class="mt-0.5 font-mono break-all">{{ selectedUser.userId }}</dd>
                </div>
                <div>
                  <dt class="text-muted-foreground">{{ $t('platform.trace.colNode') }}</dt>
                  <dd class="mt-0.5">{{ ctx.nodeLabel(selected.node_id) }}</dd>
                </div>
                <div v-if="selected.line_uuid">
                  <dt class="text-muted-foreground">{{ $t('platform.trace.colLine') }}</dt>
                  <dd class="mt-0.5 font-mono break-all">{{ selected.line_uuid }}</dd>
                </div>
                <div v-if="selected.inbound_tag">
                  <dt class="text-muted-foreground">{{ $t('platform.trace.detailInbound') }}</dt>
                  <dd class="mt-0.5 font-mono">{{ selected.inbound_tag }} ({{ selected.inbound_type || $t('common.misc.none') }})</dd>
                </div>
              </dl>
            </section>

            <!-- Connection -->
            <section class="space-y-2">
              <h3 class="text-sm font-medium">{{ $t('platform.trace.detailConnection') }}</h3>
              <dl class="grid gap-2 text-xs sm:grid-cols-2">
                <div>
                  <dt class="text-muted-foreground">{{ $t('platform.trace.colDestination') }}</dt>
                  <dd class="mt-0.5 font-mono break-all">{{ destinationText(selected) || $t('common.misc.none') }}</dd>
                </div>
                <div v-if="selected.dst_ip">
                  <dt class="text-muted-foreground">{{ $t('platform.trace.detailResolvedIp') }}</dt>
                  <dd class="mt-0.5 font-mono">{{ selected.dst_ip }}</dd>
                </div>
                <div v-if="selected.src_ip">
                  <dt class="text-muted-foreground">{{ $t('platform.trace.detailSource') }}</dt>
                  <dd class="mt-0.5 font-mono">{{ selected.src_ip }}:{{ selected.src_port }}</dd>
                </div>
                <div>
                  <dt class="text-muted-foreground">{{ $t('platform.trace.detailNetwork') }}</dt>
                  <dd class="mt-0.5 font-mono">{{ selected.network || $t('common.misc.none') }}</dd>
                </div>
                <div v-if="selected.sniffed_protocol || selected.sniffed_domain">
                  <dt class="text-muted-foreground">{{ $t('platform.trace.detailSniffed') }}</dt>
                  <dd class="mt-0.5 font-mono break-all">
                    {{ selected.sniffed_protocol || $t('common.misc.none') }}
                    <span v-if="selected.sniffed_domain">/ {{ selected.sniffed_domain }}</span>
                  </dd>
                </div>
                <div v-if="selected.rule_text">
                  <dt class="text-muted-foreground">{{ $t('platform.trace.detailRule') }}</dt>
                  <dd class="mt-0.5 font-mono break-all">{{ selected.rule_text }}</dd>
                </div>
                <div v-if="selected.outbound_tag">
                  <dt class="text-muted-foreground">{{ $t('platform.trace.colOutbound') }}</dt>
                  <dd class="mt-0.5 font-mono">{{ selected.outbound_tag }} ({{ selected.outbound_type || $t('common.misc.none') }})</dd>
                </div>
              </dl>
            </section>

            <!-- Lifecycle -->
            <section class="space-y-2">
              <h3 class="text-sm font-medium">{{ $t('platform.trace.detailLifecycle') }}</h3>
              <dl class="grid gap-2 text-xs sm:grid-cols-2">
                <div>
                  <dt class="text-muted-foreground">{{ $t('platform.trace.colStarted') }}</dt>
                  <dd class="mt-0.5 font-mono tabular">{{ formatDateTime(selected.started_at) }}</dd>
                </div>
                <div>
                  <dt class="text-muted-foreground">{{ $t('platform.trace.detailEnded') }}</dt>
                  <dd class="mt-0.5 font-mono tabular">{{ selected.ended_at ? formatDateTime(selected.ended_at) : $t('platform.trace.stillOpen') }}</dd>
                </div>
                <div>
                  <dt class="text-muted-foreground">{{ $t('platform.trace.colDuration') }}</dt>
                  <dd class="mt-0.5 font-mono tabular">{{ duration?.known ? duration.text : $t('platform.trace.durationUnknown') }}</dd>
                </div>
                <div>
                  <dt class="text-muted-foreground">{{ $t('platform.trace.colClose') }}</dt>
                  <dd class="mt-0.5 flex flex-wrap items-center gap-1">
                    <Badge :variant="selectedClose?.tone ?? 'outline'">
                      {{ $t(`platform.trace.closeReason.${selectedClose?.id ?? 'unknown'}`) }}
                    </Badge>
                    <span v-if="selectedClose && !selectedClose.certain" class="text-muted-foreground">{{ $t('platform.trace.closeUnknownHint') }}</span>
                    <span v-if="selectedClose?.raw && selectedClose.id === 'unknown'" class="font-mono text-muted-foreground">
                      {{ $t('platform.trace.closeRawValue', { value: selectedClose.raw }) }}
                    </span>
                  </dd>
                </div>
                <div v-if="selected.close_error">
                  <dt class="text-muted-foreground">{{ $t('platform.trace.detailCloseError') }}</dt>
                  <dd class="mt-0.5 font-mono break-all text-destructive">{{ selected.close_error }}</dd>
                </div>
                <div v-if="selected.stalled_at">
                  <dt class="text-muted-foreground">{{ $t('platform.trace.stalled') }}</dt>
                  <dd class="mt-0.5 font-mono tabular">{{ formatDateTime(selected.stalled_at) }}</dd>
                </div>
                <div>
                  <dt class="text-muted-foreground">{{ $t('platform.trace.colUpload') }}</dt>
                  <dd class="mt-0.5 font-mono tabular">
                    <span v-if="upload?.known">{{ upload.text }}</span>
                    <span v-else class="font-sans italic text-muted-foreground">{{ $t('platform.trace.bytesNotSampled') }}</span>
                  </dd>
                </div>
                <div>
                  <dt class="text-muted-foreground">{{ $t('platform.trace.colDownload') }}</dt>
                  <dd class="mt-0.5 font-mono tabular">
                    <span v-if="download?.known">{{ download.text }}</span>
                    <span v-else class="font-sans italic text-muted-foreground">{{ $t('platform.trace.bytesNotSampled') }}</span>
                  </dd>
                </div>
              </dl>
              <p v-if="!selected.bytes_known" class="text-xs text-muted-foreground">{{ $t('platform.trace.bytesNotSampledHint') }}</p>
            </section>

            <!-- Hop path -->
            <section class="space-y-2">
              <h3 class="text-sm font-medium">{{ $t('platform.trace.detailHops') }}</h3>
              <DataState
                :loading="hopLoading"
                :error="hopError"
                :has-data="!!hopPath"
                :is-empty="!hopPath"
                :skeleton-rows="2"
                :empty-title="$t('platform.trace.hopsEmptyTitle')"
                :empty-description="$t('platform.trace.hopsEmptyDescription')"
                @retry="() => { const parts = parseConnKey(connKey); if (parts) loadHops(parts); }"
              >
                <div v-if="hopPath" class="space-y-2">
                  <div class="flex flex-wrap items-center gap-2">
                    <Badge :variant="hopConfidence.tone">{{ $t(`platform.trace.hopConfidence.${hopConfidence.id}`) }}</Badge>
                    <span class="text-xs text-muted-foreground">{{ $t(`platform.trace.hopConfidence.${hopConfidence.id}Wording`) }}</span>
                  </div>
                  <ol class="space-y-1">
                    <li
                      v-for="(key, index) in hopPath.record_keys"
                      :key="`${key.node_id}:${key.core_generation}:${key.log_id}`"
                      class="flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2 text-xs"
                    >
                      <span class="font-mono text-muted-foreground tabular">{{ index + 1 }}</span>
                      <span class="font-medium">{{ ctx.nodeLabel(key.node_id) }}</span>
                      <span v-if="hopRecordFor(key)" class="font-mono">{{ destinationText(hopRecordFor(key)!) }}</span>
                      <span class="w-full font-mono text-muted-foreground break-all">{{ key.node_id }}:{{ key.core_generation }}:{{ key.log_id }}</span>
                    </li>
                  </ol>
                  <div v-if="hopConfidence.ambiguous && hopPath.candidates?.length" class="space-y-1">
                    <p class="text-xs text-muted-foreground">{{ $t('platform.trace.hopCandidates') }}</p>
                    <ul class="space-y-1">
                      <li
                        v-for="candidate in hopPath.candidates"
                        :key="`c:${candidate.node_id}:${candidate.core_generation}:${candidate.log_id}`"
                        class="rounded-md border border-dashed border-border px-3 py-1.5 font-mono text-xs"
                      >
                        {{ candidate.node_id }}:{{ candidate.core_generation }}:{{ candidate.log_id }}
                      </li>
                    </ul>
                  </div>
                </div>
              </DataState>
            </section>

            <!-- Captured lines -->
            <section class="space-y-2">
              <h3 class="text-sm font-medium">{{ $t('platform.trace.detailLines') }}</h3>
              <p v-if="!selected.session_ids?.length" class="text-xs text-muted-foreground">{{ $t('platform.trace.linesNoSession') }}</p>
              <DataState
                v-else
                :loading="linesLoading"
                :error="linesError"
                :has-data="recordLines.length > 0"
                :is-empty="recordLines.length === 0"
                :skeleton-rows="2"
                :empty-title="$t('platform.trace.linesEmptyTitle')"
                :empty-description="$t('platform.trace.linesEmptyDescription')"
                @retry="() => selected && loadLines(selected)"
              >
                <div class="relative overflow-x-auto rounded-md border border-border bg-muted/10">
                  <table class="w-full text-xs">
                    <tbody class="font-mono">
                      <tr v-for="line in recordLines" :key="`${line.session_id}:${line.seq}`" class="border-b border-border align-top last:border-b-0">
                        <td class="px-3 py-1 whitespace-nowrap text-muted-foreground tabular">{{ formatDateTime(line.at) }}</td>
                        <td class="px-3 py-1 whitespace-nowrap text-muted-foreground">{{ line.level }}</td>
                        <td class="px-3 py-1"><span class="break-all whitespace-pre-wrap">{{ line.raw || line.message }}</span></td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </DataState>
            </section>
          </div>
        </DataState>
      </div>
    </SheetContent>
  </Dialog>
</template>

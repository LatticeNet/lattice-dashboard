<script setup lang="ts">
/**
 * CorrelationTrace: the full chain of one operation, reconstructed from the
 * audit trail and shown inline where the event is open (the Audit sheet,
 * design 23, section 4.3). Given a correlation id, it pulls every audit event
 * that shares it (the request's own timeline), resolves any approval_id /
 * task_id those events reference into the wider plan -> approve -> run
 * lifecycle, and shows the approval's plan binding plus per-node task
 * results. Read-only; no mutation.
 */
import { ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink } from "vue-router";
import { ShieldCheck, Terminal } from "lucide-vue-next";
import { api, unwrap, type ApprovalView, type AuditEvent, type TaskResult } from "@/lib/api";
import { formatDateTime, shortId } from "@/lib/format";
import { approvalRawLabel, approvalTitleMessage } from "@/lib/approvalKind";
import { referencedApprovalIds, referencedTaskIds, orderTimeline, summarize } from "@/views/operations/traceModel";

import { Badge } from "@/components/ui/badge";
import DataState from "@/components/common/DataState.vue";
import NodeLabel from "@/components/common/NodeLabel.vue";

const props = defineProps<{
  correlationId: string;
}>();

const { t } = useI18n();

const loading = ref(false);
const error = ref<Error | null>(null);
const events = ref<AuditEvent[]>([]);
const approvals = ref<ApprovalView[]>([]);

function approvalTitle(approval: ApprovalView): string {
  const message = approvalTitleMessage(approval);
  return t(message.key, message.params);
}
const results = ref<TaskResult[]>([]);

async function load(correlationId: string) {
  loading.value = true;
  error.value = null;
  events.value = [];
  approvals.value = [];
  results.value = [];
  try {
    const res = await api.audit.query({ correlation_id: correlationId, limit: 200 });
    const list = orderTimeline(res.events ?? []);
    events.value = list;

    // By id, one read each: the trace names a handful of approvals and used to
    // download the whole listing to find them. A row that no longer exists, or
    // that this token cannot see, is simply absent from the section.
    const approvalIds = referencedApprovalIds(list);
    if (approvalIds.length > 0) {
      const found = await Promise.all(
        approvalIds.map((id) => api.approvals.get(id).catch(() => undefined)),
      );
      approvals.value = found.filter((a): a is ApprovalView => a !== undefined);
    }

    const taskIds = referencedTaskIds(list);
    if (taskIds.length > 0) {
      const perTask = await Promise.all(
        taskIds.map((id) => api.tasks.results({ task_id: id }).then((r) => unwrap(r, "results"))),
      );
      results.value = perTask.flat();
    }
  } catch (e) {
    error.value = e instanceof Error ? e : new Error(String(e));
  } finally {
    loading.value = false;
  }
}

watch(
  () => props.correlationId,
  (id) => {
    if (id) load(id);
  },
  { immediate: true },
);

function decisionTone(decision: string): "ok" | "danger" | "neutral" {
  if (decision === "deny") return "danger";
  if (decision === "observe") return "neutral";
  return "ok";
}
function decisionVariant(decision: string) {
  return decision === "deny" ? "destructive" : decision === "observe" ? "outline" : "success";
}

const summaryOf = summarize;
</script>

<template>
  <section class="space-y-3" data-testid="correlation-trace">
      <DataState
        :loading="loading"
        :error="error"
        :has-data="events.length > 0 || !loading"
        :is-empty="!loading && events.length === 0"
        :empty-title="$t('operations.trace.empty')"
        @retry="load(correlationId)"
      >
        <div class="space-y-5">
          <!-- Summary strip -->
          <div class="flex flex-wrap gap-4 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">
            <span>
              <span class="text-muted-foreground">{{ $t('operations.trace.events') }}</span>
              <span class="ms-1 tabular font-medium">{{ summaryOf(events).total }}</span>
            </span>
            <span v-if="summaryOf(events).denied > 0" class="text-destructive">
              {{ $t('operations.trace.denied', { n: summaryOf(events).denied }) }}
            </span>
            <span v-if="summaryOf(events).nodes.length">
              <span class="text-muted-foreground">{{ $t('operations.trace.nodes') }}</span>
              <span class="ms-1 tabular font-medium">{{ summaryOf(events).nodes.length }}</span>
            </span>
          </div>

          <!-- Approvals resolved from the group -->
          <section v-if="approvals.length" class="space-y-2">
            <h3 class="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <ShieldCheck class="size-3.5" aria-hidden="true" />
              {{ $t('operations.trace.approvals') }}
            </h3>
            <div
              v-for="appr in approvals"
              :key="appr.id"
              class="rounded-md border border-border p-3 text-sm"
            >
              <div class="flex flex-wrap items-center gap-2">
                <span class="min-w-0">
                  <span class="block font-medium">{{ approvalTitle(appr) }}</span>
                  <span class="block break-all font-mono text-xs text-muted-foreground">{{ approvalRawLabel(appr) }}</span>
                </span>
                <Badge variant="outline">{{ t(`common.status.${appr.status}`) }}</Badge>
                <RouterLink
                  :to="{ name: 'approvals', query: { open: appr.id } }"
                  class="ms-auto rounded-sm font-mono text-xs text-primary underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
                  :title="appr.id"
                >
                  {{ shortId(appr.id, 12) }}
                </RouterLink>
              </div>
              <p class="mt-1 text-xs text-muted-foreground">
                {{ $t('operations.trace.plannedBy') }} {{ appr.actor_id || $t('common.misc.none') }}
                <template v-if="appr.approved_by"> · {{ $t('operations.trace.approvedBy') }} {{ appr.approved_by }}</template>
                <template v-if="appr.node_id"> · <NodeLabel :id="appr.node_id" /></template>
              </p>
            </div>
          </section>

          <!-- Per-node task results resolved from the group -->
          <section v-if="results.length" class="space-y-2">
            <h3 class="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <Terminal class="size-3.5" aria-hidden="true" />
              {{ $t('operations.trace.results') }}
            </h3>
            <div class="overflow-hidden rounded-md border border-border">
              <div
                v-for="(r, i) in results"
                :key="`${r.task_id}:${r.node_id}:${i}`"
                class="flex items-center gap-3 border-b border-border px-3 py-2 text-sm last:border-b-0"
              >
                <Badge :variant="(r.exit_code ?? 0) === 0 && !r.error ? 'success' : 'destructive'">
                  {{ r.error ? $t('operations.trace.errored') : $t('operations.trace.exit', { code: r.exit_code ?? 0 }) }}
                </Badge>
                <NodeLabel :id="r.node_id" class="text-xs" />
                <RouterLink
                  :to="{ name: 'tasks', query: { open: r.task_id } }"
                  class="ms-auto truncate rounded-sm font-mono text-xs text-primary underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
                  :title="r.task_id"
                >
                  {{ shortId(r.task_id, 12) }}
                </RouterLink>
              </div>
            </div>
          </section>

          <!-- The request's own audit timeline -->
          <section class="space-y-2">
            <h3 class="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {{ $t('operations.trace.timeline') }}
            </h3>
            <ol class="relative space-y-3 border-s border-border ps-4">
              <li v-for="event in events" :key="event.id" class="relative">
                <span
                  class="absolute -start-[21px] top-1.5 size-2 rounded-full"
                  :class="{
                    'bg-destructive': decisionTone(event.decision) === 'danger',
                    'bg-success': decisionTone(event.decision) === 'ok',
                    'bg-muted-foreground': decisionTone(event.decision) === 'neutral',
                  }"
                  aria-hidden="true"
                />
                <div class="flex flex-wrap items-center gap-2">
                  <span class="font-medium">{{ event.action }}</span>
                  <Badge :variant="decisionVariant(event.decision)">{{ event.decision }}</Badge>
                  <Badge v-if="event.scope" variant="outline">{{ event.scope }}</Badge>
                  <span class="ms-auto text-xs text-muted-foreground">{{ formatDateTime(event.at) }}</span>
                </div>
                <p v-if="event.reason" class="mt-0.5 text-xs text-muted-foreground">{{ event.reason }}</p>
              </li>
            </ol>
          </section>
        </div>
      </DataState>
  </section>
</template>

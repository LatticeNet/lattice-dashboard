<script setup lang="ts">
import { computed, ref } from "vue";
import { toast } from "vue-sonner";
import { CheckCircle2, RefreshCw, ScrollText, ShieldCheck } from "lucide-vue-next";
import { api, type AuditEvent } from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { formatDateTime, shortId } from "@/lib/format";
import { cn } from "@/lib/utils";

import PageHeader from "@/components/common/PageHeader.vue";
import DataState from "@/components/common/DataState.vue";
import CopyButton from "@/components/common/CopyButton.vue";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";

const action = ref("");
const decision = ref("");
const nodeId = ref("");
const correlationId = ref("");
const limit = ref(50);
const verifyPending = ref(false);
const verifyResult = ref<{ enabled: boolean; ok: boolean; count: number; head?: string } | undefined>();

const auditQuery = useAsyncData(
  () =>
    api.audit.query({
      action: action.value.trim() || undefined,
      decision: decision.value || undefined,
      node_id: nodeId.value.trim() || undefined,
      correlation_id: correlationId.value.trim() || undefined,
      limit: Number(limit.value) || 50,
      offset: 0,
    }),
  { pollInterval: 12000 },
);

const events = computed<AuditEvent[]>(() => auditQuery.data.value?.events ?? []);
const total = computed(() => auditQuery.data.value?.total ?? events.value.length);

function decisionVariant(value: string): "success" | "destructive" | "secondary" {
  if (value === "allow") return "success";
  if (value === "deny") return "destructive";
  return "secondary";
}

function metadataText(event: AuditEvent): string {
  if (!event.metadata || Object.keys(event.metadata).length === 0) return "";
  return JSON.stringify(event.metadata, null, 2);
}

async function verifyAudit() {
  verifyPending.value = true;
  try {
    verifyResult.value = await api.audit.verify();
    toast.success(verifyResult.value.ok ? "Audit chain verified" : "Audit verification failed");
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "Audit verification failed");
  } finally {
    verifyPending.value = false;
  }
}
</script>

<template>
  <div class="p-6 space-y-6">
    <PageHeader title="Audit" description="Search security decisions and verify the append-only audit chain">
      <template #actions>
        <Button variant="outline" size="sm" :disabled="auditQuery.refreshing.value" @click="auditQuery.refresh">
          <RefreshCw :class="cn('size-4', auditQuery.refreshing.value && 'animate-spin')" aria-hidden="true" />
          Refresh
        </Button>
      </template>
    </PageHeader>

    <div class="grid gap-4 md:grid-cols-3">
      <Card>
        <CardContent class="flex items-center justify-between p-4">
          <div>
            <p class="text-sm text-muted-foreground">Returned</p>
            <p class="text-2xl font-semibold">{{ events.length }}</p>
          </div>
          <ScrollText class="size-5 text-muted-foreground" aria-hidden="true" />
        </CardContent>
      </Card>
      <Card>
        <CardContent class="flex items-center justify-between p-4">
          <div>
            <p class="text-sm text-muted-foreground">Total match</p>
            <p class="text-2xl font-semibold">{{ total }}</p>
          </div>
          <ShieldCheck class="size-5 text-muted-foreground" aria-hidden="true" />
        </CardContent>
      </Card>
      <Card>
        <CardContent class="flex items-center justify-between p-4">
          <div>
            <p class="text-sm text-muted-foreground">Chain</p>
            <p class="text-2xl font-semibold" :class="verifyResult?.ok === false ? 'text-destructive' : 'text-success'">
              {{ verifyResult ? (verifyResult.ok ? "OK" : "Bad") : "—" }}
            </p>
          </div>
          <CheckCircle2 class="size-5 text-muted-foreground" aria-hidden="true" />
        </CardContent>
      </Card>
    </div>

    <Card>
      <CardHeader>
        <CardTitle>Filters</CardTitle>
        <CardDescription>Query parameters are passed directly to the audit API.</CardDescription>
      </CardHeader>
      <CardContent>
        <form class="grid gap-3 lg:grid-cols-[1fr_160px_1fr_1fr_110px_auto_auto]" @submit.prevent="auditQuery.refresh">
          <div class="grid gap-2">
            <Label for="audit-action">Action</Label>
            <Input id="audit-action" v-model="action" placeholder="task.create" />
          </div>
          <div class="grid gap-2">
            <Label for="audit-decision">Decision</Label>
            <select id="audit-decision" v-model="decision" class="h-9 rounded-md border border-input bg-background px-3 text-sm">
              <option value="">Any</option>
              <option value="allow">allow</option>
              <option value="deny">deny</option>
              <option value="observe">observe</option>
            </select>
          </div>
          <div class="grid gap-2">
            <Label for="audit-node">Node</Label>
            <Input id="audit-node" v-model="nodeId" placeholder="node id" />
          </div>
          <div class="grid gap-2">
            <Label for="audit-correlation">Correlation</Label>
            <Input id="audit-correlation" v-model="correlationId" placeholder="req_..." />
          </div>
          <div class="grid gap-2">
            <Label for="audit-limit">Limit</Label>
            <Input id="audit-limit" v-model="limit" type="number" min="1" max="500" />
          </div>
          <div class="flex items-end">
            <Button type="submit">
              <RefreshCw class="size-4" aria-hidden="true" />
              Query
            </Button>
          </div>
          <div class="flex items-end">
            <Button type="button" variant="outline" :disabled="verifyPending" @click="verifyAudit">
              <RefreshCw v-if="verifyPending" class="size-4 animate-spin" aria-hidden="true" />
              <ShieldCheck v-else class="size-4" aria-hidden="true" />
              Verify
            </Button>
          </div>
        </form>

        <div v-if="verifyResult" class="mt-4 rounded-md border border-border bg-muted/30 p-3 text-sm">
          <div class="flex flex-wrap items-center gap-2">
            <Badge :variant="verifyResult.ok ? 'success' : 'destructive'">
              {{ verifyResult.ok ? "chain ok" : "chain failed" }}
            </Badge>
            <span>{{ verifyResult.count }} events</span>
            <code v-if="verifyResult.head" class="break-all font-mono text-xs text-muted-foreground">{{ verifyResult.head }}</code>
          </div>
        </div>
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <CardTitle>Events</CardTitle>
        <CardDescription>Newest matching entries from the audit log</CardDescription>
      </CardHeader>
      <CardContent>
        <DataState
          :loading="auditQuery.loading.value"
          :error="auditQuery.error.value"
          :is-empty="events.length === 0"
          empty-title="No events match"
          empty-description="Adjust filters or wait for new audited activity."
          @retry="auditQuery.refresh"
        >
          <div class="space-y-3">
            <div v-for="event in events" :key="event.id" class="rounded-lg border border-border p-4">
              <div class="flex flex-wrap items-start justify-between gap-3">
                <div class="min-w-0">
                  <div class="flex flex-wrap items-center gap-2">
                    <Badge :variant="decisionVariant(event.decision)">{{ event.decision }}</Badge>
                    <span class="font-medium">{{ event.action }}</span>
                    <Badge v-if="event.scope" variant="outline">{{ event.scope }}</Badge>
                  </div>
                  <p class="mt-1 text-xs text-muted-foreground">
                    {{ formatDateTime(event.at) }} · actor {{ event.actor_id || "system" }} · node {{ event.node_id || "global" }}
                  </p>
                </div>
                <div class="flex items-center gap-2">
                  <code class="font-mono text-xs text-muted-foreground">{{ shortId(event.id, 12) }}</code>
                  <CopyButton :value="event.id" />
                </div>
              </div>

              <div v-if="event.reason || event.correlation_id" class="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
                <span v-if="event.reason">{{ event.reason }}</span>
                <span v-if="event.correlation_id" class="font-mono">corr {{ event.correlation_id }}</span>
              </div>

              <pre v-if="metadataText(event)" class="mt-3 max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-muted/40 p-3 font-mono text-xs">{{ metadataText(event) }}</pre>
            </div>
          </div>
        </DataState>
      </CardContent>
    </Card>
  </div>
</template>

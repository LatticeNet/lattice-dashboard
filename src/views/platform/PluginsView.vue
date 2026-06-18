<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import {
  Blocks,
  CircleDot,
  Play,
  Power,
  RefreshCw,
  ShieldCheck,
} from "lucide-vue-next";
import {
  api,
  type PluginInstallationView,
  type PluginLifecycleStatus,
  type PluginVerifyResponse,
  type PluginView,
} from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { useAuthStore } from "@/stores/auth";
import { formatDateTime, shortId } from "@/lib/format";
import { cn } from "@/lib/utils";

import PageHeader from "@/components/common/PageHeader.vue";
import DataTable, { type DataTableColumn } from "@/components/common/DataTable.vue";
import FreshnessLabel from "@/components/common/FreshnessLabel.vue";
import ConfirmDialog from "@/components/common/ConfirmDialog.vue";
import CopyButton from "@/components/common/CopyButton.vue";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogScrollContent,
  DialogTitle,
} from "@/components/ui/dialog";

const { t } = useI18n();
const auth = useAuthStore();
const canAudit = computed(() => auth.can("audit:read"));
const canAdmin = computed(() => auth.can("plugin:admin"));
const canVerify = computed(() => auth.can("plugin:verify"));

const tab = ref<"registered" | "lifecycle">("registered");

// ── Registered plugins (audit:read) ────────────────────────────────────────
const registeredQuery = useAsyncData(() => api.plugins.list(), {
  pollInterval: 15000,
  immediate: canAudit.value,
});
const registered = computed(() => registeredQuery.data.value ?? []);
const sortedRegistered = computed(() =>
  [...registered.value].sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id)),
);

// ── Lifecycle (plugin:admin) ────────────────────────────────────────────────
const lifecycleQuery = useAsyncData(() => api.plugins.lifecycle(), {
  pollInterval: 15000,
  immediate: canAdmin.value,
});
const lifecycle = computed(() => lifecycleQuery.data.value ?? []);
const sortedLifecycle = computed(() =>
  [...lifecycle.value].sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id)),
);

function refreshAll() {
  if (canAudit.value) registeredQuery.refresh();
  if (canAdmin.value) lifecycleQuery.refresh();
}

const registeredColumns = computed<DataTableColumn<PluginView>[]>(() => [
  { key: "id", label: t("platform.plugins.colId"), sortable: true, searchable: true, class: "font-mono text-xs text-muted-foreground" },
  { key: "name", label: t("platform.plugins.colName"), sortable: true, searchable: true, value: (p) => p.name || p.id },
  { key: "type", label: t("platform.plugins.colType"), sortable: true },
  { key: "version", label: t("platform.plugins.colVersion"), sortable: true },
  { key: "publisher", label: t("platform.plugins.colPublisher"), sortable: true, searchable: true },
  { key: "capabilities", label: t("platform.plugins.colCapabilities") },
]);

const lifecycleColumns = computed<DataTableColumn<PluginInstallationView>[]>(() => [
  { key: "name", label: t("platform.plugins.colName"), sortable: true, searchable: true, value: (p) => p.name || p.id },
  { key: "type", label: t("platform.plugins.colType"), sortable: true },
  { key: "version", label: t("platform.plugins.colVersion"), sortable: true },
  { key: "status", label: t("platform.plugins.colStatus"), sortable: true },
  { key: "runtime", label: t("platform.plugins.colRuntime"), value: (p) => p.runtime?.state ?? "" },
  { key: "available", label: t("platform.plugins.colAvailable"), sortable: true },
  { key: "artifact_sha256", label: t("platform.plugins.colArtifact") },
  { key: "capabilities", label: t("platform.plugins.colCapabilities") },
  { key: "actions", label: t("platform.plugins.colActions"), align: "right" },
]);

// ── Lifecycle status / runtime badges ───────────────────────────────────────
function statusVariant(status: string): "secondary" | "success" | "warning" | "outline" {
  switch (status) {
    case "active":
      return "success";
    case "disabled":
      return "warning";
    case "verified":
    case "installed":
      return "secondary";
    default:
      return "outline";
  }
}

function runtimeVariant(state?: string): "success" | "secondary" | "destructive" | "outline" {
  switch (state) {
    case "armed":
      return "success";
    case "stopped":
      return "secondary";
    case "failed":
      return "destructive";
    default:
      return "outline";
  }
}

/** Contextual valid next states for the lifecycle state machine. */
function nextStates(row: PluginInstallationView): PluginLifecycleStatus[] {
  switch (row.status) {
    case "verified":
      return ["installed"];
    case "installed":
      return ["active"];
    case "active":
      return ["disabled"];
    case "disabled":
      return ["active"];
    default:
      return [];
  }
}

function transitionLabel(status: PluginLifecycleStatus): string {
  switch (status) {
    case "installed":
      return t("platform.plugins.install");
    case "active":
      return t("platform.plugins.activate");
    case "disabled":
      return t("common.actions.disable");
    case "verified":
      return t("platform.plugins.markVerified");
    default:
      return status;
  }
}

// ── Lifecycle transition confirm dialog ─────────────────────────────────────
const transitionTarget = ref<
  { row: PluginInstallationView; status: PluginLifecycleStatus } | undefined
>(undefined);
const transitioning = ref(false);

function requestTransition(row: PluginInstallationView, status: PluginLifecycleStatus) {
  transitionTarget.value = { row, status };
}

async function confirmTransition() {
  if (!transitionTarget.value) return;
  const { row, status } = transitionTarget.value;
  transitioning.value = true;
  try {
    await api.plugins.setLifecycle(row.id, status);
    toast.success(`${row.name || row.id} → ${status}`);
    transitionTarget.value = undefined;
    lifecycleQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("platform.plugins.transitionFailed"));
  } finally {
    transitioning.value = false;
  }
}

// ── Verify dialog (plugin:verify) ───────────────────────────────────────────
const verifyOpen = ref(false);
const verifying = ref(false);
const manifestText = ref("");
const artifactText = ref("");
const verifyResult = ref<PluginVerifyResponse | undefined>(undefined);

function openVerify() {
  manifestText.value = "";
  artifactText.value = "";
  verifyResult.value = undefined;
  verifyOpen.value = true;
}

function riskVariant(risk: string): "secondary" | "warning" | "destructive" | "outline" {
  switch (risk) {
    case "read":
      return "secondary";
    case "write":
      return "warning";
    case "host":
      return "destructive";
    default:
      return "outline";
  }
}

async function runVerify() {
  if (!canVerify.value) return;
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestText.value);
  } catch {
    toast.error(t("platform.plugins.manifestInvalidJson"));
    return;
  }
  verifying.value = true;
  verifyResult.value = undefined;
  try {
    verifyResult.value = await api.plugins.verify(manifest, artifactText.value.trim());
    toast.success(t("platform.plugins.manifestVerified"));
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("platform.plugins.verificationFailed"));
  } finally {
    verifying.value = false;
  }
}
</script>

<template>
  <div class="p-6 space-y-6">
    <PageHeader
      :title="$t('platform.plugins.title')"
      :description="$t('platform.plugins.description')"
    >
      <template #status>
        <FreshnessLabel
          :last-updated="tab === 'lifecycle' ? lifecycleQuery.lastUpdated.value : registeredQuery.lastUpdated.value"
        />
      </template>
      <template #actions>
        <Button variant="outline" size="sm" :disabled="registeredQuery.refreshing.value || lifecycleQuery.refreshing.value" @click="refreshAll">
          <RefreshCw
            aria-hidden="true"
            :class="cn('size-4', (registeredQuery.refreshing.value || lifecycleQuery.refreshing.value) && 'animate-spin')"
          />
          {{ $t('common.actions.refresh') }}
        </Button>
        <Button v-if="canVerify" size="sm" @click="openVerify">
          <ShieldCheck aria-hidden="true" class="size-4" />
          {{ $t('platform.plugins.verifyManifest') }}
        </Button>
      </template>
    </PageHeader>

    <Tabs v-model="tab">
      <TabsList class="w-full sm:w-auto">
        <TabsTrigger value="registered">{{ $t('platform.plugins.tabRegistered') }}</TabsTrigger>
        <TabsTrigger value="lifecycle">{{ $t('platform.plugins.tabLifecycle') }}</TabsTrigger>
      </TabsList>

      <!-- Registered tab -->
      <TabsContent value="registered">
        <Card>
          <CardHeader>
            <CardTitle class="flex items-center gap-2">
              <Blocks aria-hidden="true" class="size-4 text-muted-foreground" />
              {{ $t('platform.plugins.registeredTitle') }}
            </CardTitle>
            <CardDescription>{{ $t('platform.plugins.registeredHint') }}</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable
              v-if="canAudit"
              :columns="registeredColumns"
              :rows="sortedRegistered"
              :row-key="(plugin) => plugin.id"
              :loading="registeredQuery.loading.value"
              :error="registeredQuery.error.value"
              :has-data="registeredQuery.data.value !== undefined"
              :page-size="50"
              searchable
              :search-placeholder="$t('platform.shared.searchNames')"
              :empty-title="$t('platform.plugins.registeredEmptyTitle')"
              :empty-description="$t('platform.plugins.registeredEmptyDescription')"
              :no-match-title="$t('platform.shared.noMatchesTitle')"
              :no-match-description="$t('platform.shared.noMatchesDescription')"
              @retry="registeredQuery.refresh"
            >
              <template #cell-id="{ row }">
                <span class="font-mono text-xs text-muted-foreground">{{ shortId(row.id, 18) }}</span>
              </template>
              <template #cell-name="{ row }">
                <span class="font-medium">{{ row.name || row.id }}</span>
              </template>
              <template #cell-type="{ row }">
                <Badge variant="outline">{{ row.type }}</Badge>
              </template>
              <template #cell-version="{ row }">
                <span class="font-mono text-xs">{{ row.version || "—" }}</span>
              </template>
              <template #cell-publisher="{ row }">
                <span class="text-xs text-muted-foreground">{{ row.publisher || "—" }}</span>
              </template>
              <template #cell-capabilities="{ row }">
                <div class="flex flex-wrap gap-1">
                  <Badge v-for="cap in row.capabilities" :key="cap" variant="secondary" class="font-mono">{{ cap }}</Badge>
                  <span v-if="!row.capabilities.length" class="text-xs text-muted-foreground">{{ $t('common.misc.none') }}</span>
                </div>
              </template>
            </DataTable>
            <p v-else class="text-sm text-muted-foreground">
              <i18n-t keypath="platform.plugins.auditScopeRequired" tag="span" scope="global">
                <template #scope><code class="font-mono">audit:read</code></template>
              </i18n-t>
            </p>
          </CardContent>
        </Card>
      </TabsContent>

      <!-- Lifecycle tab -->
      <TabsContent value="lifecycle">
        <Card>
          <CardHeader>
            <CardTitle class="flex items-center gap-2">
              <CircleDot aria-hidden="true" class="size-4 text-muted-foreground" />
              {{ $t('platform.plugins.lifecycleTitle') }}
            </CardTitle>
            <CardDescription>
              {{ $t('platform.plugins.lifecycleHint') }}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable
              v-if="canAdmin"
              :columns="lifecycleColumns"
              :rows="sortedLifecycle"
              :row-key="(row) => row.id"
              :loading="lifecycleQuery.loading.value"
              :error="lifecycleQuery.error.value"
              :has-data="lifecycleQuery.data.value !== undefined"
              :page-size="50"
              searchable
              :search-placeholder="$t('platform.shared.searchNames')"
              :empty-title="$t('platform.plugins.lifecycleEmptyTitle')"
              :empty-description="$t('platform.plugins.lifecycleEmptyDescription')"
              :no-match-title="$t('platform.shared.noMatchesTitle')"
              :no-match-description="$t('platform.shared.noMatchesDescription')"
              @retry="lifecycleQuery.refresh"
            >
              <template #cell-name="{ row }">
                <div class="font-medium">{{ row.name || row.id }}</div>
                <div class="font-mono text-xs text-muted-foreground">{{ shortId(row.id, 16) }}</div>
              </template>
              <template #cell-type="{ row }">
                <Badge variant="outline">{{ row.type }}</Badge>
              </template>
              <template #cell-version="{ row }">
                <span class="font-mono text-xs">{{ row.version || "—" }}</span>
              </template>
              <template #cell-status="{ row }">
                <Badge :variant="statusVariant(row.status)">{{ row.status }}</Badge>
              </template>
              <template #cell-runtime="{ row }">
                <Badge v-if="row.runtime" :variant="runtimeVariant(row.runtime.state)">{{ row.runtime.state }}</Badge>
                <span v-else class="text-xs text-muted-foreground">—</span>
              </template>
              <template #cell-available="{ row }">
                <Badge :variant="row.available ? 'success' : 'secondary'">{{ row.available ? $t('common.misc.yes') : $t('common.misc.no') }}</Badge>
              </template>
              <template #cell-artifact_sha256="{ row }">
                <div v-if="row.artifact_sha256" class="flex items-center gap-1">
                  <code class="font-mono text-xs text-muted-foreground">{{ shortId(row.artifact_sha256, 12) }}</code>
                  <CopyButton :value="row.artifact_sha256" />
                </div>
                <span v-else class="text-xs text-muted-foreground">—</span>
              </template>
              <template #cell-capabilities="{ row }">
                <div class="flex flex-wrap gap-1">
                  <Badge v-for="cap in row.capabilities" :key="cap" variant="secondary" class="font-mono">{{ cap }}</Badge>
                  <span v-if="!row.capabilities.length" class="text-xs text-muted-foreground">{{ $t('common.misc.none') }}</span>
                </div>
              </template>
              <template #cell-actions="{ row }">
                <div class="flex items-center justify-end gap-1">
                  <Button
                    v-for="status in nextStates(row)"
                    :key="status"
                    size="sm"
                    :variant="status === 'disabled' ? 'destructive' : 'outline'"
                    @click="requestTransition(row, status)"
                  >
                    <Power v-if="status === 'disabled'" aria-hidden="true" class="size-4" />
                    <Play v-else aria-hidden="true" class="size-4" />
                    {{ transitionLabel(status) }}
                  </Button>
                  <span v-if="!nextStates(row).length" class="text-xs text-muted-foreground">—</span>
                </div>
              </template>
            </DataTable>
            <p v-else class="text-sm text-muted-foreground">
              <i18n-t keypath="platform.plugins.adminScopeRequired" tag="span" scope="global">
                <template #scope><code class="font-mono">plugin:admin</code></template>
              </i18n-t>
            </p>
          </CardContent>
        </Card>
      </TabsContent>
    </Tabs>

    <!-- Transition confirm dialog -->
    <ConfirmDialog
      :open="!!transitionTarget"
      :title="$t('platform.plugins.confirmTransitionTitle')"
      :confirm-label="transitionTarget ? transitionLabel(transitionTarget.status) : $t('common.actions.confirm')"
      :cancel-label="$t('common.actions.cancel')"
      :variant="transitionTarget?.status === 'disabled' ? 'destructive' : 'default'"
      :pending="transitioning"
      @update:open="(v) => { if (!v) transitionTarget = undefined; }"
      @confirm="confirmTransition"
    >
      <p class="text-sm text-muted-foreground">
        {{ $t('platform.plugins.confirmTransitionMove') }}
        <span class="font-medium text-foreground">{{ transitionTarget?.row.name || transitionTarget?.row.id }}</span>
        {{ $t('platform.plugins.confirmTransitionFrom') }} <Badge :variant="statusVariant(transitionTarget?.row.status ?? '')">{{ transitionTarget?.row.status }}</Badge>
        {{ $t('platform.plugins.confirmTransitionTo') }} <Badge :variant="statusVariant(transitionTarget?.status ?? '')">{{ transitionTarget?.status }}</Badge>?
        <template v-if="transitionTarget?.status === 'active'"> {{ $t('platform.plugins.activatingStarts') }}</template>
        <template v-else-if="transitionTarget?.status === 'disabled'"> {{ $t('platform.plugins.disablingStops') }}</template>
      </p>
    </ConfirmDialog>

    <!-- Verify dialog -->
    <Dialog v-model:open="verifyOpen">
      <DialogScrollContent class="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{{ $t('platform.plugins.verifyTitle') }}</DialogTitle>
          <DialogDescription>
            {{ $t('platform.plugins.verifyHint') }}
          </DialogDescription>
        </DialogHeader>

        <form class="space-y-4" @submit.prevent="runVerify">
          <div class="grid gap-2">
            <Label for="verify-manifest">{{ $t('platform.plugins.manifestLabel') }}</Label>
            <textarea
              id="verify-manifest"
              v-model="manifestText"
              rows="8"
              spellcheck="false"
              placeholder='{"id":"...","name":"...","type":"wasm","capabilities":[]}'
              class="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>
          <div class="grid gap-2">
            <Label for="verify-artifact">{{ $t('platform.plugins.artifactLabel') }}</Label>
            <textarea
              id="verify-artifact"
              v-model="artifactText"
              rows="4"
              spellcheck="false"
              :placeholder="$t('platform.plugins.artifactPlaceholder')"
              class="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>

          <div v-if="verifyResult" class="space-y-4 rounded-md border border-success/40 bg-success/5 p-4">
            <div class="flex flex-wrap items-center gap-2">
              <Badge variant="success" class="gap-1.5">
                <ShieldCheck aria-hidden="true" class="size-3.5" />
                {{ verifyResult.trusted ? $t('platform.plugins.trusted') : $t('platform.plugins.untrusted') }}
              </Badge>
              <Badge variant="outline">{{ verifyResult.manifest.type }}</Badge>
              <span class="text-sm font-medium">{{ verifyResult.manifest.name || verifyResult.manifest.id }}</span>
            </div>

            <div class="grid gap-2 text-xs sm:grid-cols-2">
              <div class="rounded-md border border-border p-2">
                <p class="font-medium uppercase text-muted-foreground">{{ $t('platform.plugins.manifestId') }}</p>
                <p class="mt-1 break-all font-mono">{{ verifyResult.manifest.id }}</p>
              </div>
              <div class="rounded-md border border-border p-2">
                <p class="font-medium uppercase text-muted-foreground">{{ $t('platform.plugins.versionPublisher') }}</p>
                <p class="mt-1 font-mono">{{ verifyResult.manifest.version || "—" }} · {{ verifyResult.manifest.publisher || "—" }}</p>
              </div>
            </div>

            <div class="flex flex-wrap items-center gap-2 rounded-md bg-muted/40 p-3 text-xs">
              <span class="font-medium">{{ $t('platform.plugins.artifactSha256') }}</span>
              <code class="break-all font-mono">{{ verifyResult.artifact_sha256 }}</code>
              <CopyButton :value="verifyResult.artifact_sha256" />
            </div>

            <div class="space-y-2">
              <p class="text-xs font-medium uppercase text-muted-foreground">{{ $t('platform.plugins.colCapabilities') }}</p>
              <div class="flex flex-wrap gap-1.5">
                <Badge
                  v-for="cap in verifyResult.capabilities"
                  :key="cap.name"
                  :variant="riskVariant(cap.risk)"
                  class="gap-1 font-mono"
                >
                  {{ cap.name }}
                  <span class="opacity-70">({{ cap.risk }})</span>
                </Badge>
                <span v-if="!verifyResult.capabilities.length" class="text-xs text-muted-foreground">{{ $t('platform.plugins.noneDeclared') }}</span>
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" @click="verifyOpen = false">{{ $t('common.actions.close') }}</Button>
            <Button type="submit" :disabled="verifying || !manifestText.trim() || !artifactText.trim()">
              <RefreshCw v-if="verifying" aria-hidden="true" class="size-4 animate-spin" />
              <ShieldCheck v-else aria-hidden="true" class="size-4" />
              {{ $t('common.actions.verify') }}
            </Button>
          </DialogFooter>
        </form>
      </DialogScrollContent>
    </Dialog>
  </div>
</template>

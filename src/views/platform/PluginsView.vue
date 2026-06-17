<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import {
  Blocks,
  CheckCircle2,
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
} from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { useAuthStore } from "@/stores/auth";
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
            <DataState
              v-if="canAudit"
              :loading="registeredQuery.loading.value"
              :error="registeredQuery.error.value"
              :is-empty="registered.length === 0"
              :empty-title="$t('platform.plugins.registeredEmptyTitle')"
              :empty-description="$t('platform.plugins.registeredEmptyDescription')"
              @retry="registeredQuery.refresh"
            >
              <div class="overflow-x-auto">
                <table class="w-full text-sm">
                  <thead>
                    <tr class="border-b border-border text-left text-xs text-muted-foreground">
                      <th scope="col" class="py-2 pr-3 font-medium">{{ $t('platform.plugins.colId') }}</th>
                      <th scope="col" class="py-2 pr-3 font-medium">{{ $t('platform.plugins.colName') }}</th>
                      <th scope="col" class="py-2 pr-3 font-medium">{{ $t('platform.plugins.colType') }}</th>
                      <th scope="col" class="py-2 pr-3 font-medium">{{ $t('platform.plugins.colVersion') }}</th>
                      <th scope="col" class="py-2 pr-3 font-medium">{{ $t('platform.plugins.colPublisher') }}</th>
                      <th scope="col" class="py-2 pr-3 font-medium">{{ $t('platform.plugins.colCapabilities') }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr
                      v-for="plugin in sortedRegistered"
                      :key="plugin.id"
                      class="border-b border-border last:border-b-0 hover:bg-muted/40"
                    >
                      <td class="py-3 pr-3 font-mono text-xs text-muted-foreground">{{ shortId(plugin.id, 18) }}</td>
                      <td class="py-3 pr-3 font-medium">{{ plugin.name || plugin.id }}</td>
                      <td class="py-3 pr-3"><Badge variant="outline">{{ plugin.type }}</Badge></td>
                      <td class="py-3 pr-3 font-mono text-xs">{{ plugin.version || "—" }}</td>
                      <td class="py-3 pr-3 text-xs text-muted-foreground">{{ plugin.publisher || "—" }}</td>
                      <td class="py-3 pr-3">
                        <div class="flex flex-wrap gap-1">
                          <Badge v-for="cap in plugin.capabilities" :key="cap" variant="secondary" class="font-mono">{{ cap }}</Badge>
                          <span v-if="!plugin.capabilities.length" class="text-xs text-muted-foreground">{{ $t('common.misc.none') }}</span>
                        </div>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </DataState>
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
            <DataState
              v-if="canAdmin"
              :loading="lifecycleQuery.loading.value"
              :error="lifecycleQuery.error.value"
              :is-empty="lifecycle.length === 0"
              :empty-title="$t('platform.plugins.lifecycleEmptyTitle')"
              :empty-description="$t('platform.plugins.lifecycleEmptyDescription')"
              @retry="lifecycleQuery.refresh"
            >
              <div class="overflow-x-auto">
                <table class="w-full text-sm">
                  <thead>
                    <tr class="border-b border-border text-left text-xs text-muted-foreground">
                      <th scope="col" class="py-2 pr-3 font-medium">{{ $t('platform.plugins.colName') }}</th>
                      <th scope="col" class="py-2 pr-3 font-medium">{{ $t('platform.plugins.colType') }}</th>
                      <th scope="col" class="py-2 pr-3 font-medium">{{ $t('platform.plugins.colVersion') }}</th>
                      <th scope="col" class="py-2 pr-3 font-medium">{{ $t('platform.plugins.colStatus') }}</th>
                      <th scope="col" class="py-2 pr-3 font-medium">{{ $t('platform.plugins.colRuntime') }}</th>
                      <th scope="col" class="py-2 pr-3 font-medium">{{ $t('platform.plugins.colAvailable') }}</th>
                      <th scope="col" class="py-2 pr-3 font-medium">{{ $t('platform.plugins.colArtifact') }}</th>
                      <th scope="col" class="py-2 pr-3 font-medium">{{ $t('platform.plugins.colCapabilities') }}</th>
                      <th scope="col" class="py-2 pl-3 text-right font-medium">{{ $t('platform.plugins.colActions') }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr
                      v-for="row in sortedLifecycle"
                      :key="row.id"
                      class="border-b border-border last:border-b-0 hover:bg-muted/40"
                    >
                      <td class="py-3 pr-3">
                        <div class="font-medium">{{ row.name || row.id }}</div>
                        <div class="font-mono text-xs text-muted-foreground">{{ shortId(row.id, 16) }}</div>
                      </td>
                      <td class="py-3 pr-3"><Badge variant="outline">{{ row.type }}</Badge></td>
                      <td class="py-3 pr-3 font-mono text-xs">{{ row.version || "—" }}</td>
                      <td class="py-3 pr-3"><Badge :variant="statusVariant(row.status)">{{ row.status }}</Badge></td>
                      <td class="py-3 pr-3">
                        <Badge v-if="row.runtime" :variant="runtimeVariant(row.runtime.state)">{{ row.runtime.state }}</Badge>
                        <span v-else class="text-xs text-muted-foreground">—</span>
                      </td>
                      <td class="py-3 pr-3">
                        <Badge :variant="row.available ? 'success' : 'secondary'">{{ row.available ? $t('common.misc.yes') : $t('common.misc.no') }}</Badge>
                      </td>
                      <td class="py-3 pr-3">
                        <div v-if="row.artifact_sha256" class="flex items-center gap-1">
                          <code class="font-mono text-xs text-muted-foreground">{{ shortId(row.artifact_sha256, 12) }}</code>
                          <CopyButton :value="row.artifact_sha256" />
                        </div>
                        <span v-else class="text-xs text-muted-foreground">—</span>
                      </td>
                      <td class="py-3 pr-3">
                        <div class="flex flex-wrap gap-1">
                          <Badge v-for="cap in row.capabilities" :key="cap" variant="secondary" class="font-mono">{{ cap }}</Badge>
                          <span v-if="!row.capabilities.length" class="text-xs text-muted-foreground">none</span>
                        </div>
                      </td>
                      <td class="py-3 pl-3">
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
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </DataState>
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
    <Dialog :open="!!transitionTarget" @update:open="(v) => { if (!v) transitionTarget = undefined; }">
      <DialogScrollContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{{ $t('platform.plugins.confirmTransitionTitle') }}</DialogTitle>
          <DialogDescription>
            {{ $t('platform.plugins.confirmTransitionMove') }}
            <span class="font-medium">{{ transitionTarget?.row.name || transitionTarget?.row.id }}</span>
            {{ $t('platform.plugins.confirmTransitionFrom') }} <Badge :variant="statusVariant(transitionTarget?.row.status ?? '')">{{ transitionTarget?.row.status }}</Badge>
            {{ $t('platform.plugins.confirmTransitionTo') }} <Badge :variant="statusVariant(transitionTarget?.status ?? '')">{{ transitionTarget?.status }}</Badge>?
            <template v-if="transitionTarget?.status === 'active'"> {{ $t('platform.plugins.activatingStarts') }}</template>
            <template v-else-if="transitionTarget?.status === 'disabled'"> {{ $t('platform.plugins.disablingStops') }}</template>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" @click="transitionTarget = undefined">{{ $t('common.actions.cancel') }}</Button>
          <Button
            type="button"
            :variant="transitionTarget?.status === 'disabled' ? 'destructive' : 'default'"
            :disabled="transitioning"
            @click="confirmTransition"
          >
            <RefreshCw v-if="transitioning" aria-hidden="true" class="size-4 animate-spin" />
            <CheckCircle2 v-else aria-hidden="true" class="size-4" />
            {{ transitionTarget ? transitionLabel(transitionTarget.status) : $t('common.actions.confirm') }}
          </Button>
        </DialogFooter>
      </DialogScrollContent>
    </Dialog>

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

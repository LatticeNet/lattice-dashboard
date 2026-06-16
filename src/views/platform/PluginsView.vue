<script setup lang="ts">
import { computed, ref } from "vue";
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
      return "Install";
    case "active":
      return "Activate";
    case "disabled":
      return "Disable";
    case "verified":
      return "Mark verified";
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
    toast.error(error instanceof Error ? error.message : "Lifecycle transition failed");
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
    toast.error("Manifest is not valid JSON");
    return;
  }
  verifying.value = true;
  verifyResult.value = undefined;
  try {
    verifyResult.value = await api.plugins.verify(manifest, artifactText.value.trim());
    toast.success("Manifest verified against trust policy");
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "Verification failed");
  } finally {
    verifying.value = false;
  }
}
</script>

<template>
  <div class="p-6 space-y-6">
    <PageHeader
      title="Plugins"
      description="Verified, capability-gated extension bundles and their lifecycle state machine"
    >
      <template #actions>
        <Button variant="outline" size="sm" :disabled="registeredQuery.refreshing.value || lifecycleQuery.refreshing.value" @click="refreshAll">
          <RefreshCw
            :class="cn('size-4', (registeredQuery.refreshing.value || lifecycleQuery.refreshing.value) && 'animate-spin')"
          />
          Refresh
        </Button>
        <Button v-if="canVerify" size="sm" @click="openVerify">
          <ShieldCheck class="size-4" />
          Verify manifest
        </Button>
      </template>
    </PageHeader>

    <Tabs v-model="tab">
      <TabsList class="w-full sm:w-auto">
        <TabsTrigger value="registered">Registered</TabsTrigger>
        <TabsTrigger value="lifecycle">Lifecycle</TabsTrigger>
      </TabsList>

      <!-- Registered tab -->
      <TabsContent value="registered">
        <Card>
          <CardHeader>
            <CardTitle class="flex items-center gap-2">
              <Blocks class="size-4 text-muted-foreground" />
              Registered plugins
            </CardTitle>
            <CardDescription>In-memory verified/registered bundles (no signatures or digests).</CardDescription>
          </CardHeader>
          <CardContent>
            <DataState
              v-if="canAudit"
              :loading="registeredQuery.loading.value"
              :error="registeredQuery.error.value"
              :is-empty="registered.length === 0"
              empty-title="No plugins registered"
              empty-description="Verify and install a plugin bundle to populate the registry."
              @retry="registeredQuery.refresh"
            >
              <div class="overflow-x-auto">
                <table class="w-full text-sm">
                  <thead>
                    <tr class="border-b border-border text-left text-xs text-muted-foreground">
                      <th class="py-2 pr-3 font-medium">ID</th>
                      <th class="py-2 pr-3 font-medium">Name</th>
                      <th class="py-2 pr-3 font-medium">Type</th>
                      <th class="py-2 pr-3 font-medium">Version</th>
                      <th class="py-2 pr-3 font-medium">Publisher</th>
                      <th class="py-2 pr-3 font-medium">Capabilities</th>
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
                          <span v-if="!plugin.capabilities.length" class="text-xs text-muted-foreground">none</span>
                        </div>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </DataState>
            <p v-else class="text-sm text-muted-foreground">
              The <code class="font-mono">audit:read</code> scope is required to list registered plugins.
            </p>
          </CardContent>
        </Card>
      </TabsContent>

      <!-- Lifecycle tab -->
      <TabsContent value="lifecycle">
        <Card>
          <CardHeader>
            <CardTitle class="flex items-center gap-2">
              <CircleDot class="size-4 text-muted-foreground" />
              Lifecycle
            </CardTitle>
            <CardDescription>
              Installation records and runtime state. Transitions: verified → installed → active; active ↔ disabled.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <DataState
              v-if="canAdmin"
              :loading="lifecycleQuery.loading.value"
              :error="lifecycleQuery.error.value"
              :is-empty="lifecycle.length === 0"
              empty-title="No installations"
              empty-description="Verified plugin bundles will appear here once installed."
              @retry="lifecycleQuery.refresh"
            >
              <div class="overflow-x-auto">
                <table class="w-full text-sm">
                  <thead>
                    <tr class="border-b border-border text-left text-xs text-muted-foreground">
                      <th class="py-2 pr-3 font-medium">Name</th>
                      <th class="py-2 pr-3 font-medium">Type</th>
                      <th class="py-2 pr-3 font-medium">Version</th>
                      <th class="py-2 pr-3 font-medium">Status</th>
                      <th class="py-2 pr-3 font-medium">Runtime</th>
                      <th class="py-2 pr-3 font-medium">Available</th>
                      <th class="py-2 pr-3 font-medium">Artifact</th>
                      <th class="py-2 pr-3 font-medium">Capabilities</th>
                      <th class="py-2 pl-3 text-right font-medium">Actions</th>
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
                        <Badge :variant="row.available ? 'success' : 'secondary'">{{ row.available ? "yes" : "no" }}</Badge>
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
                            <Power v-if="status === 'disabled'" class="size-4" />
                            <Play v-else class="size-4" />
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
              The <code class="font-mono">plugin:admin</code> scope is required to manage plugin lifecycle.
            </p>
          </CardContent>
        </Card>
      </TabsContent>
    </Tabs>

    <!-- Transition confirm dialog -->
    <Dialog :open="!!transitionTarget" @update:open="(v) => { if (!v) transitionTarget = undefined; }">
      <DialogScrollContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Confirm lifecycle transition</DialogTitle>
          <DialogDescription>
            Move
            <span class="font-medium">{{ transitionTarget?.row.name || transitionTarget?.row.id }}</span>
            from <Badge :variant="statusVariant(transitionTarget?.row.status ?? '')">{{ transitionTarget?.row.status }}</Badge>
            to <Badge :variant="statusVariant(transitionTarget?.status ?? '')">{{ transitionTarget?.status }}</Badge>?
            <template v-if="transitionTarget?.status === 'active'"> Activating starts the plugin runtime.</template>
            <template v-else-if="transitionTarget?.status === 'disabled'"> Disabling stops the plugin runtime.</template>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" @click="transitionTarget = undefined">Cancel</Button>
          <Button
            type="button"
            :variant="transitionTarget?.status === 'disabled' ? 'destructive' : 'default'"
            :disabled="transitioning"
            @click="confirmTransition"
          >
            <RefreshCw v-if="transitioning" class="size-4 animate-spin" />
            <CheckCircle2 v-else class="size-4" />
            {{ transitionTarget ? transitionLabel(transitionTarget.status) : "Confirm" }}
          </Button>
        </DialogFooter>
      </DialogScrollContent>
    </Dialog>

    <!-- Verify dialog -->
    <Dialog v-model:open="verifyOpen">
      <DialogScrollContent class="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Verify plugin manifest</DialogTitle>
          <DialogDescription>
            Preflight a candidate manifest + artifact against the operator trust policy. Nothing is installed or executed.
          </DialogDescription>
        </DialogHeader>

        <form class="space-y-4" @submit.prevent="runVerify">
          <div class="grid gap-2">
            <Label for="verify-manifest">Manifest (JSON)</Label>
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
            <Label for="verify-artifact">Artifact (base64)</Label>
            <textarea
              id="verify-artifact"
              v-model="artifactText"
              rows="4"
              spellcheck="false"
              placeholder="base64 of the artifact bytes"
              class="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>

          <div v-if="verifyResult" class="space-y-4 rounded-md border border-success/40 bg-success/5 p-4">
            <div class="flex flex-wrap items-center gap-2">
              <Badge variant="success" class="gap-1.5">
                <ShieldCheck class="size-3.5" />
                {{ verifyResult.trusted ? "trusted" : "untrusted" }}
              </Badge>
              <Badge variant="outline">{{ verifyResult.manifest.type }}</Badge>
              <span class="text-sm font-medium">{{ verifyResult.manifest.name || verifyResult.manifest.id }}</span>
            </div>

            <div class="grid gap-2 text-xs sm:grid-cols-2">
              <div class="rounded-md border border-border p-2">
                <p class="font-medium uppercase text-muted-foreground">Manifest id</p>
                <p class="mt-1 break-all font-mono">{{ verifyResult.manifest.id }}</p>
              </div>
              <div class="rounded-md border border-border p-2">
                <p class="font-medium uppercase text-muted-foreground">Version / publisher</p>
                <p class="mt-1 font-mono">{{ verifyResult.manifest.version || "—" }} · {{ verifyResult.manifest.publisher || "—" }}</p>
              </div>
            </div>

            <div class="flex flex-wrap items-center gap-2 rounded-md bg-muted/40 p-3 text-xs">
              <span class="font-medium">artifact sha256</span>
              <code class="break-all font-mono">{{ verifyResult.artifact_sha256 }}</code>
              <CopyButton :value="verifyResult.artifact_sha256" />
            </div>

            <div class="space-y-2">
              <p class="text-xs font-medium uppercase text-muted-foreground">Capabilities</p>
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
                <span v-if="!verifyResult.capabilities.length" class="text-xs text-muted-foreground">none declared</span>
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" @click="verifyOpen = false">Close</Button>
            <Button type="submit" :disabled="verifying || !manifestText.trim() || !artifactText.trim()">
              <RefreshCw v-if="verifying" class="size-4 animate-spin" />
              <ShieldCheck v-else class="size-4" />
              Verify
            </Button>
          </DialogFooter>
        </form>
      </DialogScrollContent>
    </Dialog>
  </div>
</template>

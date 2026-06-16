<script setup lang="ts">
import { computed, ref } from "vue";
import { toast } from "vue-sonner";
import { FolderOpen, Plus, RefreshCw, Save } from "lucide-vue-next";
import { api, type StaticObject } from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { useAuthStore } from "@/stores/auth";
import { formatBytes, formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

import PageHeader from "@/components/common/PageHeader.vue";
import DataState from "@/components/common/DataState.vue";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogScrollContent,
  DialogTitle,
} from "@/components/ui/dialog";

const auth = useAuthStore();
const canRead = computed(() => auth.can("static:read"));
const canWrite = computed(() => auth.can("static:write"));

const bucket = ref("default");
const activeBucket = ref("default");

const objectsQuery = useAsyncData(
  () => api.static.list(activeBucket.value || "default"),
  { pollInterval: 0, immediate: canRead.value },
);
const objects = computed(() => objectsQuery.data.value ?? []);
const sortedObjects = computed(() =>
  [...objects.value].sort((a, b) => a.path.localeCompare(b.path)),
);

function loadBucket() {
  activeBucket.value = bucket.value.trim() || "default";
  objectsQuery.refresh();
}

// ── Row expand (content preview) ────────────────────────────────────────────
const expanded = ref<Set<string>>(new Set());
function toggleExpand(path: string) {
  const next = new Set(expanded.value);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  expanded.value = next;
}

// ── Put dialog ──────────────────────────────────────────────────────────────
const putOpen = ref(false);
const saving = ref(false);
const editing = ref(false);
const putPath = ref("");
const putContentType = ref("text/plain");
const putContent = ref("");

function openCreate() {
  editing.value = false;
  putPath.value = "";
  putContentType.value = "text/plain";
  putContent.value = "";
  putOpen.value = true;
}

function openEdit(object: StaticObject) {
  editing.value = true;
  putPath.value = object.path;
  putContentType.value = object.content_type || "text/plain";
  putContent.value = object.content;
  putOpen.value = true;
}

const canSubmit = computed(
  () => canWrite.value && !!putPath.value.trim() && !!putContentType.value.trim(),
);

async function submitPut() {
  if (!canSubmit.value) return;
  saving.value = true;
  try {
    await api.static.put({
      bucket: activeBucket.value || "default",
      path: putPath.value.trim(),
      content: putContent.value,
      content_type: putContentType.value.trim(),
    });
    toast.success(editing.value ? "Object updated" : "Object created");
    putOpen.value = false;
    objectsQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "Failed to write object");
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="p-6 space-y-6">
    <PageHeader
      title="Static"
      description="Bucketed static-object store for serving small assets via workers and proxy"
    >
      <template #actions>
        <Button variant="outline" size="sm" :disabled="objectsQuery.refreshing.value" @click="objectsQuery.refresh">
          <RefreshCw :class="cn('size-4', objectsQuery.refreshing.value && 'animate-spin')" />
          Refresh
        </Button>
        <Button v-if="canWrite" size="sm" @click="openCreate">
          <Plus class="size-4" />
          New object
        </Button>
      </template>
    </PageHeader>

    <Card>
      <CardHeader>
        <CardTitle class="flex items-center gap-2">
          <FolderOpen class="size-4 text-muted-foreground" />
          Bucket
        </CardTitle>
        <CardDescription>
          Objects in <span class="font-mono">{{ activeBucket }}</span>.
          <span v-if="!canWrite" class="text-muted-foreground">Read-only — static:write is required to modify objects.</span>
        </CardDescription>
      </CardHeader>
      <CardContent class="space-y-4">
        <form class="flex flex-wrap items-end gap-2" @submit.prevent="loadBucket">
          <div class="grid gap-2">
            <Label for="static-bucket">Bucket</Label>
            <Input id="static-bucket" v-model="bucket" class="w-64" placeholder="default" />
          </div>
          <Button type="submit" variant="outline">Load</Button>
        </form>

        <DataState
          v-if="canRead"
          :loading="objectsQuery.loading.value"
          :error="objectsQuery.error.value"
          :is-empty="objects.length === 0"
          empty-title="No objects"
          empty-description="This bucket has no stored objects yet."
          @retry="objectsQuery.refresh"
        >
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead>
                <tr class="border-b border-border text-left text-xs text-muted-foreground">
                  <th class="py-2 pr-3 font-medium">Path</th>
                  <th class="py-2 pr-3 font-medium">Content type</th>
                  <th class="py-2 pr-3 text-right font-medium">Size</th>
                  <th class="py-2 pr-3 font-medium">Updated</th>
                  <th class="py-2 pl-3 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                <template v-for="object in sortedObjects" :key="object.path">
                  <tr class="border-b border-border align-top hover:bg-muted/40" :class="expanded.has(object.path) && 'border-b-0'">
                    <td class="py-3 pr-3 font-mono text-xs">{{ object.path }}</td>
                    <td class="py-3 pr-3"><Badge variant="outline">{{ object.content_type || "—" }}</Badge></td>
                    <td class="py-3 pr-3 text-right font-mono text-xs tabular text-muted-foreground">{{ formatBytes(object.size) }}</td>
                    <td class="py-3 pr-3 text-xs text-muted-foreground">{{ formatDateTime(object.updated_at) }}</td>
                    <td class="py-3 pl-3">
                      <div class="flex items-center justify-end gap-1">
                        <Button variant="ghost" size="sm" @click="toggleExpand(object.path)">
                          {{ expanded.has(object.path) ? "Hide" : "Preview" }}
                        </Button>
                        <Button v-if="canWrite" variant="outline" size="sm" @click="openEdit(object)">Edit</Button>
                      </div>
                    </td>
                  </tr>
                  <tr v-if="expanded.has(object.path)" class="border-b border-border last:border-b-0">
                    <td colspan="5" class="px-3 pb-3">
                      <pre class="max-h-[320px] overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-3 font-mono text-xs leading-relaxed">{{ object.content }}</pre>
                    </td>
                  </tr>
                </template>
              </tbody>
            </table>
          </div>
        </DataState>
        <p v-else class="text-sm text-muted-foreground">
          The <code class="font-mono">static:read</code> scope is required to list objects.
        </p>
      </CardContent>
    </Card>

    <!-- Put dialog -->
    <Dialog v-model:open="putOpen">
      <DialogScrollContent class="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{{ editing ? "Edit object" : "New object" }}</DialogTitle>
          <DialogDescription>
            Writing to bucket <span class="font-mono">{{ activeBucket }}</span>. Paths are cleaned and validated server-side.
          </DialogDescription>
        </DialogHeader>
        <form class="space-y-4" @submit.prevent="submitPut">
          <div class="grid gap-3 sm:grid-cols-2">
            <div class="grid gap-2">
              <Label for="static-path">Path</Label>
              <Input id="static-path" v-model="putPath" required :disabled="editing" placeholder="assets/index.html" />
            </div>
            <div class="grid gap-2">
              <Label for="static-ct">Content type</Label>
              <Input id="static-ct" v-model="putContentType" required placeholder="text/plain" />
            </div>
          </div>
          <div class="grid gap-2">
            <Label for="static-content">Content</Label>
            <textarea
              id="static-content"
              v-model="putContent"
              rows="10"
              spellcheck="false"
              class="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" @click="putOpen = false">Cancel</Button>
            <Button type="submit" :disabled="!canSubmit || saving">
              <RefreshCw v-if="saving" class="size-4 animate-spin" />
              <Save v-else class="size-4" />
              {{ editing ? "Save" : "Create" }}
            </Button>
          </DialogFooter>
        </form>
      </DialogScrollContent>
    </Dialog>
  </div>
</template>

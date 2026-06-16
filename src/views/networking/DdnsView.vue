<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { toast } from "vue-sonner";
import {
  Lock,
  Play,
  Plus,
  RefreshCw,
  Trash2,
  Unlock,
} from "lucide-vue-next";
import {
  api,
  ApiError,
  unwrap,
  type DDNSUpsertRequest,
  type DDNSView,
} from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { useAuthStore } from "@/stores/auth";
import { formatDateTime, shortId } from "@/lib/format";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogScrollContent,
  DialogTitle,
} from "@/components/ui/dialog";

type Provider = "cloudflare" | "webhook";

const auth = useAuthStore();
const canAdmin = computed(() => auth.can("ddns:admin"));

// BARE ARRAY endpoint — do NOT unwrap.
const profilesQuery = useAsyncData(() => api.ddns.list(), { pollInterval: 15000 });
const nodesQuery = useAsyncData(() => api.nodes.list().then((r) => unwrap(r, "nodes")), {
  pollInterval: 15000,
});

const profiles = computed(() => profilesQuery.data.value ?? []);
const nodes = computed(() => nodesQuery.data.value ?? []);

const sortedProfiles = computed(() =>
  [...profiles.value].sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id)),
);

function nodeName(id: string): string {
  return nodes.value.find((node) => node.id === id)?.name || shortId(id, 14);
}

function providerVariant(provider: string): "info" | "secondary" {
  return provider === "cloudflare" ? "info" : "secondary";
}

// ── Create dialog ───────────────────────────────────────────────────────────
const formOpen = ref(false);
const saving = ref(false);

const form = reactive({
  name: "",
  node_id: "",
  provider: "cloudflare" as Provider,
  domains: "",
  enable_ipv4: true,
  enable_ipv6: false,
  ttl: 60,
  max_retries: 3,
  cf_api_token: "",
  webhook_url: "",
  webhook_method: "POST",
  webhook_body: "",
  webhook_headers: "",
});

function resetForm() {
  form.name = "";
  form.node_id = "";
  form.provider = "cloudflare";
  form.domains = "";
  form.enable_ipv4 = true;
  form.enable_ipv6 = false;
  form.ttl = 60;
  form.max_retries = 3;
  form.cf_api_token = "";
  form.webhook_url = "";
  form.webhook_method = "POST";
  form.webhook_body = "";
  form.webhook_headers = "";
}

function openCreate() {
  if (!canAdmin.value) return;
  resetForm();
  formOpen.value = true;
}

const parsedDomains = computed(() =>
  form.domains
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean),
);

const canSubmit = computed(() => {
  if (!form.name.trim() || !form.node_id || parsedDomains.value.length === 0) return false;
  if (form.provider === "cloudflare") return !!form.cf_api_token.trim();
  return !!form.webhook_url.trim();
});

async function submitForm() {
  if (!canSubmit.value || !canAdmin.value) return;
  saving.value = true;
  try {
    const req: DDNSUpsertRequest = {
      name: form.name.trim(),
      node_id: form.node_id,
      provider: form.provider,
      domains: parsedDomains.value,
      enable_ipv4: form.enable_ipv4,
      enable_ipv6: form.enable_ipv6,
      ttl: Number(form.ttl),
      max_retries: Number(form.max_retries),
    };
    if (form.provider === "cloudflare") {
      req.cf_api_token = form.cf_api_token.trim();
    } else {
      req.webhook_url = form.webhook_url.trim();
      req.webhook_method = form.webhook_method.trim() || "POST";
      if (form.webhook_body.trim()) req.webhook_body = form.webhook_body;
      if (form.webhook_headers.trim()) req.webhook_headers = form.webhook_headers;
    }
    await api.ddns.create(req);
    toast.success("DDNS profile created");
    formOpen.value = false;
    profilesQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "Create failed");
  } finally {
    saving.value = false;
  }
}

// ── Delete confirmation ─────────────────────────────────────────────────────
const deleteTarget = ref<DDNSView | undefined>();
const deleting = ref(false);

async function confirmDelete() {
  if (!deleteTarget.value) return;
  deleting.value = true;
  try {
    await api.ddns.delete(deleteTarget.value.id);
    toast.success("DDNS profile deleted");
    deleteTarget.value = undefined;
    profilesQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "Delete failed");
  } finally {
    deleting.value = false;
  }
}

// ── Run now ─────────────────────────────────────────────────────────────────
const running = ref<string | undefined>();

async function runNow(profile: DDNSView) {
  if (!canAdmin.value) return;
  running.value = profile.id;
  try {
    await api.ddns.run(profile.id);
    toast.success("Published current node IP to DNS");
    profilesQuery.refresh();
  } catch (error) {
    if (error instanceof ApiError && error.status === 502) {
      toast.error("Provider/network failure (502) — DNS publish did not complete");
    } else {
      toast.error(error instanceof Error ? error.message : "Run failed");
    }
  } finally {
    running.value = undefined;
  }
}
</script>

<template>
  <div class="p-6 space-y-6">
    <PageHeader
      title="DDNS"
      description="Dynamic DNS profiles — push each node's public IP to DNS when it changes"
    >
      <template #actions>
        <Button
          variant="outline"
          size="sm"
          :disabled="profilesQuery.refreshing.value"
          @click="profilesQuery.refresh"
        >
          <RefreshCw :class="cn('size-4', profilesQuery.refreshing.value && 'animate-spin')" />
          Refresh
        </Button>
        <Button v-if="canAdmin" size="sm" @click="openCreate">
          <Plus class="size-4" />
          New profile
        </Button>
      </template>
    </PageHeader>

    <Card>
      <CardHeader>
        <CardTitle class="flex items-center gap-2">
          <RefreshCw class="size-4 text-muted-foreground" />
          Profiles
        </CardTitle>
        <CardDescription>
          {{ profiles.length }} DDNS {{ profiles.length === 1 ? "profile" : "profiles" }}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <DataState
          :loading="profilesQuery.loading.value"
          :error="profilesQuery.error.value"
          :is-empty="profiles.length === 0"
          empty-title="No DDNS profiles"
          empty-description="Create a profile to publish a node's public IP to Cloudflare or a webhook."
          @retry="profilesQuery.refresh"
        >
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead>
                <tr class="border-b border-border text-left text-xs text-muted-foreground">
                  <th class="py-2 pr-4 font-medium">Name</th>
                  <th class="py-2 pr-4 font-medium">Node</th>
                  <th class="py-2 pr-4 font-medium">Provider</th>
                  <th class="py-2 pr-4 font-medium">Domains</th>
                  <th class="py-2 pr-4 font-medium">Stack</th>
                  <th class="py-2 pr-4 font-medium">Credential</th>
                  <th class="py-2 pr-4 font-medium">Last run</th>
                  <th class="py-2 pr-4 font-medium">Last IPs</th>
                  <th class="py-2 pr-4 font-medium">Last error</th>
                  <th class="py-2 pl-4 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="profile in sortedProfiles"
                  :key="profile.id"
                  class="border-b border-border last:border-b-0 hover:bg-muted/40"
                >
                  <td class="py-3 pr-4">
                    <div class="font-medium">{{ profile.name || profile.id }}</div>
                    <div class="font-mono text-xs text-muted-foreground">{{ shortId(profile.id, 16) }}</div>
                  </td>
                  <td class="py-3 pr-4">{{ nodeName(profile.node_id) }}</td>
                  <td class="py-3 pr-4">
                    <Badge :variant="providerVariant(profile.provider)">{{ profile.provider }}</Badge>
                  </td>
                  <td class="py-3 pr-4 max-w-[200px]">
                    <div class="flex flex-wrap gap-1">
                      <Badge v-for="domain in profile.domains" :key="domain" variant="outline" class="font-mono">
                        {{ domain }}
                      </Badge>
                    </div>
                  </td>
                  <td class="py-3 pr-4">
                    <div class="flex flex-wrap gap-1">
                      <Badge :variant="profile.enable_ipv4 ? 'success' : 'secondary'">v4</Badge>
                      <Badge :variant="profile.enable_ipv6 ? 'success' : 'secondary'">v6</Badge>
                    </div>
                  </td>
                  <td class="py-3 pr-4">
                    <Badge :variant="profile.has_credential ? 'success' : 'secondary'">
                      <Lock v-if="profile.has_credential" class="size-3" />
                      <Unlock v-else class="size-3" />
                      {{ profile.has_credential ? "set" : "none" }}
                    </Badge>
                  </td>
                  <td class="py-3 pr-4 text-xs text-muted-foreground">
                    {{ profile.last_run_at ? formatDateTime(profile.last_run_at) : "never" }}
                  </td>
                  <td class="py-3 pr-4 font-mono text-xs text-muted-foreground">
                    <div v-if="profile.last_ipv4">{{ profile.last_ipv4 }}</div>
                    <div v-if="profile.last_ipv6">{{ profile.last_ipv6 }}</div>
                    <span v-if="!profile.last_ipv4 && !profile.last_ipv6">—</span>
                  </td>
                  <td class="py-3 pr-4 max-w-[180px]">
                    <span v-if="profile.last_error" class="break-words text-xs text-destructive">
                      {{ profile.last_error }}
                    </span>
                    <span v-else class="text-xs text-muted-foreground">—</span>
                  </td>
                  <td class="py-3 pl-4">
                    <div class="flex justify-end gap-1">
                      <Button
                        v-if="canAdmin"
                        variant="ghost"
                        size="sm"
                        :disabled="running === profile.id"
                        @click="runNow(profile)"
                      >
                        <RefreshCw v-if="running === profile.id" class="size-4 animate-spin" />
                        <Play v-else class="size-4" />
                        Run now
                      </Button>
                      <Button
                        v-if="canAdmin"
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Delete"
                        @click="deleteTarget = profile"
                      >
                        <Trash2 class="size-4 text-destructive" />
                      </Button>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </DataState>
      </CardContent>
    </Card>

    <!-- Create dialog -->
    <Dialog v-model:open="formOpen">
      <DialogScrollContent class="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New DDNS profile</DialogTitle>
          <DialogDescription>
            Bind a node to a DNS publishing backend. Credentials are write-only and never returned.
          </DialogDescription>
        </DialogHeader>

        <form class="space-y-4" @submit.prevent="submitForm">
          <div class="grid gap-3 sm:grid-cols-2">
            <div class="grid gap-2">
              <Label for="ddns-name">Name</Label>
              <Input id="ddns-name" v-model="form.name" required placeholder="edge-ddns" />
            </div>
            <div class="grid gap-2">
              <Label for="ddns-node">Node</Label>
              <Select v-model="form.node_id">
                <SelectTrigger id="ddns-node">
                  <SelectValue placeholder="Select a node" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="node in nodes" :key="node.id" :value="node.id">
                    {{ node.name || node.id }}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div class="grid gap-2">
            <Label for="ddns-domains">Domains</Label>
            <Input id="ddns-domains" v-model="form.domains" required placeholder="a.example.com, b.example.com" />
            <p class="text-xs text-muted-foreground">Comma-separated. Records are pushed for every entry.</p>
          </div>

          <div class="grid gap-3 sm:grid-cols-2">
            <div class="grid gap-2">
              <Label for="ddns-provider">Provider</Label>
              <select
                id="ddns-provider"
                v-model="form.provider"
                class="h-9 rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="cloudflare">Cloudflare</option>
                <option value="webhook">Webhook</option>
              </select>
            </div>
            <div class="flex flex-wrap items-end gap-4 pb-1">
              <label class="flex items-center gap-2 text-sm">
                <input v-model="form.enable_ipv4" type="checkbox" class="size-4 accent-primary" />
                IPv4 (A)
              </label>
              <label class="flex items-center gap-2 text-sm">
                <input v-model="form.enable_ipv6" type="checkbox" class="size-4 accent-primary" />
                IPv6 (AAAA)
              </label>
            </div>
          </div>

          <div class="grid gap-3 sm:grid-cols-2">
            <div class="grid gap-2">
              <Label for="ddns-ttl">TTL (seconds)</Label>
              <Input id="ddns-ttl" v-model.number="form.ttl" type="number" min="1" />
            </div>
            <div class="grid gap-2">
              <Label for="ddns-retries">Max retries</Label>
              <Input id="ddns-retries" v-model.number="form.max_retries" type="number" min="0" />
            </div>
          </div>

          <!-- Cloudflare -->
          <div v-if="form.provider === 'cloudflare'" class="grid gap-2">
            <Label for="ddns-cf-token">Cloudflare API token</Label>
            <Input
              id="ddns-cf-token"
              v-model="form.cf_api_token"
              type="password"
              autocomplete="off"
              placeholder="write-only — needs Zone:Read + DNS:Edit"
            />
            <p class="text-xs text-muted-foreground">Stored write-only; never returned by the API.</p>
          </div>

          <!-- Webhook -->
          <template v-else>
            <div class="grid gap-3 sm:grid-cols-[1fr_140px]">
              <div class="grid gap-2">
                <Label for="ddns-wh-url">Webhook URL</Label>
                <Input id="ddns-wh-url" v-model="form.webhook_url" placeholder="https://example.com/ddns" />
              </div>
              <div class="grid gap-2">
                <Label for="ddns-wh-method">Method</Label>
                <Input id="ddns-wh-method" v-model="form.webhook_method" placeholder="POST" />
              </div>
            </div>
            <div class="grid gap-2">
              <Label for="ddns-wh-body">Webhook body</Label>
              <textarea
                id="ddns-wh-body"
                v-model="form.webhook_body"
                rows="3"
                class="rounded-md border border-input bg-background px-3 py-2 font-mono text-xs"
                placeholder='{"ip":"#ip#","domain":"#domain#","type":"#type#"}'
              />
              <p class="text-xs text-muted-foreground">
                Write-only. Supports template tokens
                <code class="font-mono">#ip#</code>, <code class="font-mono">#domain#</code>,
                <code class="font-mono">#type#</code>.
              </p>
            </div>
            <div class="grid gap-2">
              <Label for="ddns-wh-headers">Webhook headers</Label>
              <textarea
                id="ddns-wh-headers"
                v-model="form.webhook_headers"
                rows="2"
                class="rounded-md border border-input bg-background px-3 py-2 font-mono text-xs"
                placeholder="Authorization: Bearer xxx&#10;Content-Type: application/json"
              />
              <p class="text-xs text-muted-foreground">Write-only. One "Key: Value" per line.</p>
            </div>
          </template>

          <DialogFooter>
            <DialogClose as-child>
              <Button type="button" variant="outline">Cancel</Button>
            </DialogClose>
            <Button type="submit" :disabled="saving || !canSubmit">
              <RefreshCw v-if="saving" class="size-4 animate-spin" />
              <Plus v-else class="size-4" />
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogScrollContent>
    </Dialog>

    <!-- Delete confirmation -->
    <Dialog :open="!!deleteTarget" @update:open="(v) => { if (!v) deleteTarget = undefined; }">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete DDNS profile?</DialogTitle>
          <DialogDescription>
            Remove "{{ deleteTarget?.name || deleteTarget?.id }}". This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose as-child>
            <Button type="button" variant="outline">Cancel</Button>
          </DialogClose>
          <Button type="button" variant="destructive" :disabled="deleting" @click="confirmDelete">
            <RefreshCw v-if="deleting" class="size-4 animate-spin" />
            <Trash2 v-else class="size-4" />
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>

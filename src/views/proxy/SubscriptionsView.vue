<script setup lang="ts">
import { computed, ref } from "vue";
import { toast } from "vue-sonner";
import {
  CircleSlash,
  Lock,
  RefreshCw,
  Rss,
  TriangleAlert,
} from "lucide-vue-next";
import {
  api,
  unwrap,
  type ProxyUserStatus,
  type ProxyUserView,
  type RotateSubTokenResponse,
} from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { useAuthStore } from "@/stores/auth";
import { formatBytes, formatRelativeTime, shortId } from "@/lib/format";
import { cn } from "@/lib/utils";

import PageHeader from "@/components/common/PageHeader.vue";
import DataState from "@/components/common/DataState.vue";
import StatCard from "@/components/common/StatCard.vue";
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
import { Progress } from "@/components/ui/progress";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogScrollContent,
  DialogTitle,
} from "@/components/ui/dialog";

const auth = useAuthStore();

const usersQuery = useAsyncData(
  () => api.proxy.users().then((r) => unwrap(r, "users")),
  { pollInterval: 12000 },
);

const users = computed(() => usersQuery.data.value ?? []);
const canAdmin = computed(() => auth.can("proxy:admin"));
const adminReason = "proxy:admin scope is required to reveal subscription tokens.";

const sortedUsers = computed(() =>
  [...users.value].sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    return (a.name || a.id).localeCompare(b.name || b.id);
  }),
);

function countBy(status: ProxyUserStatus): number {
  return users.value.filter((u) => u.status === status).length;
}

const kpis = computed(() => ({
  total: users.value.length,
  active: countBy("active"),
  expired: countBy("expired"),
  overQuota: countBy("over_quota"),
  disabled: countBy("disabled"),
}));

function statusVariant(status: ProxyUserStatus): "success" | "warning" | "secondary" {
  if (status === "active") return "success";
  if (status === "expired" || status === "over_quota") return "warning";
  return "secondary";
}

function isUnlimited(user: ProxyUserView): boolean {
  return !user.traffic_limit_bytes || user.traffic_limit_bytes <= 0;
}

function usagePercent(user: ProxyUserView): number {
  const limit = user.traffic_limit_bytes ?? 0;
  if (limit <= 0) return 0;
  return Math.min(100, Math.max(0, (user.used_bytes / limit) * 100));
}

function limitLabel(user: ProxyUserView): string {
  return isUnlimited(user) ? "unlimited" : formatBytes(user.traffic_limit_bytes);
}

// ---- Reveal subscription (rotate) ----
const revealOpen = ref(false);
const rotating = ref<string | undefined>();
const revealed = ref<RotateSubTokenResponse | undefined>();

function subFormats(baseUrl: string): { label: string; url: string }[] {
  const sep = baseUrl.includes("?") ? "&" : "?";
  return [
    { label: "default (base64)", url: baseUrl },
    { label: "plain", url: `${baseUrl}${sep}format=plain` },
    { label: "sing-box", url: `${baseUrl}${sep}format=sing-box` },
    { label: "clash", url: `${baseUrl}${sep}format=clash` },
  ];
}

const revealedFormats = computed(() =>
  revealed.value ? subFormats(revealed.value.subscription_url) : [],
);

async function reveal(user: ProxyUserView) {
  if (!canAdmin.value || rotating.value) return;
  rotating.value = user.id;
  try {
    const result = await api.proxy.rotateSubToken(user.id);
    revealed.value = result;
    revealOpen.value = true;
    usersQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "Failed to reveal subscription");
  } finally {
    rotating.value = undefined;
  }
}

function closeReveal(open: boolean) {
  revealOpen.value = open;
  if (!open) revealed.value = undefined;
}
</script>

<template>
  <div class="p-6 space-y-6">
    <PageHeader
      title="Subscriptions"
      description="Subscriber-facing distribution and health for proxy users"
    >
      <template #actions>
        <Button
          variant="outline"
          size="sm"
          :disabled="usersQuery.refreshing.value"
          @click="usersQuery.refresh"
        >
          <RefreshCw :class="cn('size-4', usersQuery.refreshing.value && 'animate-spin')" />
          Refresh
        </Button>
      </template>
    </PageHeader>

    <div class="grid gap-4 sm:grid-cols-3 xl:grid-cols-5">
      <StatCard label="Total" :value="kpis.total" :icon="Rss" />
      <StatCard label="Active" :value="kpis.active" :icon="Rss" tone="success" />
      <StatCard label="Expired" :value="kpis.expired" :icon="TriangleAlert" :tone="kpis.expired > 0 ? 'warning' : 'default'" />
      <StatCard label="Over quota" :value="kpis.overQuota" :icon="TriangleAlert" :tone="kpis.overQuota > 0 ? 'warning' : 'default'" />
      <StatCard label="Disabled" :value="kpis.disabled" :icon="CircleSlash" />
    </div>

    <Card>
      <CardHeader>
        <CardTitle class="flex items-center gap-2">
          <Rss class="size-4 text-muted-foreground" />
          Subscription Delivery
        </CardTitle>
        <CardDescription>
          Distribution health per subscriber. Revealing a subscription rotates the token and invalidates the old one.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <DataState
          :loading="usersQuery.loading.value"
          :error="usersQuery.error.value"
          :is-empty="users.length === 0"
          empty-title="No subscribers"
          empty-description="Create proxy users to distribute subscriptions."
          @retry="usersQuery.refresh"
        >
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead>
                <tr class="border-b border-border text-xs text-muted-foreground">
                  <th class="px-3 py-2 text-left font-medium">User</th>
                  <th class="px-3 py-2 text-left font-medium">Status</th>
                  <th class="px-3 py-2 text-left font-medium">Quota usage</th>
                  <th class="px-3 py-2 text-left font-medium">Expiry</th>
                  <th class="px-3 py-2 text-left font-medium">Sub-token</th>
                  <th class="px-3 py-2 text-right font-medium">Delivery</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="user in sortedUsers"
                  :key="user.id"
                  class="border-b border-border hover:bg-muted/40"
                >
                  <td class="px-3 py-3">
                    <div class="font-medium">{{ user.name || shortId(user.id) }}</div>
                    <div class="font-mono text-xs text-muted-foreground">{{ shortId(user.id, 16) }}</div>
                  </td>
                  <td class="px-3 py-3">
                    <Badge :variant="statusVariant(user.status)">{{ user.status }}</Badge>
                  </td>
                  <td class="px-3 py-3">
                    <div class="min-w-[160px] space-y-1">
                      <div class="flex items-center justify-between gap-2 text-xs">
                        <span class="font-mono tabular">{{ formatBytes(user.used_bytes) }}</span>
                        <span class="text-muted-foreground">/ {{ limitLabel(user) }}</span>
                      </div>
                      <Progress
                        v-if="!isUnlimited(user)"
                        :model-value="usagePercent(user)"
                        :indicator-class="usagePercent(user) >= 100 ? 'bg-warning' : undefined"
                      />
                      <div v-else class="text-xs text-muted-foreground">no quota limit</div>
                    </div>
                  </td>
                  <td class="px-3 py-3 text-xs">
                    <span v-if="user.expires_at" :class="cn(user.status === 'expired' && 'text-warning')">
                      {{ formatRelativeTime(user.expires_at) }}
                    </span>
                    <span v-else class="text-muted-foreground">never</span>
                  </td>
                  <td class="px-3 py-3">
                    <Badge :variant="user.has_sub_token ? 'success' : 'secondary'" class="gap-1">
                      <Lock class="size-3" />
                      {{ user.has_sub_token ? "set" : "none" }}
                    </Badge>
                  </td>
                  <td class="px-3 py-3">
                    <div class="flex justify-end">
                      <Button
                        v-if="user.has_sub_token"
                        size="sm"
                        variant="outline"
                        :disabled="!canAdmin || rotating === user.id"
                        :title="canAdmin ? 'Reveal subscription (rotates token)' : adminReason"
                        @click="reveal(user)"
                      >
                        <RefreshCw v-if="rotating === user.id" class="size-4 animate-spin" />
                        <Rss v-else class="size-4" />
                        Reveal
                      </Button>
                      <span v-else class="text-xs text-muted-foreground">no token — create in Users</span>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </DataState>
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <CardTitle>How clients consume subscriptions</CardTitle>
        <CardDescription>Operator reference for the public <code class="font-mono">/sub/&lt;token&gt;</code> endpoint.</CardDescription>
      </CardHeader>
      <CardContent class="space-y-3 text-sm text-muted-foreground">
        <p>
          Clients fetch <code class="font-mono text-foreground">/sub/&lt;token&gt;</code>. The default body is
          base64-encoded; append <code class="font-mono text-foreground">?format=plain</code>,
          <code class="font-mono text-foreground">?format=sing-box</code>, or
          <code class="font-mono text-foreground">?format=clash</code> for other client formats.
        </p>
        <p>
          The server enforces quota and expiry by serving an <span class="text-foreground">empty subscription</span>
          for ineligible users — the token stays valid, it simply yields zero links until the user is eligible again.
        </p>
        <p>
          Tokens are <span class="text-foreground">write-only and revealed once</span>. The usable URL is only
          returned by a rotate, which invalidates any previously distributed URL for that user.
        </p>
      </CardContent>
    </Card>

    <!-- Reveal subscription: one-time reveal -->
    <Dialog :open="revealOpen" @update:open="closeReveal">
      <DialogScrollContent class="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Subscription revealed</DialogTitle>
          <DialogDescription>
            {{ revealed?.user.name || revealed?.user.id }} — copy now, the token is shown once.
          </DialogDescription>
        </DialogHeader>

        <div v-if="revealed" class="space-y-4">
          <div class="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/5 p-3 text-sm text-warning">
            <TriangleAlert class="mt-0.5 size-4 shrink-0" />
            <span>
              Copy now — the token is shown once. Revealing rotated the token, so any previously shared URL for this
              user no longer works.
            </span>
          </div>

          <div class="rounded-md border border-border">
            <div class="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
              <span class="text-sm font-medium">Subscription URL</span>
              <CopyButton :value="revealed.subscription_url" label="Copy" />
            </div>
            <code class="block break-all p-3 font-mono text-xs">{{ revealed.subscription_url }}</code>
          </div>

          <div class="space-y-2">
            <p class="text-xs font-medium text-muted-foreground">Client format URLs</p>
            <div
              v-for="fmt in revealedFormats"
              :key="fmt.label"
              class="flex items-center justify-between gap-2 rounded-md bg-muted/40 px-3 py-2"
            >
              <div class="min-w-0">
                <p class="text-xs font-medium">{{ fmt.label }}</p>
                <code class="block break-all font-mono text-xs text-muted-foreground">{{ fmt.url }}</code>
              </div>
              <CopyButton :value="fmt.url" />
            </div>
          </div>

          <div class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span class="font-medium">token sha256</span>
            <code class="break-all font-mono">{{ revealed.token_sha256 }}</code>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" @click="closeReveal(false)">Done</Button>
        </DialogFooter>
      </DialogScrollContent>
    </Dialog>
  </div>
</template>

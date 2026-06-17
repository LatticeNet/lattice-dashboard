<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
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
const { t } = useI18n();

const usersQuery = useAsyncData(
  () => api.proxy.users().then((r) => unwrap(r, "users")),
  { pollInterval: 12000 },
);

const users = computed(() => usersQuery.data.value ?? []);
const canAdmin = computed(() => auth.can("proxy:admin"));
const adminReason = computed(() => t("proxy.subscriptions.adminReason"));

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
  return isUnlimited(user) ? t("proxy.subscriptions.unlimited") : formatBytes(user.traffic_limit_bytes);
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
    toast.error(error instanceof Error ? error.message : t("proxy.subscriptions.toastRevealFailed"));
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
      :title="$t('proxy.subscriptions.title')"
      :description="$t('proxy.subscriptions.description')"
    >
      <template #actions>
        <Button
          variant="outline"
          size="sm"
          :disabled="usersQuery.refreshing.value"
          @click="usersQuery.refresh"
        >
          <RefreshCw :class="cn('size-4', usersQuery.refreshing.value && 'animate-spin')" aria-hidden="true" />
          {{ $t('common.actions.refresh') }}
        </Button>
      </template>
    </PageHeader>

    <div class="grid gap-4 sm:grid-cols-3 xl:grid-cols-5">
      <StatCard :label="$t('proxy.subscriptions.kpiTotal')" :value="kpis.total" :icon="Rss" />
      <StatCard :label="$t('proxy.subscriptions.kpiActive')" :value="kpis.active" :icon="Rss" tone="success" />
      <StatCard :label="$t('proxy.subscriptions.kpiExpired')" :value="kpis.expired" :icon="TriangleAlert" :tone="kpis.expired > 0 ? 'warning' : 'default'" />
      <StatCard :label="$t('proxy.subscriptions.kpiOverQuota')" :value="kpis.overQuota" :icon="TriangleAlert" :tone="kpis.overQuota > 0 ? 'warning' : 'default'" />
      <StatCard :label="$t('proxy.subscriptions.kpiDisabled')" :value="kpis.disabled" :icon="CircleSlash" />
    </div>

    <Card>
      <CardHeader>
        <CardTitle class="flex items-center gap-2">
          <Rss class="size-4 text-muted-foreground" aria-hidden="true" />
          {{ $t('proxy.subscriptions.delivery') }}
        </CardTitle>
        <CardDescription>
          {{ $t('proxy.subscriptions.deliveryDescription') }}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <DataState
          :loading="usersQuery.loading.value"
          :error="usersQuery.error.value"
          :is-empty="users.length === 0"
          :empty-title="$t('proxy.subscriptions.emptyTitle')"
          :empty-description="$t('proxy.subscriptions.emptyDescription')"
          @retry="usersQuery.refresh"
        >
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead>
                <tr class="border-b border-border text-xs text-muted-foreground">
                  <th scope="col" class="px-3 py-2 text-left font-medium">{{ $t('proxy.subscriptions.colUser') }}</th>
                  <th scope="col" class="px-3 py-2 text-left font-medium">{{ $t('proxy.subscriptions.colStatus') }}</th>
                  <th scope="col" class="px-3 py-2 text-left font-medium">{{ $t('proxy.subscriptions.colQuotaUsage') }}</th>
                  <th scope="col" class="px-3 py-2 text-left font-medium">{{ $t('proxy.subscriptions.colExpiry') }}</th>
                  <th scope="col" class="px-3 py-2 text-left font-medium">{{ $t('proxy.subscriptions.colSubToken') }}</th>
                  <th scope="col" class="px-3 py-2 text-right font-medium">{{ $t('proxy.subscriptions.colDelivery') }}</th>
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
                    <Badge :variant="statusVariant(user.status)">{{ $t('common.status.' + (user.status === 'over_quota' ? 'overQuota' : user.status)) }}</Badge>
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
                      <div v-else class="text-xs text-muted-foreground">{{ $t('proxy.subscriptions.noQuotaLimit') }}</div>
                    </div>
                  </td>
                  <td class="px-3 py-3 text-xs">
                    <span v-if="user.expires_at" :class="cn(user.status === 'expired' && 'text-warning')">
                      {{ formatRelativeTime(user.expires_at) }}
                    </span>
                    <span v-else class="text-muted-foreground">{{ $t('common.misc.never') }}</span>
                  </td>
                  <td class="px-3 py-3">
                    <Badge :variant="user.has_sub_token ? 'success' : 'secondary'" class="gap-1">
                      <Lock class="size-3" aria-hidden="true" />
                      {{ user.has_sub_token ? $t('common.status.set') : $t('common.misc.none') }}
                    </Badge>
                  </td>
                  <td class="px-3 py-3">
                    <div class="flex justify-end">
                      <Button
                        v-if="user.has_sub_token"
                        size="sm"
                        variant="outline"
                        :disabled="!canAdmin || rotating === user.id"
                        :title="canAdmin ? $t('proxy.subscriptions.revealTitleAction') : adminReason"
                        @click="reveal(user)"
                      >
                        <RefreshCw v-if="rotating === user.id" class="size-4 animate-spin" aria-hidden="true" />
                        <Rss v-else class="size-4" aria-hidden="true" />
                        {{ $t('proxy.subscriptions.reveal') }}
                      </Button>
                      <span v-else class="text-xs text-muted-foreground">{{ $t('proxy.subscriptions.noTokenCreateInUsers') }}</span>
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
        <CardTitle>{{ $t('proxy.subscriptions.howTitle') }}</CardTitle>
        <CardDescription>{{ $t('proxy.subscriptions.howDescriptionPrefix') }} <code class="font-mono">/sub/&lt;token&gt;</code> {{ $t('proxy.subscriptions.howDescriptionSuffix') }}</CardDescription>
      </CardHeader>
      <CardContent class="space-y-3 text-sm text-muted-foreground">
        <p>
          {{ $t('proxy.subscriptions.howClientsFetchPrefix') }} <code class="font-mono text-foreground">/sub/&lt;token&gt;</code>{{ $t('proxy.subscriptions.howClientsFetchMid') }}
          <code class="font-mono text-foreground">?format=plain</code>{{ $t('proxy.subscriptions.howClientsFetchOr') }}
          <code class="font-mono text-foreground">?format=sing-box</code>{{ $t('proxy.subscriptions.howClientsFetchOr2') }}
          <code class="font-mono text-foreground">?format=clash</code> {{ $t('proxy.subscriptions.howClientsFetchSuffix') }}
        </p>
        <p>
          {{ $t('proxy.subscriptions.howQuotaPrefix') }} <span class="text-foreground">{{ $t('proxy.subscriptions.howQuotaEmphasis') }}</span>
          {{ $t('proxy.subscriptions.howQuotaSuffix') }}
        </p>
        <p>
          {{ $t('proxy.subscriptions.howTokensPrefix') }} <span class="text-foreground">{{ $t('proxy.subscriptions.howTokensEmphasis') }}</span>{{ $t('proxy.subscriptions.howTokensSuffix') }}
        </p>
      </CardContent>
    </Card>

    <!-- Reveal subscription: one-time reveal -->
    <Dialog :open="revealOpen" @update:open="closeReveal">
      <DialogScrollContent class="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{{ $t('proxy.subscriptions.revealedTitle') }}</DialogTitle>
          <DialogDescription>
            {{ $t('proxy.subscriptions.revealedDescription', { name: revealed?.user.name || revealed?.user.id }) }}
          </DialogDescription>
        </DialogHeader>

        <div v-if="revealed" class="space-y-4">
          <div class="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/5 p-3 text-sm text-warning">
            <TriangleAlert class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>
              {{ $t('proxy.subscriptions.revealedWarning') }}
            </span>
          </div>

          <div class="rounded-md border border-border">
            <div class="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
              <span class="text-sm font-medium">{{ $t('proxy.subscriptions.subscriptionUrl') }}</span>
              <CopyButton :value="revealed.subscription_url" :label="$t('common.actions.copy')" />
            </div>
            <code class="block break-all p-3 font-mono text-xs">{{ revealed.subscription_url }}</code>
          </div>

          <div class="space-y-2">
            <p class="text-xs font-medium text-muted-foreground">{{ $t('proxy.subscriptions.clientFormatUrls') }}</p>
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
            <span class="font-medium">{{ $t('proxy.subscriptions.tokenSha256') }}</span>
            <code class="break-all font-mono">{{ revealed.token_sha256 }}</code>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" @click="closeReveal(false)">{{ $t('common.actions.done') }}</Button>
        </DialogFooter>
      </DialogScrollContent>
    </Dialog>
  </div>
</template>

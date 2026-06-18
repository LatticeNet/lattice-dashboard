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
import FreshnessLabel from "@/components/common/FreshnessLabel.vue";
import ConfirmDialog from "@/components/common/ConfirmDialog.vue";
import DataTable, { type DataTableColumn } from "@/components/common/DataTable.vue";
import StatCard from "@/components/common/StatCard.vue";
import CopyButton from "@/components/common/CopyButton.vue";
import { lifecycleStatusMeta, quotaStatusMeta } from "@/lib/status";
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

function statusVariant(status: ProxyUserStatus) {
  return lifecycleStatusMeta(status).badgeVariant;
}

function isUnlimited(user: ProxyUserView): boolean {
  return !user.traffic_limit_bytes || user.traffic_limit_bytes <= 0;
}

function usagePercent(user: ProxyUserView): number {
  const limit = user.traffic_limit_bytes ?? 0;
  if (limit <= 0) return 0;
  return Math.min(100, Math.max(0, (user.used_bytes / limit) * 100));
}

// Quota progress fill color via the shared quota scale (ok/near/over).
function quotaIndicatorClass(user: ProxyUserView): string | undefined {
  const limit = user.traffic_limit_bytes ?? 0;
  if (limit <= 0) return undefined;
  const meta = quotaStatusMeta((user.used_bytes || 0) / limit);
  if (meta.textClass === "text-destructive") return "bg-destructive";
  if (meta.textClass === "text-warning") return "bg-warning";
  return undefined;
}

// Expiry text turns destructive once expired/over quota, amber when expiring soon.
function expiryClass(user: ProxyUserView): string {
  if (user.status === "expired" || user.status === "over_quota") return "text-warning";
  return "";
}

function limitLabel(user: ProxyUserView): string {
  return isUnlimited(user) ? t("proxy.subscriptions.unlimited") : formatBytes(user.traffic_limit_bytes);
}

// ── DataTable columns ──────────────────────────────────────────────────────────
const userColumns = computed<DataTableColumn<ProxyUserView>[]>(() => [
  { key: "user", label: t("proxy.subscriptions.colUser"), sortable: true, searchable: true, value: (u) => u.name || u.id },
  { key: "status", label: t("proxy.subscriptions.colStatus"), sortable: true, value: (u) => u.status },
  { key: "quota", label: t("proxy.subscriptions.colQuotaUsage"), sortable: true, value: (u) => (isUnlimited(u) ? -1 : usagePercent(u)) },
  { key: "expiry", label: t("proxy.subscriptions.colExpiry"), sortable: true, value: (u) => u.expires_at || "" },
  { key: "subToken", label: t("proxy.subscriptions.colSubToken"), sortable: true, value: (u) => (u.has_sub_token ? 1 : 0) },
  { key: "delivery", label: t("proxy.subscriptions.colDelivery"), align: "right" },
]);

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

// Revealing rotates the token (invalidating any previously shared URL): confirm first.
const confirmTarget = ref<ProxyUserView | undefined>();
const confirmOpen = ref(false);

function askReveal(user: ProxyUserView) {
  if (!canAdmin.value || rotating.value) return;
  confirmTarget.value = user;
  confirmOpen.value = true;
}

async function reveal(user: ProxyUserView) {
  if (!canAdmin.value || rotating.value) return;
  rotating.value = user.id;
  try {
    const result = await api.proxy.rotateSubToken(user.id);
    revealed.value = result;
    confirmOpen.value = false;
    confirmTarget.value = undefined;
    revealOpen.value = true;
    usersQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("proxy.subscriptions.toastRevealFailed"));
  } finally {
    rotating.value = undefined;
  }
}

function confirmReveal() {
  if (confirmTarget.value) reveal(confirmTarget.value);
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
      <template #status>
        <FreshnessLabel :last-updated="usersQuery.lastUpdated.value" />
      </template>
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
        <DataTable
          :columns="userColumns"
          :rows="sortedUsers"
          :row-key="(u) => u.id"
          :loading="usersQuery.loading.value"
          :error="usersQuery.error.value"
          :page-size="15"
          searchable
          :search-placeholder="$t('proxy.subscriptions.searchPlaceholder')"
          :empty-title="$t('proxy.subscriptions.emptyTitle')"
          :empty-description="$t('proxy.subscriptions.emptyDescription')"
          :no-match-title="$t('proxy.table.noMatchTitle')"
          :no-match-description="$t('proxy.table.noMatchDescription')"
          :actions-label="$t('proxy.subscriptions.colDelivery')"
          :showing-label="$t('proxy.table.showing')"
          :of-label="$t('proxy.table.of')"
          :page-of-label="$t('proxy.table.of')"
          :prev-label="$t('proxy.table.prevPage')"
          :next-label="$t('proxy.table.nextPage')"
          :clear-search-label="$t('proxy.table.clearSearch')"
          @retry="usersQuery.refresh"
        >
          <template #cell-user="{ row }">
            <div class="min-w-0">
              <div class="font-medium">{{ row.name || shortId(row.id) }}</div>
              <div class="font-mono text-xs text-muted-foreground">{{ shortId(row.id, 16) }}</div>
            </div>
          </template>
          <template #cell-status="{ row }">
            <Badge :variant="statusVariant(row.status)">{{ $t('common.status.' + (row.status === 'over_quota' ? 'overQuota' : row.status)) }}</Badge>
          </template>
          <template #cell-quota="{ row }">
            <div class="min-w-[160px] space-y-1">
              <div class="flex items-center justify-between gap-2 text-xs">
                <span class="font-mono tabular">{{ formatBytes(row.used_bytes) }}</span>
                <span class="text-muted-foreground">/ {{ limitLabel(row) }}</span>
              </div>
              <Progress
                v-if="!isUnlimited(row)"
                :model-value="usagePercent(row)"
                :indicator-class="quotaIndicatorClass(row)"
              />
              <div v-else class="text-xs text-muted-foreground">{{ $t('proxy.subscriptions.noQuotaLimit') }}</div>
            </div>
          </template>
          <template #cell-expiry="{ row }">
            <span v-if="row.expires_at" class="text-xs" :class="cn(expiryClass(row))">
              {{ formatRelativeTime(row.expires_at) }}
            </span>
            <span v-else class="text-xs text-muted-foreground">{{ $t('common.misc.never') }}</span>
          </template>
          <template #cell-subToken="{ row }">
            <Badge :variant="row.has_sub_token ? 'success' : 'secondary'" class="gap-1">
              <Lock class="size-3" aria-hidden="true" />
              {{ row.has_sub_token ? $t('common.status.set') : $t('common.misc.none') }}
            </Badge>
          </template>
          <template #cell-delivery="{ row }">
            <div class="flex justify-end">
              <Button
                v-if="row.has_sub_token"
                size="sm"
                variant="outline"
                :disabled="!canAdmin || rotating === row.id"
                :title="canAdmin ? $t('proxy.subscriptions.revealTitleAction') : adminReason"
                @click="askReveal(row)"
              >
                <RefreshCw v-if="rotating === row.id" class="size-4 animate-spin" aria-hidden="true" />
                <Rss v-else class="size-4" aria-hidden="true" />
                {{ $t('proxy.subscriptions.reveal') }}
              </Button>
              <span v-else class="text-xs text-muted-foreground">{{ $t('proxy.subscriptions.noTokenCreateInUsers') }}</span>
            </div>
          </template>
        </DataTable>
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

    <!-- Confirm rotate before revealing (invalidates the previous URL) -->
    <ConfirmDialog
      v-model:open="confirmOpen"
      :title="$t('proxy.subscriptions.confirmRevealTitle')"
      :description="$t('proxy.subscriptions.confirmRevealDescription', { name: confirmTarget?.name || confirmTarget?.id })"
      :confirm-label="$t('proxy.subscriptions.reveal')"
      :cancel-label="$t('common.actions.cancel')"
      variant="default"
      :pending="!!rotating"
      @confirm="confirmReveal"
    />

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

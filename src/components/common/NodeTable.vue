<script setup lang="ts">
/**
 * NodeTable — the horizontal, scan-many-nodes counterpart to {@link NodeCard}.
 *
 * Reuses the horizontal-table pattern from MonitoringView's result log: a
 * grid-cols header + rows wrapped in `overflow-x-auto` with a `min-w` so the
 * dense column set scrolls horizontally on narrow viewports instead of wrapping.
 *
 * Presentational only — it does NOT fetch and does NOT mutate. It re-emits the
 * same intents NodesView already wires for NodeCard (`open` / `terminal` /
 * `rotate` / `set-disabled`) so the two view modes share one set of handlers.
 */
import { useI18n } from "vue-i18n";
import { ArrowDown, ArrowUp, KeyRound, Power, SquareTerminal } from "lucide-vue-next";
import type { Node } from "@/lib/api/types";
import { nodeStatusMeta } from "@/lib/status";
import { formatBytesPerSec, formatRelativeTime, ratio, shortId } from "@/lib/format";

import StatusDot from "@/components/common/StatusDot.vue";
import MetricBar from "@/components/common/MetricBar.vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

const props = withDefaults(
  defineProps<{
    /** Rows to render (already filtered/sorted by the caller). */
    nodes: Node[];
    /** Gate the terminal action. */
    canOpenTerminal?: boolean;
    /** Gate the rotate / disable actions. */
    canAdminNodes?: boolean;
    /** Id of the node with an in-flight mutation (disables its action buttons). */
    pendingNodeId?: string;
  }>(),
  {
    canOpenTerminal: false,
    canAdminNodes: false,
    pendingNodeId: undefined,
  },
);

const emit = defineEmits<{
  /** Row / name activated — caller opens the node detail page. */
  (e: "open", node: Node): void;
  /** Terminal action button. */
  (e: "terminal", node: Node): void;
  /** Rotate-token action button. */
  (e: "rotate", node: Node): void;
  /** Enable/disable toggle — second arg is the desired `disabled` value. */
  (e: "set-disabled", node: Node, disabled: boolean): void;
}>();

const { t } = useI18n();

/** Real, derived treatment (drives the dot colour). */
function meta(node: Node) {
  return nodeStatusMeta(node);
}

/** A disabled node is operationally down even if the agent last reported online. */
function isLive(node: Node): boolean {
  return !!node.online && !node.disabled;
}

function statusLabel(node: Node): string {
  if (node.disabled) return t("common.status.disabled");
  return node.online ? t("common.status.online") : t("common.status.offline");
}

function statusVariant(node: Node): ReturnType<typeof meta>["badgeVariant"] {
  if (node.disabled) return "secondary";
  return meta(node).badgeVariant;
}

function archOs(node: Node): string {
  return node.host_facts?.os || node.host_facts?.platform || "—";
}

/** Public IPv4 is the primary column; the rest ride along in the cell tooltip. */
function ipTooltip(node: Node): string {
  const lines = [
    `${t("fleet.nodes.detail.publicIp")}: ${node.public_ip || "—"}`,
    `${t("fleet.nodes.detail.publicIpv6")}: ${node.public_ipv6 || "—"}`,
    `${t("fleet.nodes.detail.internalIp")}: ${node.internal_ip || "—"}`,
    `${t("fleet.nodes.detail.internalIpv6")}: ${node.internal_ipv6 || "—"}`,
  ];
  if (node.wireguard_ip) lines.push(`${t("fleet.nodes.detail.wireguardIp")}: ${node.wireguard_ip}`);
  return lines.join("\n");
}

function onOpen(node: Node): void {
  emit("open", node);
}
</script>

<template>
  <div class="overflow-x-auto rounded-lg border border-border">
    <div class="min-w-[1440px]">
      <!-- Header -->
      <div
        class="grid grid-cols-[minmax(180px,1.6fr)_90px_104px_minmax(120px,1fr)_150px_120px_84px_84px_84px_136px_112px_148px] gap-3 border-b border-border bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground"
      >
        <span>{{ $t('fleet.nodes.table.colName') }}</span>
        <span>{{ $t('fleet.nodes.table.colStatus') }}</span>
        <span>{{ $t('fleet.nodes.table.colRole') }}</span>
        <span>{{ $t('fleet.nodes.table.colTags') }}</span>
        <span>{{ $t('fleet.nodes.table.colPublicIp') }}</span>
        <span>{{ $t('fleet.nodes.table.colArchOs') }}</span>
        <span>{{ $t('fleet.nodes.metric.cpu') }}</span>
        <span>{{ $t('fleet.nodes.metric.memory') }}</span>
        <span>{{ $t('fleet.nodes.metric.disk') }}</span>
        <span>{{ $t('fleet.nodes.table.colNetwork') }}</span>
        <span>{{ $t('fleet.nodes.table.colLastSeen') }}</span>
        <span class="text-right">{{ $t('fleet.nodes.table.colActions') }}</span>
      </div>

      <!-- Rows -->
      <div
        v-for="node in nodes"
        :key="node.id"
        class="grid grid-cols-[minmax(180px,1.6fr)_90px_104px_minmax(120px,1fr)_150px_120px_84px_84px_84px_136px_112px_148px] items-center gap-3 border-b border-border px-3 py-3 text-sm transition-colors last:border-b-0 hover:bg-muted/40 focus-visible:bg-muted/50 focus-visible:outline-none"
        :class="!isLive(node) && 'opacity-60'"
        role="button"
        :tabindex="0"
        :aria-label="node.name || node.id"
        @click="onOpen(node)"
        @keydown.enter.prevent="onOpen(node)"
        @keydown.space.prevent="onOpen(node)"
      >
        <!-- Name + status dot -->
        <div class="flex min-w-0 items-center gap-2">
          <StatusDot :status="meta(node).dotStatus" :pulse="isLive(node)" />
          <div class="min-w-0">
            <p class="truncate font-medium">{{ node.name || node.id }}</p>
            <p class="truncate font-mono text-xs text-muted-foreground tabular">
              {{ node.host_facts?.hostname || shortId(node.id, 16) }}
            </p>
          </div>
        </div>

        <!-- Status -->
        <div>
          <Badge :variant="statusVariant(node)">{{ statusLabel(node) }}</Badge>
        </div>

        <!-- Role -->
        <div class="min-w-0">
          <Badge v-if="node.role" variant="secondary" class="max-w-full truncate">{{ node.role }}</Badge>
          <span v-else class="text-muted-foreground">—</span>
        </div>

        <!-- Tags -->
        <div class="flex min-w-0 flex-wrap gap-1">
          <Badge v-for="tag in node.tags ?? []" :key="tag" variant="outline" class="max-w-full truncate">
            {{ tag }}
          </Badge>
          <span v-if="!(node.tags && node.tags.length)" class="text-muted-foreground">—</span>
        </div>

        <!-- Public IPv4 (other addresses in the tooltip) -->
        <div class="min-w-0" :title="ipTooltip(node)">
          <p class="truncate font-mono text-xs">{{ node.public_ip || '—' }}</p>
        </div>

        <!-- Arch / OS -->
        <div class="min-w-0">
          <p class="truncate">{{ archOs(node) }}</p>
          <p class="truncate text-xs text-muted-foreground">{{ node.host_facts?.arch || '—' }}</p>
        </div>

        <!-- CPU / Memory / Disk mini-bars -->
        <MetricBar tone="cpu" :percent="node.metrics?.cpu_percent ?? 0" />
        <MetricBar tone="memory" :percent="ratio(node.metrics?.memory_used, node.metrics?.memory_total)" />
        <MetricBar tone="disk" :percent="ratio(node.metrics?.disk_used, node.metrics?.disk_total)" />

        <!-- Net rx / tx -->
        <div class="space-y-0.5 text-xs text-muted-foreground tabular">
          <p class="inline-flex items-center gap-1">
            <ArrowDown class="size-3 text-success" aria-hidden="true" />
            {{ formatBytesPerSec(node.metrics?.net_rx_speed) }}
          </p>
          <p class="inline-flex items-center gap-1">
            <ArrowUp class="size-3 text-primary" aria-hidden="true" />
            {{ formatBytesPerSec(node.metrics?.net_tx_speed) }}
          </p>
        </div>

        <!-- Last seen -->
        <span class="text-xs text-muted-foreground tabular">{{ formatRelativeTime(node.last_seen) }}</span>

        <!-- Actions (reuse the same intents NodeCard wires) -->
        <div class="flex items-center justify-end gap-1">
          <Button
            v-if="canOpenTerminal"
            variant="ghost"
            size="icon-sm"
            :disabled="!node.online || node.disabled"
            :title="$t('fleet.nodes.list.openTerminal')"
            :aria-label="$t('fleet.nodes.list.openTerminal')"
            @click.stop="emit('terminal', node)"
          >
            <SquareTerminal class="size-4" aria-hidden="true" />
          </Button>
          <Button
            v-if="canAdminNodes"
            variant="ghost"
            size="icon-sm"
            :disabled="pendingNodeId === node.id"
            :title="$t('fleet.nodes.list.rotateToken')"
            :aria-label="$t('fleet.nodes.list.rotateToken')"
            @click.stop="emit('rotate', node)"
          >
            <KeyRound class="size-4" aria-hidden="true" />
          </Button>
          <Button
            v-if="canAdminNodes"
            variant="ghost"
            size="icon-sm"
            :disabled="pendingNodeId === node.id"
            :title="node.disabled ? $t('common.actions.enable') : $t('common.actions.disable')"
            :aria-label="node.disabled ? $t('common.actions.enable') : $t('common.actions.disable')"
            @click.stop="emit('set-disabled', node, !node.disabled)"
          >
            <Power :class="['size-4', !node.disabled && 'text-destructive']" aria-hidden="true" />
          </Button>
        </div>
      </div>
    </div>
  </div>
</template>

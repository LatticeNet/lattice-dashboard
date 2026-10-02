<script setup lang="ts">
import { type Component } from "vue";
import { RouterLink } from "vue-router";
import { useI18n } from "vue-i18n";
import { BellOff, CalendarCheck2, CalendarClock, Link2, LockKeyhole, RefreshCw, Server, UserRound } from "lucide-vue-next";
import type { ExpiringItem } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";
import { formatAmount, formatTotals, isOverdue, quotaPercent, rowHref, type WeekGroup } from "@/views/fleet/upcomingModel";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * The rows of the expiring list, grouped by week. Home's Upcoming panel and
 * the full Upcoming page render the same component, so a row reads the same
 * in both places: what it is, when, how far away, and what it costs.
 *
 * The whole row opens the object. At 375px a row becomes two lines (title
 * and cost, then subtitle and date) instead of scrolling sideways.
 *
 * Given `renewable`, rows it accepts also carry a "Record renewal" button
 * beside the row (Upcoming, for machines): the job the list exists for, in
 * one step instead of sheet, editor, scroll. Every row then keeps the same
 * trailing column so dates and costs stay aligned.
 */
const props = defineProps<{
  groups: WeekGroup[];
  /** The server's today (UTC midnight, ms): picks MM-DD against a full date. */
  today: number;
  /** Rows that offer "Record renewal"; none when absent (Home). */
  renewable?: (item: ExpiringItem) => boolean;
}>();

const emit = defineEmits<{ renew: [item: ExpiringItem] }>();

const { t } = useI18n();

const KIND_ICON: Record<string, Component> = {
  machine_renewal: Server,
  vpn_user: UserRound,
  share: Link2,
  tls_certificate: LockKeyhole,
};

function kindIcon(kind: string): Component {
  return KIND_ICON[kind] ?? CalendarClock;
}

function kindLabel(kind: string): string {
  return KIND_ICON[kind] ? t(`fleet.upcoming.kinds.${kind}`) : t("fleet.upcoming.kinds.other");
}

function dueDay(item: ExpiringItem): string {
  const iso = item.due_at?.slice(0, 10) ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return "";
  return iso.slice(0, 4) === String(new Date(props.today).getUTCFullYear()) ? iso.slice(5) : iso;
}

function daysText(item: ExpiringItem): string {
  if (item.days === 0) return t("fleet.upcoming.days.today");
  if (item.days < 0) return t("fleet.upcoming.days.overdue", { n: -item.days });
  return t("fleet.upcoming.days.future", { n: item.days });
}

function daysTone(item: ExpiringItem): string {
  if (item.state === "auto") return "text-muted-foreground";
  if (isOverdue(item)) return "font-medium text-destructive";
  if (item.state === "due") return "font-medium text-warning-text";
  return "text-foreground";
}

function groupLabel(group: WeekGroup): string {
  if (group.kind === "overdue") return t("fleet.upcoming.group.overdue");
  if (group.kind === "thisWeek") return t("fleet.upcoming.group.thisWeek");
  if (group.kind === "nextWeek") return t("fleet.upcoming.group.nextWeek");
  const start = group.weekStart ?? "";
  const sameYear = start.slice(0, 4) === String(new Date(props.today).getUTCFullYear());
  return t("fleet.upcoming.group.weekOf", { date: sameYear ? start.slice(5) : start });
}

/**
 * The line under the title. The server sends data only (vendor and region,
 * a user's name, a record name, a host:port), so the words come from here: the kind
 * for anything that is not a machine (a server icon already says machine),
 * and a VPN user's quota.
 */
function details(item: ExpiringItem): string[] {
  const parts: string[] = [];
  if (item.subtitle) parts.push(item.subtitle);
  const percent = quotaPercent(item);
  if (percent !== undefined) {
    parts.push(t("fleet.upcoming.quota", { percent, quota: formatBytes(item.quota_bytes) }));
  }
  return parts;
}

function subtitle(item: ExpiringItem): string {
  return [...(item.kind === "machine_renewal" ? [] : [kindLabel(item.kind)]), ...details(item)].join(" · ");
}

function cost(item: ExpiringItem): string {
  return item.cost_cents > 0 && item.currency ? formatAmount(item.cost_cents, item.currency) : "";
}

/** The row's full sentence for a screen reader, since the columns are read as one link. */
function rowName(item: ExpiringItem): string {
  return [
    kindLabel(item.kind),
    item.title,
    ...details(item),
    item.due_at?.slice(0, 10),
    daysText(item),
    item.state === "auto" ? t("fleet.upcoming.auto") : "",
    item.reminder && !item.reminder.enabled ? t("fleet.upcoming.reminderOff") : "",
    cost(item),
  ]
    .filter(Boolean)
    .join(", ");
}

const ROW =
  "grid grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 px-4 py-2 sm:px-6 sm:grid-cols-[1rem_minmax(0,1fr)_auto_7.5rem] sm:py-1.5";
</script>

<template>
  <div class="divide-y divide-border">
    <section v-for="group in groups" :key="group.key" :aria-label="groupLabel(group)">
      <div class="flex items-baseline justify-between gap-3 bg-muted/30 px-4 py-1.5 font-mono sm:px-6 text-[11px] uppercase tracking-wide text-muted-foreground">
        <span :class="group.kind === 'overdue' ? 'text-destructive' : undefined">{{ groupLabel(group) }}</span>
        <span class="tabular normal-case">
          {{ group.items.length }}<template v-if="group.totals.length"> · {{ formatTotals(group.totals) }}</template>
        </span>
      </div>
      <ul class="divide-y divide-border">
        <li v-for="item in group.items" :key="`${item.kind}:${item.id}`" :class="renewable ? 'flex items-stretch' : undefined">
          <component
            :is="rowHref(item) ? RouterLink : 'div'"
            v-bind="rowHref(item) ? { to: rowHref(item) } : {}"
            :aria-label="rowName(item)"
            :class="cn(ROW, renewable && 'min-w-0 flex-1 pe-2 sm:pe-3', rowHref(item) && 'transition-colors outline-none hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset')"
          >
            <component
              :is="kindIcon(item.kind)"
              class="size-4 self-start text-muted-foreground sm:self-center"
              aria-hidden="true"
            />
            <div class="row-span-2 flex min-w-0 flex-col sm:row-span-1 sm:flex-row sm:items-baseline sm:gap-2">
              <!-- In a narrow column the name keeps its width and the subtitle gives way. -->
              <span class="truncate text-sm font-medium sm:max-w-full sm:shrink-0" :title="item.title">{{ item.title }}</span>
              <span class="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                <span v-if="subtitle(item)" class="truncate" :title="subtitle(item)">{{ subtitle(item) }}</span>
                <!-- Icon only at 375, where the words would squeeze out the vendor. -->
                <span v-if="item.state === 'auto'" class="inline-flex shrink-0 items-center gap-1" :title="$t('fleet.upcoming.auto')">
                  <RefreshCw class="size-3" aria-hidden="true" /><span class="hidden sm:inline">{{ $t('fleet.upcoming.auto') }}</span>
                </span>
                <span
                  v-if="item.reminder && !item.reminder.enabled"
                  class="inline-flex shrink-0"
                  :title="$t('fleet.upcoming.reminderOff')"
                >
                  <BellOff class="size-3" aria-hidden="true" />
                </span>
              </span>
            </div>
            <span class="col-start-3 row-start-2 flex justify-end gap-2 font-mono text-xs tabular sm:col-start-3 sm:row-start-1 sm:gap-3">
              <span class="text-muted-foreground" :title="item.due_at?.slice(0, 10)">{{ dueDay(item) }}</span>
              <span :class="cn('min-w-[9ch] text-right', daysTone(item))">{{ daysText(item) }}</span>
            </span>
            <span class="col-start-3 row-start-1 text-right font-mono text-xs tabular sm:col-start-4">
              {{ cost(item) }}
            </span>
          </component>
          <div v-if="renewable" class="flex w-11 shrink-0 items-center justify-center pe-1 sm:w-12 sm:pe-2">
            <Tooltip v-if="renewable(item)" :delay-duration="300">
              <TooltipTrigger as-child>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  class="text-muted-foreground hover:text-foreground"
                  data-testid="upcoming-record-renewal"
                  :aria-label="t('fleet.renewal.actionFor', { name: item.title })"
                  @click="emit('renew', item)"
                >
                  <CalendarCheck2 aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="left">{{ t('fleet.renewal.action') }}</TooltipContent>
            </Tooltip>
          </div>
        </li>
      </ul>
    </section>
  </div>
</template>

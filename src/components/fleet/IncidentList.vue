<script setup lang="ts">
/**
 * Keepalive incidents as rows (Home's panel and Monitoring's Keepalive
 * layer): what is wrong, for how long, what the operator's phone was told,
 * and the two things an operator does about it.
 *
 *   (!) sing-box down on DMIT-4                      14 min   [Acknowledge] [Snooze v] [Open]
 *       Paged 14:02 · not acknowledged
 *
 * The phone line is the row's signature: it says what the phone currently
 * believes (paged, held by a window or a snooze, recovery sent), composed
 * from the record's own fields (incidentsModel.phoneState). Rows are a list
 * at every width; below 640 px the actions move to their own line so each
 * keeps a 44 px target.
 */
import { computed, nextTick, ref, watch } from "vue";
import { RouterLink, type RouteLocationRaw } from "vue-router";
import { useI18n } from "vue-i18n";
import { AlertTriangle, BellOff, Check, Clock, Info, OctagonAlert, CircleCheck, Undo2 } from "lucide-vue-next";

import type { Incident } from "@/lib/api";
import type { IncidentFocusRequest } from "@/composables/useIncidentActions";
import { formatAge } from "@/lib/format";
import { cn } from "@/lib/utils";
import { incidentSeverity } from "@/lib/incidentSeverity";
import { undoSlot } from "@/lib/actionHold";
import {
  SNOOZE_MINUTES,
  incidentActions,
  incidentAge,
  incidentTone,
  isSnoozed,
  knownKind,
  phoneState,
  type IncidentTone,
} from "@/views/fleet/incidentsModel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const props = withDefaults(
  defineProps<{
    incidents: Incident[];
    now: number;
    canAdmin: boolean;
    /** Ids with an action in flight. */
    busy?: ReadonlySet<string>;
    /** Node names by id, for subjects the server named by id. */
    nodeNames?: ReadonlyMap<string, string>;
    /** Monitor names by id, so a failing monitor's claim is worded here rather than in the server's English. */
    monitorNames?: ReadonlyMap<string, string>;
    /** A row control to focus once the row has re-rendered (useIncidentActions). */
    focusRequest?: IncidentFocusRequest | null;
    /** Acknowledged rows that offer Undo in Acknowledge's place, and those whose Undo landed (actionHold.undoSlot). */
    undoable?: ReadonlySet<string>;
    undone?: ReadonlySet<string>;
  }>(),
  {
    busy: () => new Set<string>(),
    nodeNames: () => new Map<string, string>(),
    monitorNames: () => new Map<string, string>(),
    focusRequest: null,
    undoable: () => new Set<string>(),
    undone: () => new Set<string>(),
  },
);

const emit = defineEmits<{
  /** `order` is the row ids as shown, which the caller holds while the action settles; `name` is the row's claim, for the toast. */
  ack: [incident: Incident, order: string[], name: string];
  undo: [incident: Incident, name: string];
  snooze: [incident: Incident, minutes: number, order: string[], name: string];
  focused: [];
}>();

const list = ref<HTMLElement | null>(null);

function order(): string[] {
  return props.incidents.map((i) => i.id);
}

function onAck(incident: Incident, name: string): void {
  // The button stays focusable while busy (aria-disabled, not disabled): a
  // disabled button drops focus to the page.
  if (props.busy.has(incident.id)) return;
  emit("ack", incident, order(), name);
}

function onUndo(incident: Incident, name: string): void {
  if (props.busy.has(incident.id)) return;
  emit("undo", incident, name);
}

// Keep focus in the list when an update takes it away. Two updates do:
// releasing a held order moves the focused row's element, which blurs it,
// and a row leaving the list (its hold ended under a filter it no longer
// matches, or a read dropped it) takes its focus with it. The moved
// element is focused again; a row that left hands focus to the row that
// takes its place, or the one above at the end. The row itself takes
// focus, not its Acknowledge: focus that moved on its own must not leave a
// stray Enter acknowledging an incident nobody chose. Only focus this
// update lost is restored, so a click elsewhere is never undone.
watch(
  () => props.incidents,
  async () => {
    const active = typeof document === "undefined" ? null : document.activeElement;
    if (!(active instanceof HTMLElement) || !list.value?.contains(active)) return;
    const row = active.closest<HTMLElement>("[data-incident-row]");
    const index = row ? [...list.value.children].indexOf(row) : -1;
    await nextTick();
    if (document.activeElement && document.activeElement !== document.body) return;
    if (active.isConnected) {
      active.focus();
      return;
    }
    const rows = list.value?.querySelectorAll<HTMLElement>("[data-incident-row]") ?? [];
    rows[Math.min(Math.max(index, 0), rows.length - 1)]?.focus();
  },
  { flush: "pre" },
);

// Fulfil a focus request once its target exists: Snooze after an
// acknowledgement (Acknowledge is gone), Acknowledge after a failure or Undo.
// The caller's list is read again after the action, so a target that is
// missing now (Acknowledge before the read that reopens the row) is waited
// for, up to FOCUS_WAIT_MS; after that the row's first control stands in.
// The rows are recomputed at least every second (they age), so the watch
// runs again within that time.
const FOCUS_WAIT_MS = 3000;
let requestedAt = 0;
watch(
  () => props.focusRequest,
  (request) => {
    requestedAt = request ? Date.now() : 0;
  },
  { flush: "sync" },
);
watch(
  () => [props.focusRequest, props.incidents] as const,
  async ([request]) => {
    if (!request) return;
    await nextTick();
    const exact = list.value?.querySelector<HTMLElement>(`[data-incident-${request.target}="${CSS.escape(request.id)}"]`);
    if (!exact && Date.now() - requestedAt < FOCUS_WAIT_MS) return;
    const target = exact ?? list.value?.querySelector<HTMLElement>(`[data-incident-row="${CSS.escape(request.id)}"] button`);
    if (!target) return;
    target.focus();
    emit("focused");
  },
  { flush: "post" },
);

const { t, locale } = useI18n();

/**
 * The glyph says how bad (octagon critical, triangle warning) and the
 * colour says whether anyone needs to act (incidentTone): an acknowledged,
 * snoozed or window-held critical keeps its octagon and goes grey. Pending
 * is not an incident yet, and resolved is history.
 */
function iconFor(incident: Incident): unknown {
  if (incident.state === "resolved") return CircleCheck;
  if (incident.state === "pending") return Info;
  return incidentSeverity(incident) === "critical" ? OctagonAlert : AlertTriangle;
}
const ICON_TONE: Record<IncidentTone, string> = {
  danger: "text-destructive",
  warning: "text-warning-text",
  info: "text-muted-foreground",
  muted: "text-muted-foreground",
};

function age(ms: number | undefined): string {
  return ms === undefined ? "" : formatAge(ms, locale.value);
}

/** "14:02" today, "Oct 2 14:02" another day, in the browser's zone. */
function clock(ms: number | undefined): string {
  if (!ms) return "";
  const d = new Date(ms);
  const today = new Date(props.now);
  const sameDay = d.toDateString() === today.toDateString();
  return d.toLocaleString(locale.value, sameDay ? { hour: "2-digit", minute: "2-digit" } : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function nodeName(incident: Incident): string | undefined {
  return incident.node_name || (incident.node_id ? props.nodeNames.get(incident.node_id) : undefined) || undefined;
}

function subject(incident: Incident): string {
  return incident.subject || nodeName(incident) || incident.node_id || incident.monitor_id || "";
}

/**
 * The row's claim. A node incident's subject is the node's name; a failing
 * monitor's subject is the server's English "<monitor> on <node>", so it is
 * composed here from the two names when both are known (a certificate watch
 * has no node and keeps the server's subject, which names its target).
 */
function claim(incident: Incident): string {
  const kind = knownKind(incident.kind);
  if (!kind) return incident.title || incident.kind;
  if (kind === "monitor.down") {
    const monitor = incident.monitor_id ? props.monitorNames.get(incident.monitor_id) : undefined;
    const node = nodeName(incident);
    if (monitor && node) return t("fleet.keepalive.claim.monitor_down", { monitor, node });
    return t("fleet.keepalive.claim.monitor_downAlone", { subject: subject(incident) });
  }
  return t(`fleet.keepalive.claim.${kind.replace(".", "_")}`, { subject: nodeName(incident) || subject(incident) });
}

function phoneLine(incident: Incident): string {
  const state = phoneState(incident, props.now);
  switch (state.key) {
    case "pending":
      return state.opensAt ? t("fleet.keepalive.phone.pendingAt", { age: age(Math.max(0, state.opensAt - props.now)) }) : t("fleet.keepalive.phone.pendingNext");
    case "held":
      if (state.reason === "maintenance") return t("fleet.keepalive.phone.heldMaintenance", { name: state.window });
      if (state.reason === "snoozed") return t("fleet.keepalive.phone.heldSnoozed", { time: clock(state.until) });
      return t("fleet.keepalive.phone.heldFlapping");
    case "released":
      return t(state.by === "window" ? "fleet.keepalive.phone.windowEnded" : "fleet.keepalive.phone.holdLifted");
    case "owed":
      return t("fleet.keepalive.phone.owed");
    case "paged": {
      const parts = [t("fleet.keepalive.phone.paged", { time: clock(state.at) })];
      if (state.escalatedAt) parts.push(t("fleet.keepalive.phone.escalated", { time: clock(state.escalatedAt) }));
      else if (state.unacknowledged) parts.push(t("fleet.keepalive.phone.unacknowledged"));
      return parts.join(" · ");
    }
    case "recoveryOwed":
      return t("fleet.keepalive.phone.recoveryOwed");
    case "recoveryHeld":
      return t("fleet.keepalive.phone.recoveryHeld");
    case "recovered":
      return t("fleet.keepalive.phone.recovered", { time: clock(state.at) });
    case "silent":
      return t("fleet.keepalive.phone.silent");
  }
  return "";
}

function ageLine(incident: Incident): string {
  const ms = incidentAge(incident, props.now);
  if (ms === undefined) return "";
  return incident.state === "resolved" ? t("fleet.keepalive.row.lasted", { age: age(ms) }) : age(ms);
}

function openTarget(incident: Incident): RouteLocationRaw | undefined {
  if (incident.kind === "monitor.down" && incident.monitor_id) return { name: "monitoring", query: { view: "monitors", open: incident.monitor_id } };
  if (incident.node_id) return { name: "node-detail", params: { id: incident.node_id } };
  return undefined;
}

const rows = computed(() =>
  props.incidents.map((incident) => {
    const tone = incidentTone(incident, props.now);
    const snoozed = isSnoozed(incident, props.now);
    const phone = phoneState(incident, props.now);
    const badges: { key: string; text: string; variant: "secondary" | "outline" | "warning" }[] = [];
    if (incident.state === "acknowledged") badges.push({ key: "ack", text: t("fleet.keepalive.badge.acknowledged", { who: incident.acked_by || "?", time: clock(Date.parse(incident.acked_at ?? "")) }), variant: "secondary" });
    if (snoozed) badges.push({ key: "snooze", text: t("fleet.keepalive.badge.snoozed", { time: clock(Date.parse(incident.snoozed_until ?? "")) }), variant: "secondary" });
    // The phone line already names a window that holds the message.
    const heldByWindow = phone.key === "held" && phone.reason === "maintenance";
    if (incident.maintenance && !heldByWindow) badges.push({ key: "mw", text: t("fleet.keepalive.badge.maintenance", { name: incident.maintenance }), variant: "secondary" });
    if (incident.flapping) badges.push({ key: "flap", text: t("fleet.keepalive.badge.flapping", { n: incident.flaps ?? 0 }), variant: "warning" });
    if (incident.state === "pending") badges.push({ key: "pending", text: t("fleet.keepalive.badge.pending"), variant: "outline" });
    if (incident.state === "resolved") badges.push({ key: "resolved", text: t("fleet.keepalive.badge.resolved", { time: clock(Date.parse(incident.resolved_at ?? "")) }), variant: "outline" });
    return {
      incident,
      tone,
      icon: iconFor(incident),
      claim: claim(incident),
      severity: t(`fleet.keepalive.severity.${incidentSeverity(incident)}`),
      age: ageLine(incident),
      phone: phoneLine(incident),
      badges,
      actions: incidentActions(incident, props.now, props.canAdmin),
      undo: props.canAdmin ? undoSlot(incident.id, incident.state, { undoable: props.undoable, undone: props.undone }) : null,
      open: openTarget(incident),
      busy: props.busy.has(incident.id),
    };
  }),
);
</script>

<template>
  <ul ref="list" class="divide-y divide-border" data-testid="incident-list">
    <li
      v-for="row in rows"
      :key="row.incident.id"
      :data-incident-row="row.incident.id"
      tabindex="-1"
      class="flex flex-col gap-2 px-3.5 py-2.5 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset sm:flex-row sm:items-start sm:gap-3"
      :data-tone="row.tone"
      :data-state="row.incident.state"
    >
      <div class="flex min-w-0 flex-1 items-start gap-2.5">
        <component :is="row.icon" :class="cn('mt-0.5 size-4 shrink-0', ICON_TONE[row.tone])" aria-hidden="true" />
        <div class="min-w-0 flex-1">
          <p class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm text-foreground">
            <span class="sr-only">{{ $t('fleet.keepalive.severityLead', { severity: row.severity }) }}</span>
            <span class="min-w-0 break-words">{{ row.claim }}</span>
            <span v-if="row.age" class="font-mono text-xs text-muted-foreground tabular">{{ row.age }}</span>
          </p>
          <p class="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
            <span class="break-words">{{ row.phone }}</span>
            <Badge v-for="badge in row.badges" :key="badge.key" :variant="badge.variant" class="max-w-full truncate font-normal">{{ badge.text }}</Badge>
          </p>
        </div>
      </div>
      <!-- Below 640 px the actions take their own line, flush with the row so all three fit at 375. -->
      <div class="flex shrink-0 flex-wrap items-center gap-1.5 sm:ps-0">
        <!-- Just acknowledged: Undo takes Acknowledge's place, where focus and the
             pointer already are. A second press there undoes rather than
             acknowledging another incident, which fails safe. -->
        <span v-if="row.undo" class="inline-flex items-center gap-1.5" :data-incident-undo-group="row.incident.id">
          <span class="inline-flex items-center gap-1 ps-1 text-xs text-muted-foreground">
            <Check class="size-3.5" aria-hidden="true" />
            {{ $t('fleet.keepalive.actions.acked') }}
          </span>
          <Button
            variant="outline"
            size="sm"
            type="button"
            class="pointer-coarse:h-11 aria-disabled:opacity-50"
            :aria-disabled="row.busy || row.undo === 'settling' || undefined"
            :data-incident-undo="row.incident.id"
            :aria-label="$t('fleet.keepalive.actions.undoLabel', { name: row.claim })"
            @click="onUndo(row.incident, row.claim)"
          >
            <Undo2 aria-hidden="true" />
            {{ $t('fleet.keepalive.toast.undo') }}
          </Button>
        </span>
        <Button
          v-else-if="row.actions.ack"
          variant="outline"
          size="sm"
          type="button"
          class="pointer-coarse:h-11 aria-disabled:opacity-50"
          :aria-disabled="row.busy || undefined"
          :data-incident-ack="row.incident.id"
          :aria-label="$t('fleet.keepalive.actions.ackLabel', { name: row.claim })"
          @click="onAck(row.incident, row.claim)"
        >
          <Check aria-hidden="true" />
          {{ $t('fleet.keepalive.actions.ack') }}
        </Button>
        <DropdownMenu v-if="row.actions.snooze">
          <DropdownMenuTrigger as-child>
            <Button
              variant="outline"
              size="sm"
              type="button"
              class="pointer-coarse:h-11"
              :disabled="row.busy"
              :data-incident-snooze="row.incident.id"
              :aria-label="$t('fleet.keepalive.actions.snoozeLabel', { name: row.claim })"
            >
              <BellOff aria-hidden="true" />
              {{ $t('fleet.keepalive.actions.snooze') }}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem v-for="minutes in SNOOZE_MINUTES" :key="minutes" class="pointer-coarse:min-h-11" @select="emit('snooze', row.incident, minutes, order(), row.claim)">
              <Clock aria-hidden="true" />
              {{ $t(`fleet.keepalive.snooze.m${minutes}`) }}
            </DropdownMenuItem>
            <template v-if="row.actions.unsnooze">
              <DropdownMenuSeparator />
              <DropdownMenuItem class="pointer-coarse:min-h-11" @select="emit('snooze', row.incident, 0, order(), row.claim)">
                {{ $t('fleet.keepalive.snooze.end') }}
              </DropdownMenuItem>
            </template>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button v-if="row.open" variant="ghost" size="sm" as-child class="pointer-coarse:h-11">
          <RouterLink :to="row.open">{{ $t('fleet.keepalive.actions.open') }}</RouterLink>
        </Button>
      </div>
    </li>
  </ul>
</template>

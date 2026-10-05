<script setup lang="ts">
/**
 * A node's collector readiness in words (design 26, section 4.2), shared by
 * the Collection table and the Overview node table so the two never describe
 * the same node differently.
 *
 * Words, not a dot: "ready, debug", "not ready: no Clash API", "waiting for
 * the agent", "agent too old to report", "last heard 3 min ago". A node that
 * is switched on but not ready is in --destructive, an answer the console
 * cannot vouch for (too old, gone quiet) in --warning-text, and nothing else
 * is coloured. Compact (Overview) keeps to one line, with the detail in
 * the title, and links the reason to Collection; the full cell (Collection)
 * shows the detail as a line of its own (keyboard and touch have no hover),
 * the remedy for a missing Clash API, a capture that wants the node, and the
 * connections the line budget refused to observe. Its first line sits in a
 * fixed 32 px band so the row's other controls line up with it and do not
 * move when lines below it come and go.
 */
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { RouteLocationRaw } from "vue-router";

import { formatDateTime, formatRelativeTime } from "@/lib/format";

import { COLLECTOR_STATUS_MIN_AGENT, type Readiness } from "./evidenceModel";

const props = defineProps<{
  readiness: Readiness;
  /** Collection is wanted on the node (records on, or a capture covers it). */
  wants: boolean;
  /** One line, for the Overview. */
  compact?: boolean;
  /** Where a not-ready reason links (Overview: Collection for this node). */
  to?: RouteLocationRaw;
  /** Connections the agent's line budget refused to observe (full cell only). */
  shed?: { count: number; since: string; budget?: number };
  /** Records are off and a running capture is what wants the collector (full cell only). */
  byCapture?: boolean;
}>();

const { t, locale } = useI18n();

const count = (n: number) => new Intl.NumberFormat(locale.value).format(n);

function stateWords(state: string, known: boolean): string {
  return known ? t(`platform.evidence.readiness.state.${state}`) : t("platform.evidence.readiness.unknownState");
}

/** The words for a state the stale wrapper remembers, for its title. */
function lastWords(last: Readiness): string {
  switch (last.kind) {
    case "ready":
      return t("platform.evidence.readiness.readyLevel", { level: last.level });
    case "not_ready":
      return stateWords(last.state, last.known);
    case "off":
      return t("platform.evidence.readiness.state.off");
    default:
      return t("platform.evidence.readiness.waiting");
  }
}

type Tone = "destructive" | "warning" | "muted" | "plain";

interface Cell {
  text: string;
  tone: Tone;
  title?: string;
  /** Mono suffix (the level a ready stream delivers). */
  level?: string;
  /** The why, as its own line in the full cell (the title in the compact one). */
  note?: string;
  /** The not-ready reason links to Collection in the compact cell. */
  link?: boolean;
  /**
   * The remedy under the reason: `command` (run sb api on) for an agent that
   * looked and found no Clash API; `upgrade` for an agent the server judged
   * too old to look, which `sb api on` alone does not fix.
   */
  remedy?: "command" | "upgrade";
}

const cell = computed<Cell>(() => {
  const r = props.readiness;
  switch (r.kind) {
    case "off":
      // Collection's Enabled box already says off; the cell stays empty there.
      return { text: props.compact ? t("platform.evidence.readiness.state.off") : "", tone: "muted" };
    case "ready":
      return {
        text: props.compact ? t("platform.evidence.readiness.recording") : t("platform.evidence.readiness.ready"),
        tone: "plain",
        level: r.level,
      };
    case "waiting":
      // No report at all. A new agent sends one within a beat, but one whose
      // version the server cannot read (a dev build) never does, so the
      // words promise nothing.
      return {
        text: t("platform.evidence.readiness.noReport"),
        tone: "muted",
        title: t("platform.evidence.readiness.noReportHint", { version: COLLECTOR_STATUS_MIN_AGENT }),
      };
    case "pending":
      return { text: t("platform.evidence.readiness.waiting"), tone: "muted", title: t("platform.evidence.readiness.pendingHint") };
    case "stale":
      return {
        note: t("platform.evidence.readiness.staleNote", { state: lastWords(r.last) }),
        text: r.heardAt
          ? t("platform.evidence.readiness.lastHeard", { rel: formatRelativeTime(r.heardAt) })
          : t("platform.evidence.readiness.notHeard"),
        tone: props.wants ? "warning" : "muted",
        title: t("platform.evidence.readiness.staleHint", {
          state: lastWords(r.last),
          at: r.heardAt ? formatDateTime(r.heardAt) : t("platform.evidence.readiness.never"),
        }),
        link: props.wants,
      };
    case "not_ready": {
      // The agent saw the policy and still collects nothing.
      if (r.state === "off") {
        return {
          text: t("platform.evidence.readiness.agentOff"),
          note: t("platform.evidence.readiness.agentOffNote"),
          tone: props.wants ? "warning" : "muted",
          title: t("platform.evidence.readiness.agentOffHint"),
          link: props.wants,
        };
      }
      if (r.state === "agent_too_old") {
        return {
          text: t("platform.evidence.readiness.state.agent_too_old"),
          note: t("platform.evidence.readiness.tooOldNote", { version: COLLECTOR_STATUS_MIN_AGENT }),
          tone: props.wants ? "warning" : "muted",
          title: t("platform.evidence.readiness.tooOldHint", { version: COLLECTOR_STATUS_MIN_AGENT }),
        };
      }
      const words = stateWords(r.state, r.known);
      const titles: string[] = [];
      if (!r.known) titles.push(t("platform.evidence.readiness.unknownStateHint", { state: r.state }));
      if (r.detail) titles.push(r.detail);
      if (r.inferred && r.state === "no_clash_api") {
        titles.push(t("platform.evidence.readiness.inferredNoApi", { version: COLLECTOR_STATUS_MIN_AGENT }));
      } else if (r.inferred) {
        titles.push(t("platform.evidence.readiness.inferred"));
      }
      return {
        // Off nodes keep the fact (useful before switching on) without the alarm.
        text: props.wants ? t("platform.evidence.readiness.notReady", { reason: words }) : words,
        tone: props.wants ? "destructive" : "muted",
        title: titles.join("\n") || undefined,
        note: r.known ? r.detail : t("platform.evidence.readiness.unknownNote", { state: r.state }),
        link: props.wants,
        remedy: r.state === "no_clash_api" ? (r.inferred ? "upgrade" : "command") : undefined,
      };
    }
  }
  return { text: "", tone: "muted" };
});

const toneClass: Record<Tone, string> = {
  destructive: "text-destructive",
  warning: "text-warning-text",
  muted: "text-muted-foreground",
  plain: "",
};
</script>

<template>
  <span v-if="cell.text" class="inline-flex min-w-0 flex-col gap-0.5" :class="!compact && 'max-w-64'">
    <span
      class="text-sm"
      :class="[toneClass[cell.tone], !compact && 'flex min-h-8 items-center']"
      :title="cell.title"
      data-testid="readiness"
    >
      <span>
        <RouterLink
          v-if="compact && cell.link && to"
          :to="to"
          class="rounded-sm underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        >{{ cell.text }}</RouterLink>
        <template v-else>{{ cell.text }}</template>
        <template v-if="cell.level">
          {{ ' ' }}<span class="font-mono text-xs text-muted-foreground">{{ cell.level }}</span>
        </template>
      </span>
    </span>
    <span v-if="!compact && cell.note" class="text-xs break-words whitespace-normal text-muted-foreground" data-testid="readiness-note">
      {{ cell.note }}
    </span>
    <span v-if="!compact && byCapture && wants" class="text-xs whitespace-normal text-muted-foreground">
      {{ $t('platform.evidence.readiness.byCapture') }}
    </span>
    <span v-if="!compact && cell.remedy && wants" class="text-xs whitespace-normal text-muted-foreground">
      <i18n-t
        :keypath="cell.remedy === 'upgrade' ? 'platform.evidence.readiness.remedyUpgrade' : 'platform.evidence.readiness.remedyNoApi'"
        tag="span"
        scope="global"
      >
        <template #command><code class="font-mono text-foreground">sb api on</code></template>
        <template #version><span class="font-mono">{{ COLLECTOR_STATUS_MIN_AGENT }}</span></template>
      </i18n-t>
    </span>
    <span v-if="!compact && shed" class="text-xs whitespace-normal text-warning-text" data-testid="readiness-shed">
      {{ shed.budget
        ? $t('platform.evidence.readiness.shed', { count: count(shed.count), since: formatDateTime(shed.since), budget: count(shed.budget) }, shed.count)
        : $t('platform.evidence.readiness.shedNoBudget', { count: count(shed.count), since: formatDateTime(shed.since) }, shed.count) }}
    </span>
  </span>
</template>

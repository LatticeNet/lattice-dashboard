<script setup lang="ts">
/**
 * One node's download order (design 31 D4) as numbered chips, first source
 * first: "1 mirror r2, 2 control plane, 3 upstream". The labels are the
 * server's (AgentMirrorOrder); this only names them.
 *
 * A mirror chip carries the accent: mirrors are what the registry adds, and
 * the control plane and upstream are the order every node has without one.
 * A mirror the nodes' last downloads caught sending chunks that failed the
 * manifest is drawn in --destructive with the warning icon instead, and says
 * so to a screen reader, so a failing source in a node's order is never
 * mistaken for a healthy one. The number is part of the chip and of its
 * accessible name, so the order reads the same by ear as by eye.
 */
import { AlertTriangle } from "lucide-vue-next";
import { useI18n } from "vue-i18n";

import { cn } from "@/lib/utils";

import { parseSourceLabel, type SourceLabel } from "./agentMirrorsModel";

const props = defineProps<{
  sources: readonly string[];
  /** Registry names by mirror id, for the chip's title. */
  mirrorNames?: ReadonlyMap<string, string>;
  /** Mirror ids whose fetches wrote chunks that failed the manifest. */
  failing?: ReadonlySet<string>;
  label?: string;
}>();

const { t } = useI18n();

function text(source: SourceLabel): string {
  switch (source.kind) {
    case "mirror":
      return t("platform.agentUpdatesPage.mirrors.source.mirror", { id: source.mirror ?? "" });
    case "controlPlane":
      return t("platform.agentUpdatesPage.mirrors.source.controlPlane");
    case "upstream":
      return t("platform.agentUpdatesPage.mirrors.source.upstream");
    default:
      return source.raw;
  }
}

function failingSource(source: SourceLabel): boolean {
  return source.kind === "mirror" && !!source.mirror && !!props.failing?.has(source.mirror);
}

function title(source: SourceLabel): string | undefined {
  if (source.kind !== "mirror" || !source.mirror) return undefined;
  const name = props.mirrorNames?.get(source.mirror);
  if (failingSource(source)) return [name, t("platform.agentUpdatesPage.mirrors.source.failing")].filter(Boolean).join(": ");
  return name || undefined;
}
</script>

<template>
  <ol class="flex min-w-0 flex-wrap items-center gap-1" :aria-label="label ?? $t('platform.agentUpdatesPage.mirrors.orderLabel')" data-testid="source-order">
    <li
      v-for="(source, index) in sources.map(parseSourceLabel)"
      :key="`${index}:${source.raw}`"
      :title="title(source)"
      :class="cn(
        'inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] leading-4',
        failingSource(source)
          ? 'border-destructive/50 bg-destructive/10 text-destructive'
          : source.kind === 'mirror'
            ? 'border-primary/40 bg-primary/10 text-foreground'
            : 'border-border text-muted-foreground',
      )"
      :data-failing="failingSource(source) || undefined"
    >
      <span :class="cn('font-mono tabular-nums', failingSource(source) ? 'text-destructive' : 'text-muted-foreground')">{{ index + 1 }}</span>
      <AlertTriangle v-if="failingSource(source)" class="size-3 shrink-0" aria-hidden="true" />
      <span class="min-w-0 break-all font-mono">{{ text(source) }}</span>
      <span v-if="failingSource(source)" class="sr-only">({{ $t('platform.agentUpdatesPage.mirrors.source.failing') }})</span>
    </li>
    <li v-if="!sources.length" class="text-xs text-muted-foreground">{{ $t('platform.agentUpdatesPage.mirrors.source.none') }}</li>
  </ol>
</template>

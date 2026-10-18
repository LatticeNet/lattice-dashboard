<script setup lang="ts">
/**
 * One node's download order (design 31 D4) as numbered chips, first source
 * first: "1 mirror r2, 2 control plane, 3 upstream". The labels are the
 * server's (AgentMirrorOrder); this only names them.
 *
 * A mirror chip carries the accent, the only colour here: mirrors are what
 * the registry adds, and the control plane and upstream are the order every
 * node has without one. The number is part of the chip and of its accessible
 * name, so the order reads the same by ear as by eye.
 */
import { useI18n } from "vue-i18n";

import { cn } from "@/lib/utils";

import { parseSourceLabel, type SourceLabel } from "./agentMirrorsModel";

const props = defineProps<{
  sources: readonly string[];
  /** Registry names by mirror id, for the chip's title. */
  mirrorNames?: ReadonlyMap<string, string>;
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

function title(source: SourceLabel): string | undefined {
  if (source.kind !== "mirror" || !source.mirror) return undefined;
  return props.mirrorNames?.get(source.mirror) || undefined;
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
        source.kind === 'mirror' ? 'border-primary/40 bg-primary/10 text-foreground' : 'border-border text-muted-foreground',
      )"
    >
      <span class="font-mono tabular-nums text-muted-foreground">{{ index + 1 }}</span>
      <span class="min-w-0 break-all font-mono">{{ text(source) }}</span>
    </li>
    <li v-if="!sources.length" class="text-xs text-muted-foreground">{{ $t('platform.agentUpdatesPage.mirrors.source.none') }}</li>
  </ol>
</template>

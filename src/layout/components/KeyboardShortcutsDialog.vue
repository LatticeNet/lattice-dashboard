<script setup lang="ts">
/**
 * The list of the console's keys, opened with `?` or from the palette. The
 * `g` rows list only the pages this principal can open.
 */
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { NavItem } from "@/router/nav";
import { commandShortcutKey, currentPlatformIsApple } from "../headerModel";
import { shortcutsHelpOpen, useGoTargets } from "../useKeyboardShortcuts";

const { t } = useI18n();
const paletteKey = commandShortcutKey(currentPlatformIsApple());
const goTargets = useGoTargets();

function pageLabel(item: NavItem): string {
  return item.plugin ? item.title : t(`nav.items.${item.name}`);
}

const rows = computed(() => [
  { keys: [t(paletteKey)], label: "shell.keys.palette" },
  { keys: ["/"], label: "shell.keys.search" },
  { keys: ["j", "k", "↓", "↑"], label: "shell.keys.rows" },
  { keys: ["Enter"], label: "shell.keys.open" },
  { keys: ["[", "]"], label: "shell.keys.step" },
  { keys: ["Esc"], label: "shell.keys.close" },
  { keys: ["?"], label: "shell.keys.help" },
]);
</script>

<template>
  <Dialog v-model:open="shortcutsHelpOpen">
    <DialogContent class="max-h-[85vh] w-[calc(100%-2rem)] overflow-y-auto" data-keyboard-help>
      <DialogHeader>
        <DialogTitle>{{ t('shell.keys.title') }}</DialogTitle>
        <DialogDescription>{{ t('shell.keys.description') }}</DialogDescription>
      </DialogHeader>
      <dl class="grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-2.5 text-sm">
        <template v-for="row in rows" :key="row.label">
          <dt class="flex flex-wrap gap-1">
            <kbd
              v-for="key in row.keys"
              :key="key"
              class="inline-flex h-6 min-w-6 items-center justify-center rounded border border-border bg-muted px-1.5 font-mono text-xs text-foreground"
            >{{ key }}</kbd>
          </dt>
          <dd class="text-muted-foreground">{{ t(row.label) }}</dd>
        </template>
      </dl>
      <div v-if="goTargets.length" class="space-y-2">
        <p class="text-xs font-medium uppercase tracking-wider text-muted-foreground">{{ t('shell.keys.go') }}</p>
        <dl class="grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-2 text-sm">
          <template v-for="target in goTargets" :key="target.key">
            <dt class="flex items-center gap-1">
              <kbd class="inline-flex h-6 min-w-6 items-center justify-center rounded border border-border bg-muted px-1.5 font-mono text-xs text-foreground">g</kbd>
              <span class="text-xs text-muted-foreground">{{ t('shell.keys.then') }}</span>
              <kbd class="inline-flex h-6 min-w-6 items-center justify-center rounded border border-border bg-muted px-1.5 font-mono text-xs text-foreground">{{ target.key }}</kbd>
            </dt>
            <dd class="text-muted-foreground">{{ pageLabel(target.item) }}</dd>
          </template>
        </dl>
      </div>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
/**
 * The errors this tab has shown, from the header (lib/toast keeps them).
 * Error toasts show for 15 s; once gone, dismissed or stacked under newer
 * ones, this is where the reason and the request id can be read again.
 * Absent until the first error, so it is a signal when it appears.
 */
import { computed } from "vue";
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from "reka-ui";
import { CircleAlert } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import CopyButton from "@/components/common/CopyButton.vue";
import { clearRecentErrors, recentErrors } from "@/lib/toast";
import { formatDateTime, formatRelativeTime } from "@/lib/format";

const count = computed(() => recentErrors.value.length);
</script>

<template>
  <PopoverRoot v-if="count > 0">
    <PopoverTrigger as-child>
      <Button
        variant="ghost"
        size="icon"
        class="relative text-destructive hover:text-destructive"
        data-testid="recent-errors"
        :aria-label="$t('shell.errors.open', { n: count }, count)"
      >
        <CircleAlert class="size-4" aria-hidden="true" />
        <span
          class="absolute top-1 right-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 font-mono text-[10px] leading-none font-medium text-white tabular"
          aria-hidden="true"
        >{{ count }}</span>
      </Button>
    </PopoverTrigger>
    <PopoverPortal>
      <PopoverContent
        :side-offset="8"
        align="end"
        :collision-padding="16"
        class="z-50 w-[min(26rem,calc(100vw-2rem))] rounded-md border bg-popover text-popover-foreground shadow-lg outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
        data-testid="recent-errors-panel"
      >
        <div class="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
          <p class="text-sm font-medium">{{ $t('shell.errors.title') }}</p>
          <Button variant="ghost" size="sm" type="button" @click="clearRecentErrors">{{ $t('shell.errors.clear') }}</Button>
        </div>
        <ol class="max-h-[min(24rem,60vh)] divide-y divide-border overflow-y-auto">
          <li v-for="entry in recentErrors" :key="entry.id" class="flex items-start gap-2 px-3 py-2.5">
            <div class="min-w-0 flex-1 space-y-1">
              <p class="text-sm break-words select-text">{{ entry.message }}</p>
              <p v-if="entry.detail" class="text-xs whitespace-pre-wrap break-words text-muted-foreground select-text">{{ entry.detail }}</p>
              <p class="font-mono text-xs text-muted-foreground tabular">
                <time :datetime="new Date(entry.at).toISOString()" :title="formatDateTime(entry.at)">{{ formatRelativeTime(entry.at) }}</time>
                <template v-if="entry.count > 1"> · {{ $t('shell.errors.repeated', { n: entry.count }) }}</template>
              </p>
            </div>
            <CopyButton :value="entry.detail ? `${entry.message}\n${entry.detail}` : entry.message" :aria-label="$t('shell.errors.copy')" />
          </li>
        </ol>
        <p class="border-t border-border px-3 py-2 text-xs text-muted-foreground">{{ $t('shell.errors.note') }}</p>
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>

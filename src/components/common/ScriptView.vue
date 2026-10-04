<script setup lang="ts">
/**
 * A script to read: a task's script after step-up, or a plan that is shell.
 *
 * Line numbers in a gutter that stays put while long lines scroll sideways,
 * shell colours from lib/shellTokens, a wrap toggle, and Copy, which copies
 * `text` itself, never what the screen shows. Every token renders as a text
 * node, so nothing in a script is ever parsed as markup; the colours only
 * wrap what is already there, and the lines joined back are the input.
 *
 * A heredoc body (the file a script writes: a unit, a config, a revert
 * script) carries a rule down its left edge, so where the script ends and
 * the file it writes begins is visible at a glance.
 *
 * The gutter takes no part in a selection (`select-none`), so selecting the
 * code by hand copies code only, and an empty line holds a <br> so a hand
 * selection keeps it (an empty cell copies as nothing). A trailing newline
 * ends the last line; it does not number an empty one after it.
 */
import { computed, ref, watch } from "vue";
import { WrapText } from "lucide-vue-next";

import { Button } from "@/components/ui/button";
import CopyButton from "./CopyButton.vue";
import { formatBytes } from "@/lib/format";
import { HIGHLIGHT_LIMIT, scriptLines, type ScriptLanguage } from "@/lib/shellTokens";
import { SHELL_TOKEN_CLASS } from "./shellTokenClass";
import { cn } from "@/lib/utils";

const props = withDefaults(
  defineProps<{
    text: string;
    /** "shell" colours sh and bash; "plain" shows any other text with the same gutter. */
    language?: ScriptLanguage;
    /** Whether long lines start wrapped. The operator can change it. */
    wrap?: boolean;
    /** Show the view's own Copy. Off where the surface already has one for the same text. */
    copy?: boolean;
    /** The tallest the code area grows before it scrolls, as a CSS length. */
    maxHeight?: string;
    /** Accessible name of the scrolling region; defaults to "Script, N lines". */
    label?: string;
  }>(),
  {
    language: "shell",
    wrap: false,
    copy: true,
    maxHeight: "24rem",
    label: undefined,
  },
);

const wrapped = ref(props.wrap);
watch(
  () => props.wrap,
  (value) => {
    wrapped.value = value;
  },
);

const view = computed(() => scriptLines(props.text, props.language));
const rows = computed(() => (props.text.endsWith("\n") ? view.value.lines.slice(0, -1) : view.value.lines));
const lineCount = computed(() => (props.text === "" ? 0 : rows.value.length));
const overLimit = computed(() => props.language === "shell" && !view.value.highlighted);
</script>

<template>
  <div class="min-w-0 overflow-hidden rounded-md border border-border bg-card" data-testid="script-view">
    <div class="flex min-h-9 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border bg-muted/40 py-0.5 ps-3 pe-1">
      <div class="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
        <slot name="meta" />
        <span class="font-mono tabular" data-testid="script-line-count">{{ $t('common.script.lines', { n: lineCount }, lineCount) }}</span>
        <span v-if="overLimit">· {{ $t('common.script.plainOverLimit', { size: formatBytes(HIGHLIGHT_LIMIT) }) }}</span>
      </div>
      <div v-if="lineCount > 0" class="flex shrink-0 items-center gap-0.5">
        <Button
          variant="ghost"
          size="sm"
          type="button"
          :aria-pressed="wrapped"
          :title="$t('common.script.wrapTitle')"
          :class="wrapped && 'bg-accent text-accent-foreground'"
          data-testid="script-wrap"
          @click="wrapped = !wrapped"
        >
          <WrapText aria-hidden="true" />
          {{ $t('common.script.wrap') }}
        </Button>
        <CopyButton v-if="copy" :value="text" />
      </div>
    </div>

    <p v-if="lineCount === 0" class="px-3 py-3 text-xs text-muted-foreground">{{ $t('common.script.empty') }}</p>
    <!-- The region scrolls both ways and takes focus, so a keyboard can
         scroll a long script; its name says what it is and how long. -->
    <div
      v-else
      class="overflow-auto overscroll-contain font-mono text-xs leading-5 outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset"
      :style="{ maxHeight }"
      tabindex="0"
      role="region"
      :aria-label="label ?? $t('common.script.region', { n: lineCount }, lineCount)"
      data-testid="script-code"
    >
      <div
        :class="cn('grid grid-cols-[max-content_minmax(0,1fr)] py-2', wrapped ? 'w-full' : 'w-max min-w-full')"
        :data-wrapped="wrapped ? '' : undefined"
      >
        <template v-for="(line, index) in rows" :key="index">
          <span
            class="sticky start-0 z-[1] select-none bg-card ps-3 pe-3 text-end tabular text-muted-foreground/70"
            aria-hidden="true"
          >{{ index + 1 }}</span>
          <span
            :class="
              cn(
                'ps-3 pe-4 text-foreground',
                wrapped ? 'whitespace-pre-wrap break-words' : 'whitespace-pre',
                line.heredoc &&
                  'bg-[color-mix(in_oklab,var(--success-text)_6%,transparent)] shadow-[inset_2px_0_0_color-mix(in_oklab,var(--success-text)_45%,transparent)]',
              )
            "
            :data-heredoc="line.heredoc ? '' : undefined"
          ><span v-for="(token, t) in line.tokens" :key="t" :class="SHELL_TOKEN_CLASS[token.kind]">{{ token.text }}</span><br v-if="!line.tokens.length" /></span>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Sun, Monitor, Moon, Check, Rows3, Rows4 } from "lucide-vue-next";
import { cn } from "@/lib/utils";
import { useThemeStore } from "@/stores/theme";
import { useUiStore, type Density } from "@/stores/ui";
import { SUPPORTED_LOCALES, setLocale, currentLocale, type LocaleCode } from "@/i18n";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  COLOR_THEME_KEYS,
  PALETTES,
  type ColorThemeName,
} from "@/theme/palettes";
import type { ThemeMode } from "@/stores/theme";

const theme = useThemeStore();
const ui = useUiStore();
const { t } = useI18n();

const MODES: { value: ThemeMode; label: string; icon: any }[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "system", label: "System", icon: Monitor },
  { value: "dark", label: "Dark", icon: Moon },
];

const DENSITIES: { value: Density; icon: any }[] = [
  { value: "comfortable", icon: Rows3 },
  { value: "compact", icon: Rows4 },
];

const swatchKeys = COLOR_THEME_KEYS.filter((k) => k !== "custom");

/**
 * Every colour this menu paints, published once as custom properties on its
 * root. Per-element inline styles do not survive a strict style-src, and this
 * menu carried the same pattern the Appearance page just shed.
 */
const swatchVars = computed<Record<string, string>>(() => {
  const vars: Record<string, string> = { "--swatch-custom": theme.customColor };
  for (const key of swatchKeys) {
    vars[`--swatch-${key}`] = PALETTES[key as Exclude<ColorThemeName, "custom">].swatch;
  }
  return vars;
});

/** Palette names are product vocabulary, so they come from the catalogue. */
function paletteLabel(key: string): string {
  const path = `settings.appearance.palettes.${key}`;
  const translated = t(path);
  return translated === path ? key.charAt(0).toUpperCase() + key.slice(1) : translated;
}

// Language switcher: a two-way computed over the i18n active locale that persists
// the choice via setLocale (localStorage + <html lang>).
const locale = computed<LocaleCode>({
  get: () => currentLocale(),
  set: (code) => setLocale(code),
});
</script>

<template>
  <div class="w-72 space-y-4 p-1" :style="swatchVars">
    <!-- Mode segmented control -->
    <div class="space-y-2">
      <p class="text-xs font-medium text-muted-foreground">{{ $t('appearance.mode') }}</p>
      <div class="grid grid-cols-3 gap-1 rounded-md bg-muted p-1">
        <button
          v-for="m in MODES"
          :key="m.value"
          type="button"
          :class="
            cn(
              'flex items-center justify-center gap-1.5 rounded-sm px-2 py-1.5 text-xs font-medium outline-none transition-colors focus-visible:ring-ring/50 focus-visible:ring-[3px]',
              theme.mode === m.value
                ? 'bg-background text-foreground shadow-xs'
                : 'text-muted-foreground hover:text-foreground',
            )
          "
          @click="theme.setMode(m.value)"
        >
          <component :is="m.icon" class="size-3.5" aria-hidden="true" />
          {{ $t('appearance.' + m.value) }}
        </button>
      </div>
    </div>

    <!-- Color swatches -->
    <div class="space-y-2">
      <p class="text-xs font-medium text-muted-foreground">{{ $t('appearance.brandColor') }}</p>
      <div class="grid grid-cols-5 gap-2">
        <button
          v-for="key in swatchKeys"
          :key="key"
          type="button"
          :title="paletteLabel(key)"
          :aria-label="paletteLabel(key)"
          :class="
            cn(
              'relative flex h-8 items-center justify-center rounded-md border outline-none ring-offset-2 ring-offset-background transition-all focus-visible:ring-ring/50 focus-visible:ring-[3px]',
              'swatch-fill',
              theme.color === key && 'ring-2 ring-ring',
            )
          "
          :data-palette="key"
          @click="theme.setColor(key)"
        >
          <Check
            v-if="theme.color === key"
            class="size-4 text-primary-foreground drop-shadow"
            aria-hidden="true"
          />
        </button>
      </div>
    </div>

    <!-- Custom color -->
    <div class="space-y-2">
      <p class="text-xs font-medium text-muted-foreground">{{ $t('appearance.customColor') }}</p>
      <label
        :class="
          cn(
            'flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2 text-sm transition-colors hover:bg-accent',
            theme.color === 'custom' && 'border-ring ring-2 ring-ring',
          )
        "
        @click="theme.setColor('custom')"
      >
        <span class="swatch-custom size-5 shrink-0 rounded-full border" />
        <span class="flex-1 truncate font-mono text-xs text-muted-foreground">
          {{ theme.customColor }}
        </span>
        <input
          type="color"
          class="size-6 cursor-pointer rounded border-0 bg-transparent p-0"
          :value="theme.customColor"
          @input="theme.setCustomColor(($event.target as HTMLInputElement).value)"
        />
      </label>
    </div>

    <!-- Density segmented control -->
    <div class="space-y-2">
      <p class="text-xs font-medium text-muted-foreground">{{ $t('appearance.density') }}</p>
      <div class="grid grid-cols-2 gap-1 rounded-md bg-muted p-1">
        <button
          v-for="d in DENSITIES"
          :key="d.value"
          type="button"
          :class="
            cn(
              'flex items-center justify-center gap-1.5 rounded-sm px-2 py-1.5 text-xs font-medium outline-none transition-colors focus-visible:ring-ring/50 focus-visible:ring-[3px]',
              ui.density === d.value
                ? 'bg-background text-foreground shadow-xs'
                : 'text-muted-foreground hover:text-foreground',
            )
          "
          @click="ui.setDensity(d.value)"
        >
          <component :is="d.icon" class="size-3.5" aria-hidden="true" />
          {{ $t('appearance.' + d.value) }}
        </button>
      </div>
    </div>

    <!-- Language -->
    <div class="space-y-2">
      <p class="text-xs font-medium text-muted-foreground">{{ $t('appearance.language') }}</p>
      <Select v-model="locale">
        <SelectTrigger class="w-full" :aria-label="$t('shell.header.language')">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem
            v-for="l in SUPPORTED_LOCALES"
            :key="l.code"
            :value="l.code"
          >
            {{ l.label }}
          </SelectItem>
        </SelectContent>
      </Select>
    </div>
  </div>
</template>

<style scoped>
/*
 * Swatch fills read the custom properties published on the menu root, so no
 * element carries its own inline style. The palette values themselves stay in
 * theme/palettes.ts; these rules only route them.
 */
.swatch-fill {
  /* Fallback keeps an unmapped palette visible rather than transparent. */
  background-color: var(--swatch-current, var(--muted));
}
.swatch-custom {
  background-color: var(--swatch-custom);
}
.swatch-fill[data-palette="lattice"] { --swatch-current: var(--swatch-lattice); }
.swatch-fill[data-palette="teal"] { --swatch-current: var(--swatch-teal); }
.swatch-fill[data-palette="blue"] { --swatch-current: var(--swatch-blue); }
.swatch-fill[data-palette="violet"] { --swatch-current: var(--swatch-violet); }
.swatch-fill[data-palette="green"] { --swatch-current: var(--swatch-green); }
.swatch-fill[data-palette="rose"] { --swatch-current: var(--swatch-rose); }
.swatch-fill[data-palette="orange"] { --swatch-current: var(--swatch-orange); }
.swatch-fill[data-palette="yellow"] { --swatch-current: var(--swatch-yellow); }
.swatch-fill[data-palette="red"] { --swatch-current: var(--swatch-red); }
.swatch-fill[data-palette="stone"] { --swatch-current: var(--swatch-stone); }
</style>

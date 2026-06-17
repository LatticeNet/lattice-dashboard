<script setup lang="ts">
import { Sun, Monitor, Moon, Check } from "lucide-vue-next";
import { cn } from "@/lib/utils";
import { useThemeStore } from "@/stores/theme";
import {
  COLOR_THEME_KEYS,
  PALETTES,
  type ColorThemeName,
} from "@/theme/palettes";
import type { ThemeMode } from "@/stores/theme";

const theme = useThemeStore();

const MODES: { value: ThemeMode; label: string; icon: any }[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "system", label: "System", icon: Monitor },
  { value: "dark", label: "Dark", icon: Moon },
];

const swatchKeys = COLOR_THEME_KEYS.filter((k) => k !== "custom");

function swatchColor(key: ColorThemeName): string {
  return key === "custom"
    ? theme.customColor
    : PALETTES[key as Exclude<ColorThemeName, "custom">].swatch;
}

function label(key: string): string {
  return key.charAt(0).toUpperCase() + key.slice(1);
}
</script>

<template>
  <div class="w-72 space-y-4 p-1">
    <!-- Mode segmented control -->
    <div class="space-y-2">
      <p class="text-xs font-medium text-muted-foreground">Mode</p>
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
          {{ m.label }}
        </button>
      </div>
    </div>

    <!-- Color swatches -->
    <div class="space-y-2">
      <p class="text-xs font-medium text-muted-foreground">Accent color</p>
      <div class="grid grid-cols-5 gap-2">
        <button
          v-for="key in swatchKeys"
          :key="key"
          type="button"
          :title="label(key)"
          :aria-label="label(key)"
          :class="
            cn(
              'relative flex h-8 items-center justify-center rounded-md border outline-none ring-offset-2 ring-offset-background transition-all focus-visible:ring-ring/50 focus-visible:ring-[3px]',
              theme.color === key && 'ring-2 ring-ring',
            )
          "
          :style="{ backgroundColor: swatchColor(key) }"
          @click="theme.setColor(key)"
        >
          <Check v-if="theme.color === key" class="size-4 text-white drop-shadow" aria-hidden="true" />
        </button>
      </div>
    </div>

    <!-- Custom color -->
    <div class="space-y-2">
      <p class="text-xs font-medium text-muted-foreground">Custom</p>
      <label
        :class="
          cn(
            'flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2 text-sm transition-colors hover:bg-accent',
            theme.color === 'custom' && 'border-ring ring-2 ring-ring',
          )
        "
        @click="theme.setColor('custom')"
      >
        <span
          class="size-5 shrink-0 rounded-full border"
          :style="{ backgroundColor: theme.customColor }"
        />
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
  </div>
</template>

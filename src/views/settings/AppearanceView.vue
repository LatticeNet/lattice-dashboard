<script setup lang="ts">
import { Check, Languages, Monitor, Moon, Paintbrush, Palette, Sun } from "lucide-vue-next";
import { useI18n } from "vue-i18n";
import { cn } from "@/lib/utils";
import { useThemeStore, type ThemeMode } from "@/stores/theme";
import {
  PALETTE_KEYS,
  PALETTES,
  type ColorThemeName,
} from "@/theme/palettes";
import { SUPPORTED_LOCALES, setLocale, currentLocale } from "@/i18n";

import PageHeader from "@/components/common/PageHeader.vue";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const theme = useThemeStore();

// Use the i18n composable so the view reacts to locale changes.
const { locale } = useI18n();

const MODES: { value: ThemeMode; icon: typeof Sun }[] = [
  { value: "light", icon: Sun },
  { value: "system", icon: Monitor },
  { value: "dark", icon: Moon },
];

// Palette swatch keys, sourced from PALETTE_KEYS-backed PALETTES (custom excluded).
const swatchKeys = Object.keys(PALETTES) as Exclude<ColorThemeName, "custom">[];

function label(key: string): string {
  return key.charAt(0).toUpperCase() + key.slice(1);
}

const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function onHexInput(value: string) {
  const next = value.trim();
  theme.setColor("custom");
  if (HEX_RE.test(next)) theme.setCustomColor(next);
}

function onColorPicker(event: Event) {
  const value = (event.target as HTMLInputElement).value;
  theme.setColor("custom");
  theme.setCustomColor(value);
}

// PALETTE_KEYS is referenced so the view stays aligned with the variables a
// palette controls; surfaced as a small caption in the brand-color section.
const controlledVarCount = PALETTE_KEYS.length;

/** True when `code` is the active console locale (reactive via `locale`). */
function isActiveLocale(code: string): boolean {
  void locale.value;
  return currentLocale() === code;
}

/** Persist and apply the chosen console locale. */
function changeLocale(code: string): void {
  setLocale(code as (typeof SUPPORTED_LOCALES)[number]["code"]);
}
</script>

<template>
  <div class="p-6 space-y-6">
    <PageHeader
      :title="$t('appearance.title')"
      :description="$t('appearance.description')"
    >
      <template #actions>
        <Badge variant="secondary" class="gap-1.5">
          <Palette class="size-3.5" aria-hidden="true" />
          {{ theme.isDark ? $t('appearance.dark') : $t('appearance.light') }}
        </Badge>
      </template>
    </PageHeader>

    <div class="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(320px,420px)]">
      <div class="space-y-6">
        <!-- Mode -->
        <Card>
          <CardHeader>
            <CardTitle class="flex items-center gap-2">
              <Sun class="size-4 text-muted-foreground" aria-hidden="true" />
              {{ $t('appearance.mode') }}
            </CardTitle>
            <CardDescription>
              {{ $t('appearance.modeHint') }}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div class="grid grid-cols-3 gap-2 rounded-md bg-muted p-1">
              <button
                v-for="m in MODES"
                :key="m.value"
                type="button"
                :class="
                  cn(
                    'flex flex-col items-center justify-center gap-1 rounded-sm px-2 py-3 text-xs font-medium outline-none transition-colors focus-visible:ring-ring/50 focus-visible:ring-[3px]',
                    theme.mode === m.value
                      ? 'bg-background text-foreground shadow-xs'
                      : 'text-muted-foreground hover:text-foreground',
                  )
                "
                @click="theme.setMode(m.value)"
              >
                <component :is="m.icon" class="size-4" aria-hidden="true" />
                {{ $t('appearance.' + m.value) }}
                <span class="text-[10px] font-normal text-muted-foreground">{{ $t('appearance.' + m.value + 'Hint') }}</span>
              </button>
            </div>
          </CardContent>
        </Card>

        <!-- Brand color -->
        <Card>
          <CardHeader>
            <CardTitle class="flex items-center gap-2">
              <Palette class="size-4 text-muted-foreground" aria-hidden="true" />
              {{ $t('appearance.brandColor') }}
            </CardTitle>
            <CardDescription>
              {{ $t('appearance.brandColorHint') }}
            </CardDescription>
          </CardHeader>
          <CardContent class="space-y-3">
            <div class="grid grid-cols-3 gap-3 sm:grid-cols-5">
              <button
                v-for="key in swatchKeys"
                :key="key"
                type="button"
                :title="label(key)"
                :aria-label="label(key)"
                :class="
                  cn(
                    'group relative flex h-14 flex-col items-center justify-end gap-1 overflow-hidden rounded-lg border border-border outline-none transition-all focus-visible:ring-ring/50 focus-visible:ring-[3px]',
                    theme.color === key && 'ring-2 ring-ring ring-offset-2 ring-offset-background',
                  )
                "
                @click="theme.setColor(key)"
              >
                <span class="absolute inset-x-0 top-0 h-9" :style="{ backgroundColor: PALETTES[key].swatch }" />
                <Check
                  v-if="theme.color === key"
                  class="absolute top-1.5 right-1.5 size-4 text-white drop-shadow"
                  aria-hidden="true"
                />
                <span class="relative z-10 pb-1 text-[10px] font-medium text-foreground">
                  {{ label(key) }}
                </span>
              </button>
            </div>
            <p class="text-xs text-muted-foreground">
              {{ $t('appearance.paletteVarHint', { count: controlledVarCount }) }}
            </p>
          </CardContent>
        </Card>

        <!-- Custom color -->
        <Card>
          <CardHeader>
            <CardTitle class="flex items-center gap-2">
              <Paintbrush class="size-4 text-muted-foreground" aria-hidden="true" />
              {{ $t('appearance.customColor') }}
            </CardTitle>
            <CardDescription>
              {{ $t('appearance.customColorHint') }}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div
              :class="
                cn(
                  'flex flex-col gap-3 rounded-lg border border-border p-4 sm:flex-row sm:items-center',
                  theme.color === 'custom' && 'border-ring ring-2 ring-ring',
                )
              "
            >
              <span
                class="size-10 shrink-0 rounded-md border border-border"
                :style="{ backgroundColor: theme.customColor }"
              />
              <div class="grid flex-1 gap-2">
                <Label for="custom-hex">{{ $t('appearance.hexValue') }}</Label>
                <Input
                  id="custom-hex"
                  :model-value="theme.customColor"
                  class="font-mono"
                  placeholder="#6d5cf5"
                  @update:model-value="(v) => onHexInput(String(v))"
                />
              </div>
              <div class="grid gap-2">
                <Label for="custom-picker">{{ $t('appearance.picker') }}</Label>
                <input
                  id="custom-picker"
                  type="color"
                  class="h-9 w-14 cursor-pointer rounded-md border border-border bg-transparent p-1"
                  :value="theme.customColor"
                  @input="onColorPicker"
                />
              </div>
            </div>
            <p class="mt-3 text-xs text-muted-foreground">
              {{ $t('appearance.customSwitchHint') }}
              <code class="font-mono">custom</code>.
            </p>
          </CardContent>
        </Card>

        <!-- Language -->
        <Card>
          <CardHeader>
            <CardTitle class="flex items-center gap-2">
              <Languages class="size-4 text-muted-foreground" aria-hidden="true" />
              {{ $t('appearance.language') }}
            </CardTitle>
            <CardDescription>
              {{ $t('appearance.languageHint') }}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div class="grid grid-cols-2 gap-2 rounded-md bg-muted p-1 sm:inline-grid sm:auto-cols-fr sm:grid-flow-col">
              <button
                v-for="loc in SUPPORTED_LOCALES"
                :key="loc.code"
                type="button"
                :aria-pressed="isActiveLocale(loc.code)"
                :class="
                  cn(
                    'flex items-center justify-center gap-1.5 rounded-sm px-3 py-1.5 text-xs font-medium outline-none transition-colors focus-visible:ring-ring/50 focus-visible:ring-[3px]',
                    isActiveLocale(loc.code)
                      ? 'bg-background text-foreground shadow-xs'
                      : 'text-muted-foreground hover:text-foreground',
                  )
                "
                @click="changeLocale(loc.code)"
              >
                <Check
                  v-if="isActiveLocale(loc.code)"
                  class="size-3.5"
                  aria-hidden="true"
                />
                {{ loc.label }}
              </button>
            </div>
          </CardContent>
        </Card>
      </div>

      <!-- Live preview -->
      <Card class="self-start">
        <CardHeader>
          <CardTitle class="flex items-center gap-2">
            <Palette class="size-4 text-muted-foreground" aria-hidden="true" />
            {{ $t('appearance.livePreview') }}
          </CardTitle>
          <CardDescription>
            {{ $t('appearance.livePreviewHint') }}
          </CardDescription>
        </CardHeader>
        <CardContent class="space-y-5">
          <div class="space-y-2">
            <p class="text-xs font-medium uppercase text-muted-foreground">{{ $t('appearance.previewButtons') }}</p>
            <div class="flex flex-wrap gap-2">
              <Button>{{ $t('appearance.previewPrimary') }}</Button>
              <Button variant="outline">{{ $t('appearance.previewOutline') }}</Button>
              <Button variant="secondary">{{ $t('appearance.previewSecondary') }}</Button>
            </div>
          </div>

          <div class="space-y-2">
            <p class="text-xs font-medium uppercase text-muted-foreground">{{ $t('appearance.previewBadges') }}</p>
            <div class="flex flex-wrap gap-2">
              <Badge variant="success">{{ $t('common.status.success') }}</Badge>
              <Badge variant="warning">{{ $t('common.status.warning') }}</Badge>
              <Badge variant="info">{{ $t('common.status.info') }}</Badge>
              <Badge variant="destructive">{{ $t('common.status.error') }}</Badge>
            </div>
          </div>

          <div class="space-y-2">
            <p class="text-xs font-medium uppercase text-muted-foreground">{{ $t('appearance.previewCard') }}</p>
            <Card class="bg-primary/5">
              <CardContent class="space-y-3 p-4">
                <div class="flex items-center justify-between">
                  <span class="text-sm font-medium">{{ $t('appearance.previewEdgeNode') }}</span>
                  <Badge variant="success">{{ $t('common.status.online') }}</Badge>
                </div>
                <p class="text-sm text-muted-foreground">
                  {{ $t('appearance.previewCardDescription') }}
                </p>
                <div class="flex items-center gap-2">
                  <span
                    class="size-3 rounded-full"
                    :style="{ backgroundColor: theme.activeSwatch }"
                  />
                  <span class="font-mono text-xs text-muted-foreground">{{ theme.color }}</span>
                  <Button size="sm" class="ml-auto">{{ $t('appearance.previewApply') }}</Button>
                </div>
              </CardContent>
            </Card>
          </div>
        </CardContent>
      </Card>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Check, Monitor, Moon, Paintbrush, Palette, Sun } from "lucide-vue-next";
import { cn } from "@/lib/utils";
import { useThemeStore, type ThemeMode } from "@/stores/theme";
import {
  PALETTE_KEYS,
  PALETTES,
  type ColorThemeName,
} from "@/theme/palettes";

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

const MODES: { value: ThemeMode; label: string; icon: typeof Sun; hint: string }[] = [
  { value: "light", label: "Light", icon: Sun, hint: "Always light surfaces" },
  { value: "system", label: "System", icon: Monitor, hint: "Follow OS preference" },
  { value: "dark", label: "Dark", icon: Moon, hint: "Always dark surfaces" },
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
</script>

<template>
  <div class="p-6 space-y-6">
    <PageHeader
      title="Appearance"
      description="Theme mode and brand color for this console. Stored locally in your browser."
    >
      <template #actions>
        <Badge variant="secondary" class="gap-1.5">
          <Palette class="size-3.5" />
          {{ theme.isDark ? "Dark" : "Light" }}
        </Badge>
      </template>
    </PageHeader>

    <div class="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(320px,420px)]">
      <div class="space-y-6">
        <!-- Mode -->
        <Card>
          <CardHeader>
            <CardTitle class="flex items-center gap-2">
              <Sun class="size-4 text-muted-foreground" />
              Mode
            </CardTitle>
            <CardDescription>
              Choose light, dark, or follow your operating system preference.
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
                <component :is="m.icon" class="size-4" />
                {{ m.label }}
                <span class="text-[10px] font-normal text-muted-foreground">{{ m.hint }}</span>
              </button>
            </div>
          </CardContent>
        </Card>

        <!-- Brand color -->
        <Card>
          <CardHeader>
            <CardTitle class="flex items-center gap-2">
              <Palette class="size-4 text-muted-foreground" />
              Brand color
            </CardTitle>
            <CardDescription>
              The accent applied to primary actions, focus rings, and the sidebar.
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
                />
                <span class="relative z-10 pb-1 text-[10px] font-medium text-foreground">
                  {{ label(key) }}
                </span>
              </button>
            </div>
            <p class="text-xs text-muted-foreground">
              Each palette overrides {{ controlledVarCount }} CSS variables in the primary family.
            </p>
          </CardContent>
        </Card>

        <!-- Custom color -->
        <Card>
          <CardHeader>
            <CardTitle class="flex items-center gap-2">
              <Paintbrush class="size-4 text-muted-foreground" />
              Custom color
            </CardTitle>
            <CardDescription>
              Provide a hex value to derive a custom accent palette.
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
                <Label for="custom-hex">Hex value</Label>
                <Input
                  id="custom-hex"
                  :model-value="theme.customColor"
                  class="font-mono"
                  placeholder="#6d5cf5"
                  @update:model-value="(v) => onHexInput(String(v))"
                />
              </div>
              <div class="grid gap-2">
                <Label for="custom-picker">Picker</Label>
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
              Selecting a hex or using the picker switches the brand color to
              <code class="font-mono">custom</code>.
            </p>
          </CardContent>
        </Card>
      </div>

      <!-- Live preview -->
      <Card class="self-start">
        <CardHeader>
          <CardTitle class="flex items-center gap-2">
            <Palette class="size-4 text-muted-foreground" />
            Live preview
          </CardTitle>
          <CardDescription>
            The current theme applied to common interface elements.
          </CardDescription>
        </CardHeader>
        <CardContent class="space-y-5">
          <div class="space-y-2">
            <p class="text-xs font-medium uppercase text-muted-foreground">Buttons</p>
            <div class="flex flex-wrap gap-2">
              <Button>Primary</Button>
              <Button variant="outline">Outline</Button>
              <Button variant="secondary">Secondary</Button>
            </div>
          </div>

          <div class="space-y-2">
            <p class="text-xs font-medium uppercase text-muted-foreground">Badges</p>
            <div class="flex flex-wrap gap-2">
              <Badge variant="success">success</Badge>
              <Badge variant="warning">warning</Badge>
              <Badge variant="info">info</Badge>
              <Badge variant="destructive">destructive</Badge>
            </div>
          </div>

          <div class="space-y-2">
            <p class="text-xs font-medium uppercase text-muted-foreground">Card</p>
            <Card class="bg-primary/5">
              <CardContent class="space-y-3 p-4">
                <div class="flex items-center justify-between">
                  <span class="text-sm font-medium">Edge node</span>
                  <Badge variant="success">online</Badge>
                </div>
                <p class="text-sm text-muted-foreground">
                  A sample surface using the active accent for emphasis, links, and focus rings.
                </p>
                <div class="flex items-center gap-2">
                  <span
                    class="size-3 rounded-full"
                    :style="{ backgroundColor: theme.activeSwatch }"
                  />
                  <span class="font-mono text-xs text-muted-foreground">{{ theme.color }}</span>
                  <Button size="sm" class="ml-auto">Apply</Button>
                </div>
              </CardContent>
            </Card>
          </div>
        </CardContent>
      </Card>
    </div>
  </div>
</template>

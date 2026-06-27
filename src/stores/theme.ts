import { defineStore } from "pinia";
import { ref, computed, watch } from "vue";
import {
  PALETTES,
  PALETTE_KEYS,
  buildCustomPalette,
  isColorThemeName,
  DEFAULT_COLOR,
  DEFAULT_CUSTOM_COLOR,
  type ColorThemeName,
} from "@/theme/palettes";

export type ThemeMode = "light" | "dark" | "system";

const THEME_KEY = "lattice.theme";
const COLOR_KEY = "lattice.color";
const CUSTOM_KEY = "lattice.color.custom";

function systemPrefersDark(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

export const useThemeStore = defineStore("theme", () => {
  const mode = ref<ThemeMode>(
    // Default to the refined dark identity (teal on deep slate). Users can still
    // pick light/system in Appearance; a saved choice always wins.
    (localStorage.getItem(THEME_KEY) as ThemeMode) || "dark",
  );
  const color = ref<ColorThemeName>(
    (isColorThemeName(localStorage.getItem(COLOR_KEY))
      ? (localStorage.getItem(COLOR_KEY) as ColorThemeName)
      : DEFAULT_COLOR),
  );
  const customColor = ref<string>(
    localStorage.getItem(CUSTOM_KEY) || DEFAULT_CUSTOM_COLOR,
  );

  const isDark = ref<boolean>(
    mode.value === "dark" || (mode.value === "system" && systemPrefersDark()),
  );

  function applyMode() {
    const dark =
      mode.value === "dark" ||
      (mode.value === "system" && systemPrefersDark());
    isDark.value = dark;
    const root = document.documentElement;
    root.classList.toggle("dark", dark);
    root.style.colorScheme = dark ? "dark" : "light";
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", dark ? "#1b1b29" : "#ffffff");
  }

  function applyPalette() {
    const root = document.documentElement;
    PALETTE_KEYS.forEach((k) => root.style.removeProperty(k));
    const palette =
      color.value === "custom"
        ? buildCustomPalette(customColor.value)
        : PALETTES[color.value];
    const variant = isDark.value ? palette.dark : palette.light;
    Object.entries(variant).forEach(([k, v]) => root.style.setProperty(k, v));
  }

  function setMode(next: ThemeMode) {
    mode.value = next;
    localStorage.setItem(THEME_KEY, next);
    applyMode();
    applyPalette();
  }

  function toggleDark() {
    setMode(isDark.value ? "light" : "dark");
  }

  function setColor(next: ColorThemeName) {
    color.value = next;
    localStorage.setItem(COLOR_KEY, next);
    applyPalette();
  }

  function setCustomColor(hex: string) {
    customColor.value = hex;
    localStorage.setItem(CUSTOM_KEY, hex);
    if (color.value === "custom") applyPalette();
  }

  // React to OS theme changes while in "system" mode.
  if (typeof window !== "undefined" && window.matchMedia) {
    window
      .matchMedia("(prefers-color-scheme: dark)")
      .addEventListener("change", () => {
        if (mode.value === "system") {
          applyMode();
          applyPalette();
        }
      });
  }

  watch(isDark, applyPalette);

  function init() {
    applyMode();
    applyPalette();
  }

  const activeSwatch = computed(() =>
    color.value === "custom"
      ? customColor.value
      : PALETTES[color.value].swatch,
  );

  return {
    mode,
    color,
    customColor,
    isDark,
    activeSwatch,
    init,
    setMode,
    toggleDark,
    setColor,
    setCustomColor,
  };
});

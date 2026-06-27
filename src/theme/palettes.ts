// Brand (accent) palettes. Each overrides only the --primary / --ring family
// on top of the slate-indigo neutral surfaces defined in style/app.css.
// "lattice" (indigo) is the default identity; the rest mirror shadcn-vue v3.

export type ColorThemeName =
  | "lattice"
  | "teal"
  | "blue"
  | "violet"
  | "green"
  | "rose"
  | "orange"
  | "yellow"
  | "red"
  | "stone"
  | "custom";

export const DEFAULT_COLOR: ColorThemeName = "teal";
export const DEFAULT_CUSTOM_COLOR = "#6d5cf5";

type Variant = Record<string, string>;

export interface Palette {
  swatch: string;
  light: Variant;
  dark: Variant;
}

// Chart series 2..5 are intent-based accents (cyan / green / amber / red) that
// mirror the static defaults in style/app.css. Emitting them from make() keeps
// them in PALETTE_KEYS so token-driven viz (MetricBar, etc.) re-theme together
// on every palette switch instead of stranding the app.css fallbacks. --chart-1
// stays palette-derived (primary) so the lead series tracks the brand accent.
const CHART_ACCENTS = {
  "--chart-2": "oklch(0.62 0.16 195)",
  "--chart-3": "oklch(0.66 0.18 142)",
  "--chart-4": "oklch(0.74 0.17 60)",
  "--chart-5": "oklch(0.64 0.22 12)",
} as const;

const make = (primary: string, foreground: string, ring: string): Variant => ({
  "--primary": primary,
  "--primary-foreground": foreground,
  "--ring": ring,
  "--sidebar-primary": primary,
  "--sidebar-primary-foreground": foreground,
  "--sidebar-ring": ring,
  "--chart-1": primary,
  ...CHART_ACCENTS,
});

export const PALETTES: Record<Exclude<ColorThemeName, "custom">, Palette> = {
  lattice: {
    swatch: "oklch(0.6 0.2 278)",
    light: make("oklch(0.541 0.205 278.5)", "oklch(0.985 0.005 280)", "oklch(0.541 0.205 278.5)"),
    dark: make("oklch(0.672 0.17 277)", "oklch(0.165 0.014 281)", "oklch(0.55 0.12 278)"),
  },
  teal: {
    swatch: "oklch(0.72 0.13 184)",
    // Light: teal-600 with white text. Dark: bright teal-400 with a near-black
    // foreground so on-accent text stays legible against the deep slate surfaces.
    light: make("oklch(0.63 0.105 185)", "oklch(0.985 0.01 180)", "oklch(0.63 0.105 185)"),
    dark: make("oklch(0.81 0.13 180)", "oklch(0.17 0.012 240)", "oklch(0.7 0.12 182)"),
  },
  blue: {
    swatch: "oklch(0.546 0.245 262.9)",
    light: make("oklch(0.546 0.245 262.9)", "oklch(0.97 0.014 254.6)", "oklch(0.546 0.245 262.9)"),
    dark: make("oklch(0.623 0.214 259.8)", "oklch(0.97 0.014 254.6)", "oklch(0.623 0.214 259.8)"),
  },
  violet: {
    swatch: "oklch(0.541 0.281 293.75)",
    light: make("oklch(0.541 0.281 293.75)", "oklch(0.969 0.016 293.8)", "oklch(0.541 0.281 293.75)"),
    dark: make("oklch(0.606 0.25 292.7)", "oklch(0.969 0.016 293.8)", "oklch(0.606 0.25 292.7)"),
  },
  green: {
    swatch: "oklch(0.6 0.146 152.5)",
    light: make("oklch(0.6 0.146 152.5)", "oklch(0.982 0.018 155.8)", "oklch(0.6 0.146 152.5)"),
    dark: make("oklch(0.696 0.17 162.5)", "oklch(0.18 0.02 156)", "oklch(0.696 0.17 162.5)"),
  },
  rose: {
    swatch: "oklch(0.645 0.246 16.4)",
    light: make("oklch(0.645 0.246 16.4)", "oklch(0.969 0.015 12.4)", "oklch(0.645 0.246 16.4)"),
    dark: make("oklch(0.712 0.194 13.4)", "oklch(0.969 0.015 12.4)", "oklch(0.712 0.194 13.4)"),
  },
  orange: {
    swatch: "oklch(0.705 0.213 47.6)",
    light: make("oklch(0.705 0.213 47.6)", "oklch(0.98 0.016 73.7)", "oklch(0.705 0.213 47.6)"),
    dark: make("oklch(0.769 0.188 70.1)", "oklch(0.18 0.03 60)", "oklch(0.769 0.188 70.1)"),
  },
  yellow: {
    swatch: "oklch(0.795 0.184 86)",
    light: make("oklch(0.795 0.184 86)", "oklch(0.421 0.095 57.7)", "oklch(0.795 0.184 86)"),
    dark: make("oklch(0.852 0.199 91.9)", "oklch(0.421 0.095 57.7)", "oklch(0.852 0.199 91.9)"),
  },
  red: {
    swatch: "oklch(0.637 0.237 25.3)",
    light: make("oklch(0.637 0.237 25.3)", "oklch(0.971 0.013 17.4)", "oklch(0.637 0.237 25.3)"),
    dark: make("oklch(0.704 0.191 22.2)", "oklch(0.971 0.013 17.4)", "oklch(0.704 0.191 22.2)"),
  },
  stone: {
    swatch: "oklch(0.45 0.045 60)",
    light: make("oklch(0.45 0.045 60)", "oklch(0.985 0.008 90)", "oklch(0.7 0.04 55)"),
    dark: make("oklch(0.82 0.06 75)", "oklch(0.24 0.02 55)", "oklch(0.66 0.045 65)"),
  },
};

export const COLOR_THEME_KEYS: ColorThemeName[] = [
  ...(Object.keys(PALETTES) as Exclude<ColorThemeName, "custom">[]),
  "custom",
];

export const isColorThemeName = (v: unknown): v is ColorThemeName =>
  typeof v === "string" && (COLOR_THEME_KEYS as string[]).includes(v);

const pickContrastForeground = (color: string): string => {
  const hex = color.replace(/^#/, "");
  if (hex.length !== 6 && hex.length !== 3) return "#ffffff";
  const norm =
    hex.length === 3
      ? hex.split("").map((c) => c + c).join("")
      : hex;
  const r = parseInt(norm.slice(0, 2), 16);
  const g = parseInt(norm.slice(2, 4), 16);
  const b = parseInt(norm.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance < 0.6 ? "#ffffff" : "#0a0a0a";
};

export const buildCustomPalette = (hex: string): Palette => {
  const fg = pickContrastForeground(hex);
  return { swatch: hex, light: make(hex, fg, hex), dark: make(hex, fg, hex) };
};

/** Every CSS var a palette may set — cleared before applying a new one. */
export const PALETTE_KEYS = Object.keys(make("", "", ""));

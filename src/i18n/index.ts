import { createI18n } from "vue-i18n";

import { setFormatLocale } from "@/lib/format";
import en from "./locales/en";
import zhCN from "./locales/zh-CN";

/** Locales the console ships with. Order = display order in the switcher. */
export const SUPPORTED_LOCALES = [
  { code: "en", label: "English" },
  { code: "zh-CN", label: "简体中文" },
] as const;

export type LocaleCode = (typeof SUPPORTED_LOCALES)[number]["code"];

const STORAGE_KEY = "lattice.locale";

function isLocale(v: unknown): v is LocaleCode {
  return v === "en" || v === "zh-CN";
}

/** localStorage override → browser language → English. */
function detectLocale(): LocaleCode {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isLocale(saved)) return saved;
  } catch {
    /* ignore */
  }
  const nav = (typeof navigator !== "undefined" && navigator.language) || "en";
  return nav.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

/**
 * Last-resort rendering for a key missing from every locale.
 *
 * vue-i18n's default is to render the raw key. Which is how
 * "nav.items.network-subscription-shares" once shipped to the sidebar. A raw
 * dotted key is never acceptable UI copy, so we humanize the final segment
 * and warn (once per key) so the gap is found in development, not production.
 */
const warnedMissing = new Set<string>();

function humanizeKey(key: string): string {
  const last = key.split(".").pop() || key;
  const words = last.split(/[-_]/).filter(Boolean);
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

function onMissing(locale: string, key: string): string {
  if (!warnedMissing.has(key)) {
    warnedMissing.add(key);
    console.warn(`[i18n] missing translation (${locale}): ${key}`);
  }
  return humanizeKey(key);
}

export const i18n = createI18n({
  legacy: false,
  globalInjection: true,
  locale: detectLocale(),
  fallbackLocale: "en",
  missing: onMissing,
  messages: { en, "zh-CN": zhCN },
});

function applyHtmlLang(code: LocaleCode): void {
  if (typeof document !== "undefined") {
    document.documentElement.setAttribute("lang", code === "zh-CN" ? "zh-CN" : "en");
  }
}

/** Switch and persist the active locale. */
export function setLocale(code: LocaleCode): void {
  i18n.global.locale.value = code;
  // Intl-backed formatters follow the console, not the browser: a zh-CN
  // console on an en-US browser used to render "自 6 days ago".
  setFormatLocale(code);
  try {
    localStorage.setItem(STORAGE_KEY, code);
  } catch {
    /* ignore */
  }
  applyHtmlLang(code);
}

export function currentLocale(): LocaleCode {
  return i18n.global.locale.value as LocaleCode;
}

// Reflect the initial locale onto <html lang> for a11y + correct text rendering,
// and hand it to the Intl formatters, which have no access to the catalogue.
applyHtmlLang(currentLocale());
setFormatLocale(currentLocale());

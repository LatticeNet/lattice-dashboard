import { createI18n } from "vue-i18n";
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

export const i18n = createI18n({
  legacy: false,
  globalInjection: true,
  locale: detectLocale(),
  fallbackLocale: "en",
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

// Reflect the initial locale onto <html lang> for a11y + correct text rendering.
applyHtmlLang(currentLocale());

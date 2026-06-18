import { useMediaQuery as vueUseMediaQuery } from "@vueuse/core";
import type { Ref } from "vue";

/**
 * Reactive CSS media-query primitive — lets views flip table<->card on mobile
 * and auto-collapse panels without any inline scripts (CSP-safe). Thin wrapper
 * over VueUse's `useMediaQuery`, which already drives off `matchMedia` with
 * proper `addEventListener`/`removeEventListener` cleanup via `onScopeDispose`
 * and guards `window` for SSR. Returns `false` when `window` is absent.
 *
 * @param query A CSS media query string, e.g. `"(max-width: 767px)"`.
 */
export function useMediaQuery(query: string): Ref<boolean> {
  return vueUseMediaQuery(query);
}

/**
 * True on viewports below Tailwind's `md` breakpoint (< 768px) — the line at
 * which dense tables and side panels should give way to stacked cards.
 */
export function useIsMobile(): Ref<boolean> {
  return useMediaQuery("(max-width: 767px)");
}

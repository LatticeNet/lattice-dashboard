/**
 * The console's keyboard (keyboardShortcutsModel says which keys and when).
 * One window listener, installed by the layout; row keys live in DataTable,
 * which handles them first and marks them handled.
 */
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import { useEventListener } from "@vueuse/core";

import type { NavItem } from "@/router/nav";
import { useConsoleNavigation } from "./useConsoleNavigation";
import { GO_KEYS, GO_TIMEOUT_MS, keyTargetOf, shortcutFor, steppedRowIndex } from "./keyboardShortcutsModel";

/** The list of keys, opened by `?` or from the palette. */
export const shortcutsHelpOpen = ref(false);

const SHEET = '[data-testid="object-sheet"]';

/** Another dialog is up (palette, confirm, a popover), or a menu has the keyboard. */
function overlayOpen(): boolean {
  if (document.querySelector(`[role="dialog"]:not(${SHEET}), [role="alertdialog"]`)) return true;
  return !!document.activeElement?.closest('[role="menu"], [role="menubar"], [role="listbox"]');
}

/** The first visible search field on the page: a QueryBar, a DataTable's, or a page's own. */
function focusSearch(): boolean {
  const fields = document.querySelectorAll<HTMLInputElement>('main [data-page-search], main input[type="search"]');
  const field = [...fields].find((el) => el.offsetParent !== null);
  if (!field) return false;
  field.focus();
  field.select();
  return true;
}

/**
 * Open the row before or after the one the sheet shows, through the row
 * itself, so whatever the page does on a row click (the sheet, ?open=, focus
 * return) happens exactly as for a click. Rows hidden by a collapsed group
 * or another page of the table are not stepped onto.
 */
function stepSheet(direction: -1 | 1): boolean {
  const open = document.querySelector<HTMLElement>('main [data-row-key][aria-current="true"]');
  const list = open?.closest("tbody, ul");
  if (!open || !list) return false;
  const rows = [...list.querySelectorAll<HTMLElement>('[data-row-key][tabindex="0"]')];
  const target = rows[steppedRowIndex(rows.length, rows.indexOf(open), direction)];
  if (!target) return false;
  target.click();
  target.scrollIntoView({ block: "nearest" });
  return true;
}

export function useGoTargets() {
  const { consoleSections } = useConsoleNavigation();
  /** `g` keys whose page this principal can open, in GO_KEYS order. */
  return computed(() => {
    const items = new Map<string, NavItem>();
    for (const section of consoleSections.value) for (const item of section.items) items.set(item.name, item);
    return Object.entries(GO_KEYS)
      .map(([key, name]) => ({ key, item: items.get(name) }))
      .filter((entry): entry is { key: string; item: NavItem } => entry.item !== undefined);
  });
}

export function useKeyboardShortcuts() {
  const router = useRouter();
  const goTargets = useGoTargets();
  let goPendingUntil = 0;

  useEventListener(window, "keydown", (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing) return;
    const sheet = document.querySelector<HTMLElement>(SHEET);
    const goPending = Date.now() < goPendingUntil;
    const action = shortcutFor(event, {
      target: keyTargetOf(document.activeElement),
      sheetOpen: !!sheet,
      sheetModal: !!sheet?.hasAttribute("data-sheet-modal"),
      overlayOpen: overlayOpen(),
      goPending,
    });
    // Any key ends a waiting `g`, whether it named a page or not.
    if (goPending) goPendingUntil = 0;
    if (!action) return;
    switch (action.kind) {
      case "focus-search":
        if (focusSearch()) event.preventDefault();
        return;
      case "step-sheet":
        if (stepSheet(action.direction)) event.preventDefault();
        return;
      case "go-pending":
        goPendingUntil = Date.now() + GO_TIMEOUT_MS;
        return;
      case "go": {
        const target = goTargets.value.find((entry) => entry.item.name === action.page);
        if (!target) return;
        event.preventDefault();
        if (router.currentRoute.value.path !== target.item.path) void router.push(target.item.path);
        return;
      }
      case "help":
        event.preventDefault();
        shortcutsHelpOpen.value = true;
        return;
    }
  });
}

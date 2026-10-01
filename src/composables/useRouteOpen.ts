/**
 * The object a collection has open, in the address (design 23, section 3.5).
 *
 *   const sheet = useRouteOpen();            // ?open=<id>
 *   <DataTable :row-click="(row, el) => sheet.open(row.id, el)" :active-row-id="sheet.openId.value" />
 *   <ObjectSheet :open="!!sheet.openId.value" :return-focus="sheet.returnFocus" @close="sheet.close" />
 *
 * Opening and closing replace the history entry (routeOpenModel says why).
 * Focus goes back to the element that opened the sheet. When that element is
 * gone (a reload, a refresh that re-rendered the rows) it goes to the row
 * carrying the open id (`data-row-key`); when the row is gone too (the object
 * was deleted or filtered out), to the table the row sat in, then to the
 * page's own `fallback` when it gives one (Approvals: the card that took a
 * decided card's place), then to the page's first table, then to the page
 * heading. Escape never drops the operator at the top of the document.
 *
 * Reads and writes go through the page's owned route: while the page is
 * leaving, the router already points at the next page, and that page's
 * `?open=` is neither this sheet's to show nor to clear.
 */
import { computed, type ComputedRef } from "vue";

import { OPEN_PARAM, readOpenId, rowSelector, writeOpenId } from "@/composables/routeOpenModel";
import { useOwnedRoute, type OwnedRoute } from "@/composables/useOwnedRoute";

export interface RouteOpen {
  openId: ComputedRef<string | null>;
  open: (id: string, opener?: HTMLElement | null) => void;
  close: () => void;
  /**
   * The element focus should return to when the sheet closes, or null to let
   * the dialog decide. ObjectSheet calls it from its close-auto-focus hook.
   */
  returnFocus: () => HTMLElement | null;
}

/** Make an element that is not normally focusable take programmatic focus. */
function focusable(el: HTMLElement | null): HTMLElement | null {
  if (el && !el.hasAttribute("tabindex") && el.tabIndex < 0) el.setAttribute("tabindex", "-1");
  return el;
}

export interface RouteOpenOptions {
  /** Where focus goes when the opener, its row and its table are all gone. */
  fallback?: () => HTMLElement | null;
}

export function bindRouteOpen(owned: OwnedRoute, param: string = OPEN_PARAM, options: RouteOpenOptions = {}): RouteOpen {
  const openId = computed(() => readOpenId(owned.query(), param));

  let opener: HTMLElement | null = null;
  /** The table the opener sat in, for when the row itself is gone. */
  let openerTable: HTMLElement | null = null;
  /** The id the sheet showed last, for finding its row again after a reload. */
  let lastId: string | null = null;

  function open(id: string, from?: HTMLElement | null): void {
    opener = from ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    openerTable = opener?.closest<HTMLElement>("table") ?? null;
    lastId = id;
    if (openId.value === id) return;
    owned.replace(writeOpenId(owned.query(), param, id));
  }

  function close(): void {
    lastId = openId.value ?? lastId;
    if (openId.value === null) return;
    owned.replace(writeOpenId(owned.query(), param, null));
  }

  function returnFocus(): HTMLElement | null {
    if (opener?.isConnected) return opener;
    const id = lastId ?? openId.value;
    const row = id ? document.querySelector<HTMLElement>(rowSelector(id)) : null;
    if (row) return row;
    if (openerTable?.isConnected) return focusable(openerTable);
    const chosen = options.fallback?.();
    if (chosen?.isConnected) return focusable(chosen);
    const table = document.querySelector<HTMLElement>("main table");
    if (table) return focusable(table);
    return focusable(document.querySelector<HTMLElement>("main h1, h1"));
  }

  return { openId, open, close, returnFocus };
}

export function useRouteOpen(param: string = OPEN_PARAM): RouteOpen {
  return bindRouteOpen(useOwnedRoute(), param);
}

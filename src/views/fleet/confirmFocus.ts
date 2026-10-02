/**
 * Where focus goes when a confirm closes.
 *
 * A confirm opened from a row menu has no opener left by the time it closes:
 * the menu item that asked for it is gone, so the dialog handed focus to the
 * document and a keyboard operator started again at the top of a 34-row
 * table. The menu's trigger is still in the page while the item runs (reka
 * marks it `data-state="open"`), so the page remembers it and gives it back
 * through ConfirmDialog's `return-focus`. When that trigger is gone too (a
 * refresh re-rendered the row, or the row was deleted), focus goes to the
 * same row's menu, then the row that took its place, then the table.
 */
import { rowSelector } from "@/composables/routeOpenModel";

const MENU = '[data-testid="row-menu"]';

/** The trigger of the row menu that is open right now, if any. */
export function openMenuTrigger(): HTMLElement | null {
  return document.querySelector<HTMLElement>(`${MENU}[data-state="open"]`);
}

function rowKeyOf(el: Element | null | undefined): string | undefined {
  return el instanceof HTMLElement ? el.dataset.rowKey : undefined;
}

function siblingRowKey(row: Element, direction: "next" | "previous"): string | undefined {
  let at = direction === "next" ? row.nextElementSibling : row.previousElementSibling;
  while (at) {
    const key = rowKeyOf(at);
    if (key) return key;
    at = direction === "next" ? at.nextElementSibling : at.previousElementSibling;
  }
  return undefined;
}

function focusableTable(table: HTMLElement | null): HTMLElement | null {
  if (!table?.isConnected) return null;
  if (table.tabIndex < 0 && !table.hasAttribute("tabindex")) table.setAttribute("tabindex", "-1");
  return table;
}

export interface ConfirmReturn {
  /**
   * Call as the confirm opens. Remembers the open row menu's trigger (or the
   * focused control, for a confirm opened from a button), the row it belongs
   * to and that row's neighbours.
   */
  remember(rowKey?: string): void;
  /** Pass as ConfirmDialog's `return-focus`. */
  target(): HTMLElement | null;
}

export function createConfirmReturn(): ConfirmReturn {
  let opener: HTMLElement | null = null;
  let keys: string[] = [];
  let table: HTMLElement | null = null;

  function remember(rowKey?: string): void {
    const active = document.activeElement;
    opener = openMenuTrigger() ?? (active instanceof HTMLElement && active !== document.body ? active : null);
    const row = rowKey
      ? document.querySelector<HTMLElement>(rowSelector(rowKey))
      : (opener?.closest<HTMLElement>("[data-row-key]") ?? null);
    keys = [];
    const own = rowKey ?? rowKeyOf(row);
    if (own) keys.push(own);
    if (row) {
      const next = siblingRowKey(row, "next");
      const previous = siblingRowKey(row, "previous");
      if (next) keys.push(next);
      if (previous) keys.push(previous);
    }
    table = row?.closest<HTMLElement>("table") ?? opener?.closest<HTMLElement>("table") ?? null;
  }

  function target(): HTMLElement | null {
    if (opener?.isConnected) return opener;
    for (const [index, key] of keys.entries()) {
      const row = document.querySelector<HTMLElement>(rowSelector(key));
      if (!row) continue;
      // The same row, re-rendered: its own menu. A neighbour: the row itself.
      if (index === 0) return row.querySelector<HTMLElement>(MENU) ?? row;
      return row;
    }
    return focusableTable(table) ?? focusableTable(document.querySelector<HTMLElement>("main table"));
  }

  return { remember, target };
}

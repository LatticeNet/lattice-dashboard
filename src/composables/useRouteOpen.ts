/**
 * The object a collection has open, in the address (design 23, section 3.5).
 *
 *   const sheet = useRouteOpen();            // ?open=<id>
 *   <DataTable :row-click="(row, el) => sheet.open(row.id, el)" :active-row-id="sheet.openId.value" />
 *   <ObjectSheet :open="!!sheet.openId.value" :return-focus="sheet.returnFocus" @close="sheet.close" />
 *
 * Opening and closing replace the history entry (routeOpenModel says why).
 * Focus goes back to the element that opened the sheet; after a reload,
 * when that element is gone, it goes to the row carrying the open id
 * (`data-row-key`), so Escape never drops the operator at the top of the
 * document.
 */
import { computed, type ComputedRef } from "vue";
import { useRoute, useRouter } from "vue-router";

import { OPEN_PARAM, readOpenId, rowSelector, writeOpenId } from "./routeOpenModel";

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

export function useRouteOpen(param: string = OPEN_PARAM): RouteOpen {
  const route = useRoute();
  const router = useRouter();

  const openId = computed(() => readOpenId(route.query, param));

  let opener: HTMLElement | null = null;
  /** The id the sheet showed last, for finding its row again after a reload. */
  let lastId: string | null = null;

  function open(id: string, from?: HTMLElement | null): void {
    opener = from ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    lastId = id;
    if (openId.value === id) return;
    router.replace({ query: writeOpenId(route.query, param, id) }).catch(() => {});
  }

  function close(): void {
    lastId = openId.value ?? lastId;
    if (openId.value === null) return;
    router.replace({ query: writeOpenId(route.query, param, null) }).catch(() => {});
  }

  function returnFocus(): HTMLElement | null {
    if (opener?.isConnected) return opener;
    const id = lastId ?? openId.value;
    if (!id) return null;
    return document.querySelector<HTMLElement>(rowSelector(id));
  }

  return { openId, open, close, returnFocus };
}

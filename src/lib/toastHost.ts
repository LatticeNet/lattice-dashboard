/**
 * The element the toaster lives in while a modal object sheet is open
 * (toastClearance.ts says why). ObjectSheet registers the empty host it
 * renders inside its content below 768 px while it is open; the toaster
 * teleports into whichever host is on top and returns to the shell when
 * none is left.
 */
import { computed, shallowRef } from "vue";

import { topToastHost, withToastHost, withoutToastHost } from "@/lib/toastClearance";

const hosts = shallowRef<HTMLElement[]>([]);

/** The host the toaster belongs in now, or null for its own place in the shell. */
export const toastHost = computed(() => topToastHost(hosts.value));

/** Offer `el` as the toaster's home; the returned function withdraws it. */
export function registerToastHost(el: HTMLElement): () => void {
  hosts.value = withToastHost(hosts.value, el);
  return () => {
    hosts.value = withoutToastHost(hosts.value, el);
  };
}

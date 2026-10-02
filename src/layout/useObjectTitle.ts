/**
 * The object part of the tab title (headerModel.documentTitle). An object
 * page or an open object sheet names what it shows; AppHeader composes that
 * with the page title. The entry goes away with the component that set it.
 */
import { getCurrentScope, onScopeDispose, readonly, ref, watchEffect } from "vue";
import { ObjectTitleStack } from "./headerModel";

const stack = new ObjectTitleStack();
const current = ref("");

/** The newest object title, or "". */
export const objectTitle = readonly(current);

export function useObjectTitle(title: () => string | null | undefined): void {
  const id = Symbol("object-title");
  watchEffect(() => {
    stack.set(id, title());
    current.value = stack.current;
  });
  if (getCurrentScope()) {
    onScopeDispose(() => {
      stack.clear(id);
      current.value = stack.current;
    });
  }
}

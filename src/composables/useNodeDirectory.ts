/**
 * The node list a page already read, handed down to every NodeLabel under it
 * (design 23, section 3.10), so a node is named the same way everywhere
 * without each cell reading the list again.
 *
 *   provideNodeDirectory(computed(() => nodesQuery.data.value));
 *   <NodeLabel :id="row.node_id" />
 */
import { inject, provide, type InjectionKey, type Ref } from "vue";

import type { NodeRef } from "@/components/common/chassisModel";

const KEY: InjectionKey<Ref<readonly NodeRef[] | undefined>> = Symbol("node-directory");

export function provideNodeDirectory(nodes: Ref<readonly NodeRef[] | undefined>): void {
  provide(KEY, nodes);
}

export function useNodeDirectory(): Ref<readonly NodeRef[] | undefined> | undefined {
  return inject(KEY, undefined);
}

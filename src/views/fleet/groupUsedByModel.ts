/**
 * A node group's Used by section (design 32 D3): every object that names the
 * group, by kind, in a fixed order. Every kind is listed even when nothing of
 * it names the group yet, so the sheet says where to look: checks (design 32
 * S2b), outbound policy, security-group bindings (S4) and WireGuard mesh
 * rules (design 13 W1). A kind the server adds later is listed after these.
 *
 * Pure TS, so `node --test` covers it directly.
 */
import type { GroupUse } from "@/lib/api/types";

export const GROUP_USE_KINDS = ["check", "outbound_policy", "security_group_binding", "mesh_rule"] as const;

export interface GroupUseSection {
  kind: string;
  uses: GroupUse[];
}

export function groupUseSections(uses: readonly GroupUse[]): GroupUseSection[] {
  const byKind = new Map<string, GroupUse[]>();
  for (const kind of GROUP_USE_KINDS) byKind.set(kind, []);
  for (const use of uses) {
    const list = byKind.get(use.kind) ?? [];
    list.push(use);
    byKind.set(use.kind, list);
  }
  return [...byKind.entries()].map(([kind, list]) => ({
    kind,
    uses: [...list].sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id)),
  }));
}

/** How many objects name the group, the hidden ones included. */
export function groupUseCount(uses: readonly GroupUse[], hidden: number): number {
  return uses.length + Math.max(0, hidden);
}

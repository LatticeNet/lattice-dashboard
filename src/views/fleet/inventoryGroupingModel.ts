/**
 * How the Inventory page groups machines, and the order inside each group.
 *
 * Name order suits a group that answers "which vendor" or "which region". The
 * Renewal grouping answers "what comes due next", so its buckets read nearest
 * first: inside Overdue the machine overdue longest leads, inside Due soon and
 * Upcoming the next payment leads. Machines without a usable date keep name
 * order after the dated ones, which in practice is the whole of Setup needed
 * and Not tracked, where nobody has a date.
 *
 * The grouping is read from and written to the address bar (`?group=`), so a
 * Renewal view survives a reload and a shared link opens the way it was sent.
 */

export const INVENTORY_GROUPS = ["billing", "renewal", "vendor", "region", "none"] as const;
export type InventoryGroupBy = (typeof INVENTORY_GROUPS)[number];
export const DEFAULT_INVENTORY_GROUP: InventoryGroupBy = "billing";

export type InventoryOrder = "name" | "due";

export interface OrderableMachine {
  /** Profile id; absent for a node nobody has profiled yet. */
  id?: string;
  days_until_renewal?: number;
}

/** The grouping named in the address bar, or the default for anything else. */
export function parseInventoryGroup(value: unknown): InventoryGroupBy {
  return typeof value === "string" && (INVENTORY_GROUPS as readonly string[]).includes(value)
    ? (value as InventoryGroupBy)
    : DEFAULT_INVENTORY_GROUP;
}

/** Only the Renewal grouping is a question about dates. */
export function orderForGroup(group: InventoryGroupBy): InventoryOrder {
  return group === "renewal" ? "due" : "name";
}

/**
 * Profiles before unprofiled nodes in either order, as before. `dated` is the
 * page's own test for a usable renewal date, so a zero date the server sends
 * for "never set" does not sort as a real one.
 */
export function orderMachines<T extends OrderableMachine>(
  list: readonly T[],
  order: InventoryOrder,
  name: (machine: T) => string,
  dated: (machine: T) => boolean,
): T[] {
  return [...list].sort((a, b) => {
    const aProfile = !!a.id;
    const bProfile = !!b.id;
    if (aProfile !== bProfile) return aProfile ? -1 : 1;
    if (order === "due") {
      const aDays = dueDays(a, dated);
      const bDays = dueDays(b, dated);
      if (aDays !== bDays) {
        if (aDays === undefined) return 1;
        if (bDays === undefined) return -1;
        return aDays - bDays;
      }
    }
    return name(a).localeCompare(name(b));
  });
}

function dueDays<T extends OrderableMachine>(machine: T, dated: (machine: T) => boolean): number | undefined {
  if (!dated(machine)) return undefined;
  const days = machine.days_until_renewal;
  return typeof days === "number" && Number.isFinite(days) ? days : undefined;
}

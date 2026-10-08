/**
 * Inventory's query fields (src/lib/query): what the operator registered
 * about each machine (label, vendor, region, price, renewal), then the shared
 * node fields reached through the machine's node. A page field wins a name
 * it shares with a node field: `region:` here is the vendor's region, and the
 * node's geography stays reachable as `city:` or `geo:`.
 *
 *   billing:recurring renews_in<30d sort:renews_in
 *
 * Pure, like the sibling models: no Vue, no i18n.
 */
import type { MachineView, Node } from "@/lib/api/types";
import type { QueryField, QuerySchema } from "@/lib/query/engine";
import { nodeBareMatch, nodeQueryFields, nodeQueryText } from "@/lib/query/nodeFields";
import { billingCategory, renewalDate, type BillingCategory } from "@/views/fleet/inventoryCostModel";

/** The order the billing grouping uses. */
export const INVENTORY_BILLING: readonly BillingCategory[] = ["renewalIncomplete", "recurring", "unpriced", "onetime", "free", "unprofiled"];

/** Queries the help offers on this page; each key names the sentence that says what it finds. */
export const INVENTORY_QUERY_EXAMPLES = [
  { key: "renewing", query: "renews_in<30d sort:renews_in" },
  { key: "unpriced", query: "billing:unpriced,unprofiled" },
  { key: "pricey", query: "price>20 sort:-price" },
  { key: "vendor", query: "vendor:dmit -is:autoroll" },
] as const;

const hint = (key: string) => `fleet.inventory.query.fields.${key}`;

export interface InventoryQueryOptions {
  nodeOf: (machine: MachineView) => Node | undefined;
  /** The name the list prints. */
  nameOf: (machine: MachineView) => string;
  /** The vendor the list prints. */
  vendorOf: (machine: MachineView) => string;
}

export function inventoryQuerySchema(options: InventoryQueryOptions): QuerySchema<MachineView> {
  const page: QueryField<MachineView>[] = [
    {
      key: "name",
      type: "string",
      hint: hint("name"),
      get: (m) => options.nameOf(m),
      suggest: (rows) => rows.map((m) => options.nameOf(m)),
      sort: (m) => options.nameOf(m).toLowerCase(),
    },
    { key: "label", type: "string", hint: hint("label"), get: (m) => m.label },
    {
      key: "vendor",
      type: "string",
      hint: hint("vendor"),
      get: (m) => options.vendorOf(m) || undefined,
      suggest: (rows) => rows.map((m) => options.vendorOf(m)),
    },
    { key: "region", type: "string", hint: hint("region"), get: (m) => m.region, suggest: (rows) => rows.map((m) => m.region ?? "") },
    {
      key: "billing",
      aliases: ["cost"],
      type: "enum",
      hint: hint("billing"),
      values: INVENTORY_BILLING,
      valueAliases: { incomplete: "renewalIncomplete", "one-time": "onetime", none: "unprofiled" },
      get: (m) => billingCategory(m),
    },
    { key: "price", type: "number", hint: hint("price"), get: (m) => (m.price_cents === undefined ? undefined : m.price_cents / 100) },
    { key: "currency", type: "string", hint: hint("currency"), get: (m) => m.currency, suggest: (rows) => rows.map((m) => m.currency ?? "") },
    { key: "cycle", type: "string", hint: hint("cycle"), get: (m) => m.renewal_cycle, suggest: (rows) => rows.map((m) => String(m.renewal_cycle ?? "")) },
    {
      // Days to the next renewal as a duration, so `renews_in<30d` reads forward in time.
      key: "renews_in",
      aliases: ["renewal"],
      type: "duration",
      hint: hint("renews_in"),
      get: (m) => (renewalDate(m) && typeof m.days_until_renewal === "number" ? m.days_until_renewal * 86400 : undefined),
    },
    { key: "purchased", type: "time", hint: hint("purchased"), get: (m) => m.purchased_at },
    { key: "autoroll", aliases: ["auto_roll"], type: "bool", flag: true, hint: hint("autoroll"), get: (m) => (m.id ? !!m.auto_roll : undefined), sort: false },
    {
      key: "reminders",
      type: "bool",
      flag: true,
      hint: hint("reminders"),
      get: (m) => (m.id ? !!m.reminders_enabled : undefined),
      sort: false,
    },
    { key: "profiled", type: "bool", flag: true, hint: hint("profiled"), get: (m) => !!m.id, sort: false },
  ];
  return {
    fields: [...page, ...nodeQueryFields(options.nodeOf, { identity: (m) => ({ id: m.node_id, name: options.nameOf(m) }) })],
    text: (m) => [
      options.nameOf(m),
      m.node_name,
      m.node_id,
      options.vendorOf(m),
      m.region,
      m.host_facts?.hostname,
      ...nodeQueryText(options.nodeOf(m)),
    ],
    bare: nodeBareMatch(options.nodeOf),
  };
}

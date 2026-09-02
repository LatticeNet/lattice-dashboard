/**
 * fleet.ts. Pure, CSP-safe helpers for fleet grouping, geography, and
 * aggregate roll-ups shared by the Overview, Nodes, and Topology views.
 *
 * Everything here is a pure function over the polled `Node[]` list:
 *  - country/continent helpers turn the server's ISO-3166 alpha-2 `geo.country`
 *    (uppercased + validated server-side) into the two-letter mark itself and a
 *    coarse continent "region cluster" (Asia / Europe / North America ...),
 *    which is the grouping operators actually think in ("asia / us-west").
 *    Flag emoji were removed on purpose; see `countryMark` below for why.
 *  - `groupNodes()` buckets a fleet by region / country / role / status / tag.
 *  - `fleetTotals()` rolls per-node metrics up into one fleet-wide summary.
 *
 * No DOM, no i18n imports, no runtime style/script injection. Region/country
 * display names come from the built-in `Intl.DisplayNames` (no eval, no bundle
 * cost) so they localise for free; callers pass the active locale.
 */
import type { Metrics, Node } from "@/lib/api/types";
import { countNodeStatuses, isReporting, nodeStatus, type NodeStatusCounts } from "@/lib/nodeStatus";

/* ------------------------------------------------------------------ */
/* Geography                                                           */
/* ------------------------------------------------------------------ */

/** A two-letter ISO-3166 alpha-2 code, e.g. `HK`. */
function isCountryCode(value?: string): value is string {
  return typeof value === "string" && /^[A-Za-z]{2}$/.test(value);
}

/**
 * The ISO-3166 alpha-2 code itself, as the group's short mark.
 *
 * This used to build a flag emoji out of Regional Indicator Symbols. Flags are
 * the worst possible mark for a fleet console: several of them are visually
 * identical at 14px, Windows renders them as two letters anyway, and a
 * grouping header is a place where being exactly right about which country a
 * machine is in matters. The letters are what an operator was reading off the
 * flag in the first place.
 */
export function countryMark(code?: string): string {
  return isCountryCode(code) ? code.toUpperCase() : "";
}

/**
 * Localised country name for a code (e.g. `HK` → "Hong Kong" / "中国香港").
 * Falls back to the raw code if `Intl.DisplayNames` is unavailable or the code
 * is unknown.
 */
export function countryName(code?: string, locale = "en"): string {
  if (!isCountryCode(code)) return code ?? "";
  const upper = code.toUpperCase();
  try {
    const dn = new Intl.DisplayNames([locale], { type: "region" });
    return dn.of(upper) || upper;
  } catch {
    return upper;
  }
}

/** Coarse continent bucket keyed by ISO-3166 alpha-2 code. */
export type Continent = "AS" | "EU" | "NA" | "SA" | "AF" | "OC" | "AN" | "??";

const CONTINENT_LABEL: Record<Continent, string> = {
  AS: "Asia",
  EU: "Europe",
  NA: "North America",
  SA: "South America",
  AF: "Africa",
  OC: "Oceania",
  AN: "Antarctica",
  "??": "Unknown",
};

/**
 * Region marks are the continent codes, for the same reason country marks are
 * the country codes: three globe emoji shared across seven continents told an
 * operator nothing that the header text was not already saying.
 */
const CONTINENT_MARK: Record<Continent, string> = {
  AS: "AS",
  EU: "EU",
  NA: "NA",
  SA: "SA",
  AF: "AF",
  OC: "OC",
  AN: "AN",
  "??": "",
};

// ISO-3166 alpha-2 → continent. Compact but complete enough for any real fleet;
// unknown codes fall through to "??".
const COUNTRY_CONTINENT: Record<string, Continent> = {
  // Asia
  AE: "AS", AF: "AS", AM: "AS", AZ: "AS", BD: "AS", BH: "AS", BN: "AS", BT: "AS",
  CN: "AS", CY: "AS", GE: "AS", HK: "AS", ID: "AS", IL: "AS", IN: "AS", IQ: "AS",
  IR: "AS", JO: "AS", JP: "AS", KG: "AS", KH: "AS", KP: "AS", KR: "AS", KW: "AS",
  KZ: "AS", LA: "AS", LB: "AS", LK: "AS", MM: "AS", MN: "AS", MO: "AS", MV: "AS",
  MY: "AS", NP: "AS", OM: "AS", PH: "AS", PK: "AS", PS: "AS", QA: "AS", SA: "AS",
  SG: "AS", SY: "AS", TH: "AS", TJ: "AS", TL: "AS", TM: "AS", TR: "AS", TW: "AS",
  UZ: "AS", VN: "AS", YE: "AS",
  // Europe
  AD: "EU", AL: "EU", AT: "EU", BA: "EU", BE: "EU", BG: "EU", BY: "EU", CH: "EU",
  CZ: "EU", DE: "EU", DK: "EU", EE: "EU", ES: "EU", FI: "EU", FO: "EU", FR: "EU",
  GB: "EU", GG: "EU", GI: "EU", GR: "EU", HR: "EU", HU: "EU", IE: "EU", IM: "EU",
  IS: "EU", IT: "EU", JE: "EU", LI: "EU", LT: "EU", LU: "EU", LV: "EU", MC: "EU",
  MD: "EU", ME: "EU", MK: "EU", MT: "EU", NL: "EU", NO: "EU", PL: "EU", PT: "EU",
  RO: "EU", RS: "EU", RU: "EU", SE: "EU", SI: "EU", SK: "EU", SM: "EU", UA: "EU",
  VA: "EU", XK: "EU",
  // North America
  AG: "NA", AI: "NA", AW: "NA", BB: "NA", BL: "NA", BM: "NA", BS: "NA", BZ: "NA",
  CA: "NA", CR: "NA", CU: "NA", CW: "NA", DM: "NA", DO: "NA", GD: "NA", GL: "NA",
  GP: "NA", GT: "NA", HN: "NA", HT: "NA", JM: "NA", KN: "NA", KY: "NA", LC: "NA",
  MF: "NA", MQ: "NA", MS: "NA", MX: "NA", NI: "NA", PA: "NA", PM: "NA", PR: "NA",
  SV: "NA", SX: "NA", TC: "NA", TT: "NA", US: "NA", VC: "NA", VG: "NA", VI: "NA",
  // South America
  AR: "SA", BO: "SA", BR: "SA", CL: "SA", CO: "SA", EC: "SA", FK: "SA", GF: "SA",
  GY: "SA", PE: "SA", PY: "SA", SR: "SA", UY: "SA", VE: "SA",
  // Africa
  AO: "AF", BF: "AF", BI: "AF", BJ: "AF", BW: "AF", CD: "AF", CF: "AF", CG: "AF",
  CI: "AF", CM: "AF", CV: "AF", DJ: "AF", DZ: "AF", EG: "AF", EH: "AF", ER: "AF",
  ET: "AF", GA: "AF", GH: "AF", GM: "AF", GN: "AF", GQ: "AF", GW: "AF", KE: "AF",
  KM: "AF", LR: "AF", LS: "AF", LY: "AF", MA: "AF", MG: "AF", ML: "AF", MR: "AF",
  MU: "AF", MW: "AF", MZ: "AF", NA: "AF", NE: "AF", NG: "AF", RE: "AF", RW: "AF",
  SC: "AF", SD: "AF", SL: "AF", SN: "AF", SO: "AF", SS: "AF", ST: "AF", SZ: "AF",
  TD: "AF", TG: "AF", TN: "AF", TZ: "AF", UG: "AF", YT: "AF", ZA: "AF", ZM: "AF",
  ZW: "AF",
  // Oceania
  AS: "OC", AU: "OC", CK: "OC", FJ: "OC", FM: "OC", GU: "OC", KI: "OC", MH: "OC",
  MP: "OC", NC: "OC", NF: "OC", NR: "OC", NU: "OC", NZ: "OC", PF: "OC", PG: "OC",
  PW: "OC", SB: "OC", TK: "OC", TO: "OC", TV: "OC", VU: "OC", WF: "OC", WS: "OC",
  // Antarctica
  AQ: "AN",
};

// `NA` collides between Namibia (Africa) and North America's continent code; the
// table above maps the country code `NA` to Africa (Namibia) which is correct,
// the continent enum value `"NA"` (North America) is only produced via the
// country→continent lookup of other codes, never from a literal `NA` key clash.

/** Continent bucket for an ISO-3166 alpha-2 country code. */
export function continentOf(code?: string): Continent {
  if (!isCountryCode(code)) return "??";
  return COUNTRY_CONTINENT[code.toUpperCase()] ?? "??";
}

export function continentLabel(c: Continent): string {
  return CONTINENT_LABEL[c];
}

export function continentMark(c: Continent): string {
  return CONTINENT_MARK[c];
}

/* ------------------------------------------------------------------ */
/* Grouping                                                            */
/* ------------------------------------------------------------------ */

export type GroupBy = "region" | "country" | "role" | "group" | "status" | "tag" | "none";

/** i18n key suffixes under `common.regions` / `common.groups` for fixed buckets. */
export const CONTINENT_I18N: Record<Continent, string> = {
  AS: "common.regions.AS",
  EU: "common.regions.EU",
  NA: "common.regions.NA",
  SA: "common.regions.SA",
  AF: "common.regions.AF",
  OC: "common.regions.OC",
  AN: "common.regions.AN",
  "??": "common.regions.unknown",
};

export interface NodeGroup {
  /** Stable key for `v-for` / collapse state. */
  key: string;
  /** English fallback label (use `i18nKey` first when present). */
  label: string;
  /** When set, callers should prefer `$t(i18nKey)` over `label`. */
  i18nKey?: string;
  /**
   * Leading short mark: the country code (country grouping), the continent
   * code (region grouping), or "" when the dimension has no such mark.
   */
  glyph: string;
  /** Sort weight; lower sorts first. Online-heavy / known regions float up. */
  order: number;
  nodes: Node[];
  online: number;
  total: number;
  /** Color token (group mode only) for the section dot; undefined otherwise. */
  color?: string;
}

const UNGROUPED_KEY = "__ungrouped__";

/** A node counts as "live" only when its agent is online AND it isn't disabled. */
/**
 * A node whose metrics are current: online or degraded. Disabled outranks a
 * live agent, and a node that went quiet keeps stale gauges the sums must
 * not count. One reading, from the status module.
 */
function isLive(node: Node): boolean {
  return isReporting(node);
}

/**
 * Bucket a fleet into ordered groups by the chosen dimension.
 *
 *  - `region` . Continent derived from `geo.country` (Asia / Europe / …).
 *  - `country`. Exact `geo.country` code (flag + localised name).
 *  - `role`   . The operator-assigned role (group-leader / hub / member …).
 *  - `status` . Online / Degraded / Offline / Never reported / Disabled.
 *  - `tag`    . One bucket per tag; a node appears in every tag it carries.
 *  - `none`   . A single bucket holding the whole fleet.
 *
 * Groups are returned sorted by `order` then label; within each group the nodes
 * are sorted live-first, then by name. The ungrouped/unknown bucket sorts last.
 */
export function groupNodes(
  nodes: Node[],
  by: GroupBy,
  locale = "en",
  groups: { id: string; name: string; color?: string }[] = [],
  opts: { preserveOrder?: boolean } = {},
): NodeGroup[] {
  const preserveOrder = !!opts.preserveOrder;
  if (by === "none") {
    return [
      finishGroup(
        { key: "all", label: "", glyph: "", order: 0, nodes: [...nodes], online: 0, total: 0 },
        preserveOrder,
      ),
    ];
  }

  const groupMeta = new Map(groups.map((g) => [g.id, g] as const));
  const map = new Map<string, NodeGroup>();
  const push = (
    key: string,
    label: string,
    glyph: string,
    order: number,
    node: Node,
    i18nKey?: string,
    color?: string,
  ) => {
    let g = map.get(key);
    if (!g) {
      g = {
        key,
        label,
        glyph,
        order,
        nodes: [],
        online: 0,
        total: 0,
        ...(i18nKey ? { i18nKey } : {}),
        ...(color ? { color } : {}),
      };
      map.set(key, g);
    }
    g.nodes.push(node);
  };

  for (const node of nodes) {
    switch (by) {
      case "region": {
        const c = continentOf(node.geo?.country);
        if (c === "??") push(UNGROUPED_KEY, continentLabel("??"), continentMark("??"), 99, node, CONTINENT_I18N["??"]);
        else push(`region:${c}`, continentLabel(c), continentMark(c), 10, node, CONTINENT_I18N[c]);
        break;
      }
      case "country": {
        const code = node.geo?.country;
        if (!isCountryCode(code)) push(UNGROUPED_KEY, continentLabel("??"), "", 99, node, CONTINENT_I18N["??"]);
        else push(`country:${code.toUpperCase()}`, countryName(code, locale), countryMark(code), 10, node);
        break;
      }
      case "role": {
        const role = node.role?.trim();
        if (!role) push(UNGROUPED_KEY, "No role", "", 99, node, "common.groups.noRole");
        else push(`role:${role}`, role, "", 10, node);
        break;
      }
      case "group": {
        // A node carries server-resolved group_ids; it appears once per group it
        // belongs to (like tags). Color rides along for the section dot.
        const ids = node.group_ids ?? [];
        if (ids.length === 0) push(UNGROUPED_KEY, "Ungrouped", "", 99, node, "common.groups.ungrouped");
        else
          for (const id of ids) {
            const meta = groupMeta.get(id);
            push(`group:${id}`, meta?.name ?? id, "", 10, node, undefined, meta?.color);
          }
        break;
      }
      case "status": {
        // The five words of the status ontology, in triage order after the
        // good state, each bucket keyed by the wire value.
        switch (nodeStatus(node)) {
          case "online":
            push("status:online", "Online", "", 10, node, "common.groups.online");
            break;
          case "degraded":
            push("status:degraded", "Degraded", "", 20, node, "common.groups.degraded");
            break;
          case "offline":
            push("status:offline", "Offline", "", 30, node, "common.groups.offline");
            break;
          case "never_reported":
            push("status:never_reported", "Never reported", "", 40, node, "common.groups.neverReported");
            break;
          case "disabled":
            push("status:disabled", "Disabled", "", 50, node, "common.groups.disabled");
            break;
        }
        break;
      }
      case "tag": {
        const tags = node.tags ?? [];
        if (tags.length === 0) push(UNGROUPED_KEY, "Untagged", "", 99, node, "common.groups.untagged");
        else for (const tag of tags) push(`tag:${tag}`, tag, "", 10, node);
        break;
      }
    }
  }

  return [...map.values()]
    .map((g) => finishGroup(g, preserveOrder))
    .sort((a, b) => a.order - b.order || b.total - a.total || a.label.localeCompare(b.label));
}

function finishGroup(g: NodeGroup, preserveOrder = false): NodeGroup {
  // Callers that already ordered the list (explicit column sort, search
  // relevance) pass preserveOrder so bucketing does not silently re-rank the
  // rows the operator just sorted.
  if (!preserveOrder) {
    g.nodes.sort((a, b) => {
      if (!!a.disabled !== !!b.disabled) return a.disabled ? 1 : -1;
      if (isLive(a) !== isLive(b)) return isLive(a) ? -1 : 1;
      // Node id last: names are not unique, so without it two machines sharing
      // a name are ordered by whatever order the poll delivered them in.
      return (a.name || a.id).localeCompare(b.name || b.id) || a.id.localeCompare(b.id);
    });
  }
  g.total = g.nodes.length;
  // The header prints "online/total": the status word, not the reporting
  // set, so a degraded node counts the same here as in every KPI.
  g.online = g.nodes.filter((n) => nodeStatus(n) === "online").length;
  // The ungrouped bucket always sinks to the bottom regardless of size.
  if (g.key === UNGROUPED_KEY) g.order = 999;
  return g;
}

/* ------------------------------------------------------------------ */
/* Display name                                                        */
/* ------------------------------------------------------------------ */

/**
 * Fleet names carry grouping prefixes like "[cd]-" and "[Metix]-". As plain
 * text they eat the narrow name column before the actual machine name starts;
 * as a small badge the group survives at a glance and the name keeps the
 * width. Display only: search, sort, and tooltips still see the full string.
 */
// Up to 20 characters: "[OpenJobs-Data]" is 13 and is the longest in the fleet.
const NAME_PREFIX_RE = /^\[([^\]]{1,20})\]-(.+)$/;

export interface SplitName {
  /** The bracketed group, without brackets; "" when the name has none. */
  prefix: string;
  /** The name with the prefix removed, or the id when the name is empty. */
  body: string;
}

export function splitNamePrefix(node: Pick<Node, "id" | "name">): SplitName {
  const raw = node.name || node.id;
  const m = raw.match(NAME_PREFIX_RE);
  return m ? { prefix: m[1] ?? "", body: m[2] ?? raw } : { prefix: "", body: raw };
}

/* ------------------------------------------------------------------ */
/* Aggregate roll-up                                                   */
/* ------------------------------------------------------------------ */

export interface FleetTotals extends NodeStatusCounts {
  /** Distinct continents with at least one node. */
  regions: number;
  /** Distinct countries with at least one node. */
  countries: number;
  /** Nodes carrying no usable country code. Regions/countries counts only
   *  cover the located part of the fleet; a card that hides this number
   *  presents partial data as fleet truth. */
  geoMissing: number;
  /** Mean CPU% across live nodes that report it (0 when none). */
  cpuPercent: number;
  /** Summed memory across live nodes. */
  memUsed: number;
  memTotal: number;
  /** Summed disk across live nodes. */
  diskUsed: number;
  diskTotal: number;
  /** Summed instantaneous network speed across live nodes (bytes/sec). */
  netRxSpeed: number;
  netTxSpeed: number;
  /** Summed cumulative interface counters across live nodes (bytes). */
  netRxBytes: number;
  netTxBytes: number;
}

function num(value?: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Roll per-node metrics up into one fleet-wide summary. The status counts come
 * from `countNodeStatuses`, so this and every KPI print the same six numbers.
 * Resource sums and the CPU mean consider only reporting nodes (online or
 * degraded): an offline node's last-known gauges would otherwise inflate
 * "current" fleet load.
 */
export function fleetTotals(nodes: Node[]): FleetTotals {
  const t: FleetTotals = {
    ...countNodeStatuses(nodes),
    regions: 0,
    countries: 0,
    geoMissing: 0,
    cpuPercent: 0,
    memUsed: 0,
    memTotal: 0,
    diskUsed: 0,
    diskTotal: 0,
    netRxSpeed: 0,
    netTxSpeed: 0,
    netRxBytes: 0,
    netTxBytes: 0,
  };

  const continents = new Set<string>();
  const countries = new Set<string>();
  let cpuSum = 0;
  let cpuCount = 0;

  for (const node of nodes) {
    const c = node.geo?.country;
    if (isCountryCode(c)) {
      countries.add(c.toUpperCase());
      const cont = continentOf(c);
      if (cont !== "??") continents.add(cont);
    } else {
      t.geoMissing += 1;
    }

    if (!isLive(node)) continue;
    const m: Metrics | undefined = node.metrics;
    if (!m) continue;
    if (typeof m.cpu_percent === "number" && Number.isFinite(m.cpu_percent)) {
      cpuSum += m.cpu_percent;
      cpuCount += 1;
    }
    t.memUsed += num(m.memory_used);
    t.memTotal += num(m.memory_total);
    t.diskUsed += num(m.disk_used);
    t.diskTotal += num(m.disk_total);
    t.netRxSpeed += num(m.net_rx_speed);
    t.netTxSpeed += num(m.net_tx_speed);
    t.netRxBytes += num(m.net_rx_bytes);
    t.netTxBytes += num(m.net_tx_bytes);
  }

  t.regions = continents.size;
  t.countries = countries.size;
  t.cpuPercent = cpuCount > 0 ? cpuSum / cpuCount : 0;
  return t;
}

/**
 * fleet.ts — pure, CSP-safe helpers for fleet grouping, geography, and
 * aggregate roll-ups shared by the Overview, Nodes, and Topology views.
 *
 * Everything here is a pure function over the polled `Node[]` list:
 *  - country/continent helpers turn the server's ISO-3166 alpha-2 `geo.country`
 *    (uppercased + validated server-side) into a flag emoji and a coarse
 *    continent "region cluster" (Asia / Europe / North America …) — which is
 *    the grouping operators actually think in ("asia / us-west").
 *  - `groupNodes()` buckets a fleet by region / country / role / status / tag.
 *  - `fleetTotals()` rolls per-node metrics up into one fleet-wide summary.
 *
 * No DOM, no i18n imports, no runtime style/script injection. Region/country
 * display names come from the built-in `Intl.DisplayNames` (no eval, no bundle
 * cost) so they localise for free; callers pass the active locale.
 */
import type { Metrics, Node } from "@/lib/api/types";

/* ------------------------------------------------------------------ */
/* Geography                                                           */
/* ------------------------------------------------------------------ */

/** A two-letter ISO-3166 alpha-2 code, e.g. `HK`. */
function isCountryCode(value?: string): value is string {
  return typeof value === "string" && /^[A-Za-z]{2}$/.test(value);
}

/**
 * Flag emoji for an ISO-3166 alpha-2 code via Regional Indicator Symbols.
 * Returns "" for anything that isn't a 2-letter code so callers can fall back
 * to a generic glyph. Pure Unicode — no images, CSP-safe.
 */
export function countryFlag(code?: string): string {
  if (!isCountryCode(code)) return "";
  const base = 0x1f1e6; // 🇦
  const upper = code.toUpperCase();
  const a = upper.codePointAt(0);
  const b = upper.codePointAt(1);
  if (a === undefined || b === undefined) return "";
  return String.fromCodePoint(base + (a - 65), base + (b - 65));
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

const CONTINENT_GLYPH: Record<Continent, string> = {
  AS: "🌏",
  EU: "🌍",
  NA: "🌎",
  SA: "🌎",
  AF: "🌍",
  OC: "🌏",
  AN: "🧊",
  "??": "🌐",
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
// table above maps the country code `NA` to Africa (Namibia) which is correct —
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

export function continentGlyph(c: Continent): string {
  return CONTINENT_GLYPH[c];
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
  /** Leading glyph — flag emoji (country), continent glyph (region), or "". */
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
function isLive(node: Node): boolean {
  return !!node.online && !node.disabled;
}

/**
 * Bucket a fleet into ordered groups by the chosen dimension.
 *
 *  - `region`  — continent derived from `geo.country` (Asia / Europe / …).
 *  - `country` — exact `geo.country` code (flag + localised name).
 *  - `role`    — the operator-assigned role (group-leader / hub / member …).
 *  - `status`  — Online / Offline / Disabled.
 *  - `tag`     — one bucket per tag; a node appears in every tag it carries.
 *  - `none`    — a single bucket holding the whole fleet.
 *
 * Groups are returned sorted by `order` then label; within each group the nodes
 * are sorted live-first, then by name. The ungrouped/unknown bucket sorts last.
 */
export function groupNodes(
  nodes: Node[],
  by: GroupBy,
  locale = "en",
  groups: { id: string; name: string; color?: string }[] = [],
): NodeGroup[] {
  if (by === "none") {
    return [finishGroup({ key: "all", label: "", glyph: "", order: 0, nodes: [...nodes], online: 0, total: 0 })];
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
        if (c === "??") push(UNGROUPED_KEY, continentLabel("??"), continentGlyph("??"), 99, node, CONTINENT_I18N["??"]);
        else push(`region:${c}`, continentLabel(c), continentGlyph(c), 10, node, CONTINENT_I18N[c]);
        break;
      }
      case "country": {
        const code = node.geo?.country;
        if (!isCountryCode(code)) push(UNGROUPED_KEY, continentLabel("??"), "🌐", 99, node, CONTINENT_I18N["??"]);
        else push(`country:${code.toUpperCase()}`, countryName(code, locale), countryFlag(code), 10, node);
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
        if (node.disabled) push("status:disabled", "Disabled", "", 30, node, "common.groups.disabled");
        else if (node.online) push("status:online", "Online", "", 10, node, "common.groups.online");
        else push("status:offline", "Offline", "", 20, node, "common.groups.offline");
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
    .map(finishGroup)
    .sort((a, b) => a.order - b.order || b.total - a.total || a.label.localeCompare(b.label));
}

function finishGroup(g: NodeGroup): NodeGroup {
  g.nodes.sort((a, b) => {
    if (!!a.disabled !== !!b.disabled) return a.disabled ? 1 : -1;
    if (a.online !== b.online) return a.online ? -1 : 1;
    return (a.name || a.id).localeCompare(b.name || b.id);
  });
  g.total = g.nodes.length;
  g.online = g.nodes.filter(isLive).length;
  // The ungrouped bucket always sinks to the bottom regardless of size.
  if (g.key === UNGROUPED_KEY) g.order = 999;
  return g;
}

/* ------------------------------------------------------------------ */
/* Aggregate roll-up                                                   */
/* ------------------------------------------------------------------ */

export interface FleetTotals {
  total: number;
  online: number;
  offline: number;
  disabled: number;
  /** Distinct continents with at least one node. */
  regions: number;
  /** Distinct countries with at least one node. */
  countries: number;
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
}

function num(value?: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Roll per-node metrics up into one fleet-wide summary. Resource sums and the
 * CPU mean consider only LIVE nodes (online and not disabled) — an offline
 * node's last-known gauges would otherwise inflate "current" fleet load.
 */
export function fleetTotals(nodes: Node[]): FleetTotals {
  const t: FleetTotals = {
    total: nodes.length,
    online: 0,
    offline: 0,
    disabled: 0,
    regions: 0,
    countries: 0,
    cpuPercent: 0,
    memUsed: 0,
    memTotal: 0,
    diskUsed: 0,
    diskTotal: 0,
    netRxSpeed: 0,
    netTxSpeed: 0,
  };

  const continents = new Set<string>();
  const countries = new Set<string>();
  let cpuSum = 0;
  let cpuCount = 0;

  for (const node of nodes) {
    if (node.disabled) t.disabled += 1;
    else if (node.online) t.online += 1;
    else t.offline += 1;

    const c = node.geo?.country;
    if (isCountryCode(c)) {
      countries.add(c.toUpperCase());
      const cont = continentOf(c);
      if (cont !== "??") continents.add(cont);
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
  }

  t.regions = continents.size;
  t.countries = countries.size;
  t.cpuPercent = cpuCount > 0 ? cpuSum / cpuCount : 0;
  return t;
}

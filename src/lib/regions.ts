/**
 * Where a node is, in the order its round trip from mainland China usually
 * runs: mainland, East Asia, Southeast Asia, South Asia, Oceania, North
 * America, Europe, then the rest, and a node with no country last. Monitoring
 * groups the latency matrix and the topology by it, so a column of handshake
 * times reads as a gradient and an odd one stands out.
 *
 * Hong Kong, Macau and Taiwan are outside mainland China here, as in the
 * latency probe planner (lattice-server latency_probes.go).
 *
 * Pure TS, so `node --test` covers it through its callers' models.
 */
export type RegionKey =
  | "mainland"
  | "eastAsia"
  | "southeastAsia"
  | "southAsia"
  | "oceania"
  | "northAmerica"
  | "europe"
  | "middleEast"
  | "africa"
  | "southAmerica"
  | "other"
  | "unknown";

/** Rough order of round trip from mainland China, near first; a node with no country last. */
export const REGION_ORDER: readonly RegionKey[] = [
  "mainland",
  "eastAsia",
  "southeastAsia",
  "southAsia",
  "oceania",
  "northAmerica",
  "europe",
  "middleEast",
  "africa",
  "southAmerica",
  "other",
  "unknown",
];

const REGION_COUNTRIES: Record<Exclude<RegionKey, "other" | "unknown">, string> = {
  mainland: "CN",
  eastAsia: "HK MO TW JP KR KP MN",
  southeastAsia: "SG MY TH VN ID PH KH LA MM BN TL",
  southAsia: "IN PK BD LK NP BT MV AF",
  oceania: "AU NZ FJ PG NC PF GU",
  northAmerica: "US CA MX PR",
  europe:
    "GB IE FR DE NL BE LU CH AT IT ES PT DK NO SE FI IS PL CZ SK HU RO BG GR SI HR RS BA ME MK AL EE LV LT UA BY MD RU MT CY",
  middleEast: "AE SA QA BH KW OM IL JO LB TR IR IQ SY YE",
  africa: "ZA EG NG KE MA DZ TN GH ET TZ UG SN CI AO MU",
  southAmerica: "BR AR CL CO PE VE EC UY PY BO",
};

const COUNTRY_REGION = new Map<string, RegionKey>();
for (const [region, list] of Object.entries(REGION_COUNTRIES)) {
  for (const code of list.split(" ")) COUNTRY_REGION.set(code, region as RegionKey);
}

export function regionOf(country: string | undefined): RegionKey {
  const code = country?.trim().toUpperCase() ?? "";
  if (!code) return "unknown";
  return COUNTRY_REGION.get(code) ?? "other";
}

export function regionRank(region: RegionKey): number {
  return REGION_ORDER.indexOf(region);
}


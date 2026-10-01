/**
 * The production shape of the fleet for the Networking, Platform and Settings
 * harness (dev/netplat-*.html), from the 2026-09-30 read of lattice.roobli.org
 * (design 23, section 1): 34 nodes, 32 online, the 13 `[Metix]-` nodes that
 * read the same at 8 characters, 16 `[cd]-` nodes, and 4 agent versions.
 *
 * Names follow production's pattern. Addresses are documentation ranges
 * (203.0.113.0/24, 198.51.100.0/24, 2001:db8::/32), and which node is offline,
 * which runs which agent version, are invented to production's counts.
 */
import type { Node, NodeStatus } from "@/lib/api/index";

export const NOW = Date.now();
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export function iso(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}

export function delay<T>(value: T, ms = 90): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

/** The query string of the harness page, for fixture switches. */
export const flags = new URLSearchParams(window.location.search);

/** The agent release every current node runs (invented number, production has 4 versions). */
export const LATEST_AGENT = "0.3.9";

interface FleetEntry {
  name: string;
  v4: string;
  v6?: string;
  status?: NodeStatus;
  sinceMs?: number;
  agent?: string;
  tags: string[];
}

const FLEET: FleetEntry[] = [
  { name: "[Metix]-Racknerd-NYC", v4: "198.51.100.11", tags: ["Metix", "VDS"] },
  { name: "[Metix]-Racknerd-LA", v4: "198.51.100.12", tags: ["Metix", "VDS"] },
  { name: "[Metix]-DMIT-1", v4: "198.51.100.21", tags: ["Metix", "DMIT", "三网优化"] },
  { name: "[Metix]-DMIT-2", v4: "198.51.100.22", tags: ["Metix", "DMIT", "三网优化"] },
  { name: "[Metix]-DMIT-3", v4: "198.51.100.23", tags: ["Metix", "DMIT", "三网优化"] },
  { name: "[Metix]-DMIT-4", v4: "198.51.100.24", status: "offline", sinceMs: 6 * DAY + 3 * HOUR, agent: "0.3.8", tags: ["Metix", "DMIT"] },
  { name: "[Metix]-VIRCS-ATT-VDS", v4: "198.51.100.31", tags: ["Metix", "VDS"] },
  { name: "[Metix]-Aaitr-jp-softbank-NAT", v4: "198.51.100.41", tags: ["Metix", "Aaitr", "NAT"] },
  { name: "[Metix]-Oracle-KIX-arm", v4: "198.51.100.51", tags: ["Metix"] },
  { name: "[Metix]-Hetzner-FSN", v4: "198.51.100.61", v6: "2001:db8:61::1", tags: ["Metix"] },
  { name: "[Metix]-GreenCloud-SG", v4: "198.51.100.71", tags: ["Metix", "VDS"] },
  { name: "[Metix]-Akko-UK", v4: "198.51.100.81", tags: ["Metix", "VDS"] },
  { name: "[Metix]-BWG-DC6", v4: "198.51.100.91", tags: ["Metix", "三网优化"] },
  { name: "[cd]-DMIT-pro-malibu", v4: "203.0.113.11", v6: "2001:db8:11::1", tags: ["cd", "DMIT", "三网优化"] },
  { name: "[cd]-homeserver", v4: "203.0.113.12", v6: "2001:db8:12::1", status: "offline", sinceMs: 41 * MINUTE, tags: ["cd", "HOME"] },
  { name: "[cd]-mac-air", v4: "203.0.113.13", agent: "0.3.8", tags: ["cd", "HOME"] },
  { name: "[cd]-xuezhang-jp-NAT", v4: "203.0.113.14", tags: ["cd", "NAT"] },
  { name: "[cd]-Oracle-KIX-arm", v4: "203.0.113.15", tags: ["cd"] },
  { name: "[cd]-hetzner-fsn", v4: "203.0.113.16", v6: "2001:db8:16::1", tags: ["cd", "VDS"] },
  { name: "[cd]-hetzner-hel", v4: "203.0.113.17", tags: ["cd", "VDS"] },
  { name: "[cd]-racknerd-la", v4: "203.0.113.18", tags: ["cd", "VDS"] },
  { name: "[cd]-bandwagon-dc6", v4: "203.0.113.19", tags: ["cd", "三网优化"] },
  { name: "[cd]-vultr-syd", v4: "203.0.113.20", tags: ["cd", "VDS"] },
  { name: "[cd]-linode-sgp", v4: "203.0.113.21", tags: ["cd", "VDS"] },
  { name: "[cd]-Akkocloud-UK-London-KVM", v4: "203.0.113.22", tags: ["cd", "VDS"] },
  { name: "[cd]-GreenCloud-SG", v4: "203.0.113.23", agent: "0.3.6", tags: ["cd", "VDS"] },
  { name: "[cd]-hkbn-hub", v4: "203.0.113.24", v6: "2001:db8:24::1", tags: ["cd", "HOME"] },
  { name: "[cd]-nas-home", v4: "203.0.113.25", agent: "0.3.8", tags: ["cd", "HOME"] },
  { name: "[cd]-aws-tokyo", v4: "203.0.113.26", tags: ["cd", "AWS"] },
  { name: "[OpenJobs-Data]-TiDB-1", v4: "203.0.113.31", tags: ["OpenJobs-Data", "AWS"] },
  { name: "[OpenJobs-Data]-scripts", v4: "203.0.113.32", agent: "0.3.3", tags: ["OpenJobs-Data", "AWS"] },
  { name: "Aaitr-ATT-VDS", v4: "203.0.113.41", tags: ["Aaitr", "openjobs-vpn"] },
  { name: "gomami-hk-turin-mini", v4: "203.0.113.42", tags: ["openjobs-vpn"] },
  { name: "mkcloud-hr-iplc", v4: "203.0.113.43", tags: ["openjobs-vpn"] },
];

/**
 * Where a node sits, by the provider and city in its name (invented to that
 * pattern; production nodes carry geo the Map page reads). A name with no
 * place in it gets no coordinates, as on the live fleet.
 */
const PLACES: Array<[RegExp, string, number, number]> = [
  [/NYC/, "US", 40.71, -74.01],
  [/LA\b|-la\b|malibu|VIRCS|ATT/i, "US", 34.05, -118.24],
  [/DMIT/, "US", 34.05, -118.24],
  [/KIX|softbank|jp|tokyo/i, "JP", 34.69, 135.5],
  [/FSN|fsn/, "DE", 50.47, 12.37],
  [/hel/, "FI", 60.17, 24.94],
  [/SG|sgp/i, "SG", 1.35, 103.82],
  [/UK|London/i, "GB", 51.51, -0.13],
  [/DC6|dc6/, "US", 34.05, -118.24],
  [/syd/, "AU", -33.87, 151.21],
  [/hk|hkbn|turin/i, "HK", 22.32, 114.17],
];

function geoOf(name: string): Node["geo"] {
  const place = PLACES.find(([pattern]) => pattern.test(name));
  return place ? { country: place[1], lat: place[2], lon: place[3] } : undefined;
}

function toNode(entry: FleetEntry, index: number): Node {
  const id = `node_${String(index + 1).padStart(3, "0")}`;
  const status = entry.status ?? "online";
  const reporting = status === "online" || status === "degraded";
  const since = entry.sinceMs ?? 9 * DAY;
  return {
    id,
    name: entry.name,
    tags: entry.tags,
    public_ip: entry.v4,
    public_ipv6: entry.v6,
    agent_version: entry.agent ?? LATEST_AGENT,
    geo: geoOf(entry.name),
    online: reporting,
    reachability: reporting ? "online" : "offline",
    status,
    status_since: iso(-since),
    status_reason: reporting
      ? `Reporting; last report at ${iso(-4000).replace(/\.\d{3}Z$/, "Z")}.`
      : `No report since ${iso(-since).replace(/\.\d{3}Z$/, "Z")}; the control plane stops trusting a node after 1m30s of silence.`,
    last_seen: reporting ? iso(-4000) : iso(-since),
  };
}

export const NODES: Node[] = FLEET.map(toNode);

export function nodeByName(name: string): Node {
  const node = NODES.find((entry) => entry.name === name);
  if (!node) throw new Error(`fixture: no node named ${name}`);
  return node;
}

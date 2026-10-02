/**
 * 22 DDNS profiles, production's count (design 23, section 1). Names,
 * domains and states are invented to the shape the page has to handle: two
 * failing (a Cloudflare 401 and a webhook 502), one stale (its node's address
 * moved two days ago and the profile has not written since), three on the two
 * offline nodes, and the rest current, most of them last run weeks ago because
 * the server only writes when an address moves.
 *
 *   ?ddns=empty   no profiles (first run)
 */
import type { DDNSView } from "@/lib/api/index";

import { DAY, HOUR, MINUTE, NODES, flags, iso, nodeByName } from "./netplatFixture";

interface Seed {
  name: string;
  node: string;
  domains: string[];
  v6?: boolean;
  v4?: boolean;
  provider?: "cloudflare" | "webhook";
  interval?: number;
  lastRunAgo?: number;
  /** The address it last wrote, when not the node's current one. */
  wrote?: string;
  error?: string;
}

const SEEDS: Seed[] = [
  { name: "home-v4", node: "[cd]-homeserver", domains: ["home.roobli.org", "nas.roobli.org"], interval: 300, lastRunAgo: 3 * DAY },
  { name: "home-v6", node: "[cd]-homeserver", domains: ["home.roobli.org"], v4: false, v6: true, interval: 300, lastRunAgo: 3 * DAY },
  { name: "hkbn-hub-v4", node: "[cd]-hkbn-hub", domains: ["hub.roobli.org"], interval: 300, lastRunAgo: 11 * DAY },
  {
    name: "hkbn-hub-v6",
    node: "[cd]-hkbn-hub",
    domains: ["hub.roobli.org"],
    v4: false,
    v6: true,
    interval: 300,
    lastRunAgo: 3 * HOUR,
    wrote: "",
    error: "AAAA hub.roobli.org: cloudflare: 401 Unauthorized: the API token lacks Zone.DNS edit on roobli.org",
  },
  { name: "nas-home", node: "[cd]-nas-home", domains: ["files.roobli.org"], interval: 900, lastRunAgo: 27 * DAY },
  { name: "mac-air", node: "[cd]-mac-air", domains: ["air.roobli.org"], interval: 300, lastRunAgo: 4 * HOUR },
  { name: "dmit-lax", node: "[cd]-DMIT-pro-malibu", domains: ["lax.roobli.org", "proxy-lax.roobli.org"], interval: 300, lastRunAgo: 2 * DAY + 5 * HOUR, wrote: "203.0.113.200" },
  { name: "xuezhang-jp", node: "[cd]-xuezhang-jp-NAT", domains: ["jp-nat.roobli.org"], interval: 300, lastRunAgo: 6 * DAY },
  { name: "softbank-nat", node: "[Metix]-Aaitr-jp-softbank-NAT", domains: ["sb.metix.example"], interval: 300, lastRunAgo: 19 * DAY },
  { name: "metix-dmit-4", node: "[Metix]-DMIT-4", domains: ["dmit4.metix.example"], interval: 3600, lastRunAgo: 40 * DAY },
  { name: "metix-dmit-1", node: "[Metix]-DMIT-1", domains: ["dmit1.metix.example"], interval: 43200, lastRunAgo: 120 * DAY },
  { name: "metix-dmit-2", node: "[Metix]-DMIT-2", domains: ["dmit2.metix.example"], interval: 43200, lastRunAgo: 120 * DAY },
  { name: "metix-dmit-3", node: "[Metix]-DMIT-3", domains: ["dmit3.metix.example"], interval: 43200, lastRunAgo: 96 * DAY },
  { name: "metix-nyc", node: "[Metix]-Racknerd-NYC", domains: ["nyc.metix.example"], interval: 86400, lastRunAgo: 88 * DAY },
  { name: "metix-la", node: "[Metix]-Racknerd-LA", domains: ["la.metix.example"], interval: 86400, lastRunAgo: 88 * DAY },
  { name: "metix-fsn", node: "[Metix]-Hetzner-FSN", domains: ["fsn.metix.example"], v6: true, interval: 86400, lastRunAgo: 150 * DAY },
  { name: "cd-fsn", node: "[cd]-hetzner-fsn", domains: ["fsn.roobli.org"], v6: true, interval: 21600, lastRunAgo: 150 * DAY },
  { name: "cd-syd", node: "[cd]-vultr-syd", domains: ["syd.roobli.org"], interval: 21600, lastRunAgo: 60 * DAY },
  { name: "cd-sgp", node: "[cd]-linode-sgp", domains: ["sgp.roobli.org"], interval: 21600, lastRunAgo: 60 * DAY },
  {
    name: "openjobs-scripts",
    node: "[OpenJobs-Data]-scripts",
    domains: ["scripts.openjobs.example"],
    provider: "webhook",
    interval: 900,
    lastRunAgo: 9 * MINUTE,
    error: "A scripts.openjobs.example: webhook POST https://hooks.openjobs.example/ddns: 502 Bad Gateway",
  },
  { name: "tidb-1", node: "[OpenJobs-Data]-TiDB-1", domains: ["tidb.openjobs.example"], provider: "webhook", interval: 900, lastRunAgo: 33 * DAY },
  { name: "turin-mini", node: "gomami-hk-turin-mini", domains: ["turin.roobli.org"], interval: 300, lastRunAgo: 8 * DAY },
];

function seedToView(seed: Seed, index: number): DDNSView {
  const node = nodeByName(seed.node);
  const v4 = seed.v4 ?? true;
  const v6 = seed.v6 ?? false;
  const provider = seed.provider ?? "cloudflare";
  return {
    id: `ddns_${String(index + 1).padStart(3, "0")}`,
    name: seed.name,
    node_id: node.id,
    provider,
    domains: seed.domains,
    enable_ipv4: v4,
    enable_ipv6: v6,
    max_retries: 3,
    ttl: 60,
    interval_seconds: seed.interval,
    has_credential: true,
    webhook_url: provider === "webhook" ? "https://hooks.openjobs.example/ddns" : undefined,
    webhook_method: provider === "webhook" ? "POST" : undefined,
    last_ipv4: v4 ? (seed.wrote ?? node.public_ip) : undefined,
    last_ipv6: v6 && seed.wrote !== "" ? node.public_ipv6 : undefined,
    last_run_at: seed.lastRunAgo === undefined ? undefined : iso(-seed.lastRunAgo),
    last_error: seed.error,
    created_at: iso(-200 * DAY),
    updated_at: iso(-30 * DAY),
  };
}

export const DDNS: DDNSView[] = flags.get("ddns") === "empty" ? [] : SEEDS.map(seedToView);

/** What a run writes: the node's current addresses, or a 502 under ?run=fail. */
export function runDdns(id: string): DDNSView {
  const profile = DDNS.find((entry) => entry.id === id);
  if (!profile) throw new Error("ddns profile not found");
  const node = NODES.find((entry) => entry.id === profile.node_id);
  profile.last_run_at = iso(0);
  if (flags.get("run") === "fail") {
    profile.last_error = `A ${profile.domains[0]}: cloudflare: 403 Forbidden: zone roobli.org is locked`;
    throw Object.assign(new Error(profile.last_error), { failed: true });
  }
  if (profile.enable_ipv4 && node?.public_ip) profile.last_ipv4 = node.public_ip;
  if (profile.enable_ipv6 && node?.public_ipv6) profile.last_ipv6 = node.public_ipv6;
  profile.last_error = undefined;
  return { ...profile };
}

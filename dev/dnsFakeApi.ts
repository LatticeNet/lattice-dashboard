/**
 * An in-memory stand-in for `@/lib/api`, wired in by vite.harness.config.ts
 * through a resolve alias so the production config and bundle never see it.
 *
 *   LATTICE_HARNESS=dns pnpm exec vite --config vite.harness.config.ts
 *   open http://127.0.0.1:5185/dev/dns.html          (Self-host DNS)
 *   open http://127.0.0.1:5185/dev/geo-routing.html  (Geo-Routing)
 *   open http://127.0.0.1:5185/dev/tunnels.html      (Tunnels)
 *   open http://127.0.0.1:5185/dev/monitoring.html   (Monitoring)
 *
 * The four pages are here together because they are one story: a resolver
 * Lattice only watches, the certificate watch that is the point of watching
 * it, the one neighbouring page that can be shown working with a demo, and the
 * one that cannot be shown working at all.
 *
 * The fixture is the production shape, not invented traffic. dns.roobli.org
 * really is dnsproxy on [cd]-DMIT-pro-malibu holding udp/tcp 53, tcp 2053 and
 * tcp 8443, with a certificate reported as expiring 2026-11-17, and the fleet
 * really does run unbound on [cd]-xuezhang-jp-NAT. The drift row is the one
 * deliberate departure: it is the state a page cannot be checked without.
 */
import type {
  DNSDeploymentView,
  GeoRouting,
  GeoRoutingPlanView,
  MonitorResult,
  MonitorView,
  Node,
  Principal,
} from "@/lib/api/index";

export * from "@/lib/api/index";

const NOW = Date.parse("2026-09-04T13:00:00Z");
const LATENCY_MS = 60;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function iso(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}

function delay<T>(value: T, ms = LATENCY_MS): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

interface FleetEntry {
  id: string;
  name: string;
  ip: string;
  country: string;
  lat: number;
  lon: number;
}

const FLEET: FleetEntry[] = [
  { id: "node_ob46mh4ltshdpkhc", name: "[cd]-DMIT-pro-malibu", ip: "154.17.12.165", country: "US", lat: 34.0522, lon: -118.2437 },
  { id: "node_pk6zjl4rf6cpmzgz", name: "[Metix]-VIRCS-ATT-VDS", ip: "12.22.163.232", country: "US", lat: 33.6839, lon: -117.7947 },
  { id: "xuezhang-jp", name: "[cd]-xuezhang-jp-NAT", ip: "126.66.31.1", country: "JP", lat: 35.6549, lon: 139.6946 },
  { id: "dmit-1", name: "[Metix]-DMIT-1", ip: "64.186.230.101", country: "US", lat: 34.0522, lon: -118.2437 },
  { id: "dmit-eb-wee", name: "[cd]-DMIT-eb-wee", ip: "154.17.233.187", country: "US", lat: 42.6526, lon: -73.7562 },
  { id: "gomami-jpn", name: "[Metix]-gomami-jp-pulse-mini", ip: "103.112.1.30", country: "JP", lat: 35.6549, lon: 139.6946 },
  { id: "legend-sg", name: "[cd]-LegendVPS-SG-EVO", ip: "77.93.91.41", country: "SG", lat: 1.3554, lon: 103.8677 },
];

const nodes: Node[] = FLEET.map((entry) => ({
  id: entry.id,
  name: entry.name,
  public_ip: entry.ip,
  online: true,
  status: "online",
  agent_version: "0.3.9-alpha.8",
  last_seen: iso(-30_000),
  geo: { country: entry.country, lat: entry.lat, lon: entry.lon, source: "auto" },
})) as unknown as Node[];

// ── DNS ───────────────────────────────────────────────────────────────────
//
// Three rows, one per thing the page has to be able to say: a daemon it
// watches and agrees with, a daemon it watches and disagrees with, and a
// deployment of its own waiting for an approval.
const deployments: DNSDeploymentView[] = [
  {
    id: "dns_observed_malibu",
    name: "roobli public resolver",
    node_id: "node_ob46mh4ltshdpkhc",
    node_name: "[cd]-DMIT-pro-malibu",
    engine: "external",
    listen_port: 53,
    enable_udp: true,
    enable_tcp: true,
    exposure: "public",
    zones: [],
    hostname: "dns.roobli.org",
    listeners: [
      { protocol: "tcp", port: 53, process: "dnsproxy" },
      { protocol: "udp", port: 53, process: "dnsproxy" },
      { protocol: "tcp", port: 2053, process: "dnsproxy" },
      { protocol: "tcp", port: 8443, process: "dnsproxy" },
    ],
    cert_not_after: "2026-11-17T00:00:00Z",
    drift: {
      status: "ok",
      findings: [],
      reality_collected_at: iso(-4 * MINUTE),
    },
    publish_ipv4: false,
    publish_ipv6: false,
    has_credential: false,
    status: "observed",
    created_at: iso(-9 * DAY),
    updated_at: iso(-9 * DAY),
  },
  {
    id: "dns_observed_xuezhang",
    name: "xuezhang lan resolver",
    node_id: "xuezhang-jp",
    node_name: "[cd]-xuezhang-jp-NAT",
    engine: "external",
    listen_port: 53,
    enable_udp: true,
    enable_tcp: true,
    exposure: "public",
    zones: [],
    hostname: "resolver.xuezhang.example",
    listeners: [
      { protocol: "udp", port: 53, process: "unbound" },
      { protocol: "tcp", port: 53, process: "unbound" },
      { protocol: "tcp", port: 6053, process: "dnsproxy" },
    ],
    cert_not_after: "2026-09-19T00:00:00Z",
    drift: {
      status: "drift",
      findings: [
        "tcp/6053 is not listening on [cd]-xuezhang-jp-NAT (reality collected 2026-09-04T12:41:00Z)",
        "udp/53 on [cd]-xuezhang-jp-NAT is owned by dnsproxy, recorded as unbound",
      ],
      reality_collected_at: iso(-19 * MINUTE),
    },
    publish_ipv4: false,
    publish_ipv6: false,
    has_credential: false,
    status: "observed",
    created_at: iso(-3 * DAY),
    updated_at: iso(-3 * DAY),
  },
  {
    id: "dns_coredns_vircs",
    name: "lattice-internal",
    node_id: "node_pk6zjl4rf6cpmzgz",
    node_name: "[Metix]-VIRCS-ATT-VDS",
    engine: "coredns",
    engine_version: "1.11.3",
    listen_port: 53,
    enable_udp: true,
    enable_tcp: true,
    exposure: "public",
    zones: [
      { suffix: "lattice.internal", mode: "static", records: [{ name: "gate", type: "A", value: "10.20.0.1", ttl: 300 }] },
    ],
    publish_ipv4: false,
    publish_ipv6: false,
    has_credential: false,
    status: "pending",
    created_at: iso(-2 * HOUR),
    updated_at: iso(-2 * HOUR),
  },
];

// ── Geo-routing ───────────────────────────────────────────────────────────
//
// The demo, and nothing else, so the first-run explanation is on screen.
const geoRoutings: GeoRouting[] = [
  {
    id: "geo_demo_preview",
    name: "demo-geo-preview",
    hostname: "demo-geo.invalid",
    node_ids: ["dmit-1", "dmit-eb-wee", "gomami-jpn", "legend-sg"],
    dns_node_ids: ["node_pk6zjl4rf6cpmzgz"],
    ttl: 60,
    strategy: "geoip",
    status: "configured",
    created_at: iso(-40 * MINUTE),
    updated_at: iso(-40 * MINUTE),
  },
];

/**
 * The production render of the demo record, copied from a live
 * POST /api/geo-routing/plan rather than invented: the same SHA, the same
 * continent grouping (the fleet is AS and NA, so AF, AN and OC fall to
 * Singapore and SA to Albany), and the same views. Only the warnings are the
 * harness's own, because the live render emitted none and the empty case is
 * already covered by every other page.
 */
const geoPlan: GeoRoutingPlanView = {
  geo_routing_id: "geo_demo_preview",
  hostname: "demo-geo.invalid",
  strategy: "geoip",
  sha256: "b41f0e5025e19eebccb96b9a7b54bba6bf8daeb3ae264d5809b6aa9fdf4939d9",
  warnings: [
    "no self-host DNS deployment runs on [Metix]-VIRCS-ATT-VDS, so nothing would load this zone today",
  ],
  continent_choice: {
    AF: "legend-sg",
    AN: "legend-sg",
    AS: "gomami-jpn",
    EU: "dmit-eb-wee",
    NA: "dmit-1",
    OC: "legend-sg",
    SA: "dmit-eb-wee",
  },
  config: `demo-geo.invalid {
    geoip /etc/coredns/GeoLite2-City.mmdb
    metadata
    view geo_af_an_oc {
        expr metadata('geoip/continent/code') == 'AF' || metadata('geoip/continent/code') == 'AN' || metadata('geoip/continent/code') == 'OC'
    }
    hosts {
        ttl 60
        77.93.91.41 demo-geo.invalid
        2a14:7dc0:102:10a5::2f demo-geo.invalid
        no_reverse
        fallthrough
    }
}
demo-geo.invalid {
    geoip /etc/coredns/GeoLite2-City.mmdb
    metadata
    view geo_as {
        expr metadata('geoip/continent/code') == 'AS'
    }
    hosts {
        ttl 60
        103.112.1.30 demo-geo.invalid
        no_reverse
        fallthrough
    }
}
demo-geo.invalid {
    geoip /etc/coredns/GeoLite2-City.mmdb
    metadata
    view geo_eu_sa {
        expr metadata('geoip/continent/code') == 'EU' || metadata('geoip/continent/code') == 'SA'
    }
    hosts {
        ttl 60
        154.17.233.187 demo-geo.invalid
        2605:52c0:1:df3:1cb4:1fff:fe8d:56b8 demo-geo.invalid
        no_reverse
        fallthrough
    }
}
demo-geo.invalid {
    geoip /etc/coredns/GeoLite2-City.mmdb
    metadata
    view geo_na {
        expr metadata('geoip/continent/code') == 'NA'
    }
    hosts {
        ttl 60
        64.186.230.101 demo-geo.invalid
        2605:52c0:2:4d94:be24:11ff:fe26:850d demo-geo.invalid
        no_reverse
        fallthrough
    }
}
`,
};

// ── Monitors ──────────────────────────────────────────────────────────────
const monitors: MonitorView[] = [
  {
    id: "mon_tls_dns",
    name: "dns.roobli.org certificate",
    type: "tls",
    target: "dns.roobli.org:8443",
    interval_sec: 3600,
    timeout_sec: 10,
    threshold_days: 30,
    assign_all: false,
    enabled: true,
    created_at: iso(-6 * DAY),
    updated_at: iso(-6 * DAY),
  },
  {
    id: "mon_tcp_dns",
    name: "dns.roobli.org plain DNS",
    type: "tcp",
    target: "154.17.12.165:53",
    interval_sec: 60,
    timeout_sec: 5,
    assign_all: false,
    node_ids: ["dmit-1", "gomami-jpn"],
    enabled: true,
    created_at: iso(-6 * DAY),
    updated_at: iso(-6 * DAY),
  },
];

/** A tls result carries no node: the control plane dialled the endpoint itself. */
function tlsResults(): MonitorResult[] {
  return Array.from({ length: 24 }, (_, index) => ({
    monitor_id: "mon_tls_dns",
    node_id: "",
    at: iso(-(24 - index) * HOUR),
    success: true,
    latency_ms: 118 + ((index * 7) % 23),
    cert_not_after: "2026-11-17T00:00:00Z",
  }));
}

function tcpResults(): MonitorResult[] {
  return Array.from({ length: 24 }, (_, index) => {
    const failing = index === 9 || index === 10;
    return {
      monitor_id: "mon_tcp_dns",
      node_id: index % 2 === 0 ? "dmit-1" : "gomami-jpn",
      at: iso(-(24 - index) * 5 * MINUTE),
      success: !failing,
      latency_ms: failing ? 0 : 41 + ((index * 13) % 60),
      ...(failing ? { error: "dial tcp 154.17.12.165:53: i/o timeout" } : {}),
    };
  });
}

const principal: Principal = {
  actor_id: "cdcd",
  username: "cdcd",
  scopes: [
    "node:read",
    "node:admin",
    "dns:admin",
    "network:plan",
    "geo:read",
    "geo:admin",
    "tunnel:admin",
    "monitor:read",
    "monitor:admin",
    "approval:read",
  ],
  server_allowlist: [],
  csrf_token: "harness",
};

export const api = {
  auth: {
    me: () => delay(principal),
  },
  nodes: {
    list: () => delay({ nodes: nodes.map((n) => ({ ...n })) }),
  },
  dns: {
    deployments: () => delay({ deployments: deployments.map((d) => ({ ...d })) }),
  },
  geoRouting: {
    list: () => delay({ geo_routings: geoRoutings.map((g) => ({ ...g })) }),
    plan: () => delay(geoPlan, 260),
  },
  // The honest answer for this page: nothing, because nothing can be
  // demonstrated here without installing cloudflared on a node.
  tunnels: {
    list: () => delay([]),
  },
  monitors: {
    list: () => delay({ monitors: monitors.map((m) => ({ ...m })) }),
    results: (monitor_id: string) =>
      delay({ results: monitor_id === "mon_tls_dns" ? tlsResults() : tcpResults() }),
  },
  approvals: {
    list: () => delay({ approvals: [] }),
  },
} as unknown as typeof import("@/lib/api/index").api;

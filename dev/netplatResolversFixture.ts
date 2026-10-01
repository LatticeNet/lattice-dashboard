/**
 * Self-host DNS, Tunnels and Geo-Routing fixtures for the netplat harness.
 *
 * Production on 2026-09-30 held 0 DNS deployments and 0 tunnels, which is
 * the default here. Geo-Routing's default is the one demo record the old dns
 * harness rendered (its count is not in FACTS).
 *
 *   ?dns=dense      the three rows the dns harness proved (dnsproxy watched on
 *                   [cd]-DMIT-pro-malibu, unbound watched and drifted on
 *                   [cd]-xuezhang-jp-NAT, CoreDNS pending on
 *                   [Metix]-VIRCS-ATT-VDS) plus a CoreDNS that failed to apply
 *                   and publish (invented)
 *   ?tunnels=dense  three tunnels (invented), one bound to the offline
 *                   [cd]-homeserver and one to a node id the fleet lacks
 *   ?geo=empty      no routing; ?geo=dense adds a routing that applied and one
 *                   that failed (invented)
 *
 * Certificate dates are relative to now, so the expired and soon cases stay
 * expired and soon.
 */
import type { DNSDeploymentView, GeoRouting, GeoRoutingPlanView, MonitorView, TunnelView } from "@/lib/api/index";

import { DAY, HOUR, MINUTE, flags, iso, nodeByName } from "./netplatFixture";

const malibu = nodeByName("[cd]-DMIT-pro-malibu");
const xuezhang = nodeByName("[cd]-xuezhang-jp-NAT");
const vircs = nodeByName("[Metix]-VIRCS-ATT-VDS");
const hetzner = nodeByName("[cd]-hetzner-fsn");

export const DNS_DEPLOYMENTS: DNSDeploymentView[] =
  flags.get("dns") === "dense"
    ? [
        {
          id: "dns_observed_malibu",
          name: "roobli public resolver",
          node_id: malibu.id,
          node_name: malibu.name,
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
          cert_not_after: iso(47 * DAY),
          drift: { status: "ok", findings: [], reality_collected_at: iso(-4 * MINUTE) },
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
          node_id: xuezhang.id,
          node_name: xuezhang.name,
          engine: "external",
          listen_port: 53,
          enable_udp: true,
          enable_tcp: true,
          exposure: "mesh",
          zones: [
            { suffix: "xuezhang.example", mode: "forward", upstreams: ["10.10.0.1"] },
            { suffix: "ads.example", mode: "block" },
          ],
          hostname: "resolver.xuezhang.example",
          listeners: [
            { protocol: "udp", port: 53, process: "unbound" },
            { protocol: "tcp", port: 53, process: "unbound" },
            { protocol: "tcp", port: 6053, process: "dnsproxy" },
          ],
          cert_not_after: iso(-12 * DAY),
          drift: {
            status: "drift",
            findings: [
              "tcp/6053 is not listening on [cd]-xuezhang-jp-NAT",
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
          node_id: vircs.id,
          node_name: vircs.name,
          engine: "coredns",
          engine_version: "1.11.3",
          listen_port: 53,
          enable_udp: true,
          enable_tcp: true,
          exposure: "public",
          zones: [{ suffix: "lattice.internal", mode: "static", records: [{ name: "gate", type: "A", value: "10.20.0.1", ttl: 300 }] }],
          publish_ipv4: false,
          publish_ipv6: false,
          has_credential: false,
          status: "pending",
          created_at: iso(-2 * HOUR),
          updated_at: iso(-2 * HOUR),
        },
        {
          id: "dns_coredns_fsn",
          name: "edge-fsn",
          node_id: hetzner.id,
          node_name: hetzner.name,
          engine: "coredns",
          engine_version: "1.11.3",
          listen_port: 53,
          enable_udp: true,
          enable_tcp: false,
          exposure: "public",
          zones: [{ suffix: "edge.roobli.org", mode: "forward", upstreams: ["1.1.1.1", "8.8.8.8"] }],
          hostname: "ns-fsn.roobli.org",
          publish_ipv4: true,
          publish_ipv6: true,
          has_credential: true,
          status: "failed",
          last_error: "apply: coredns -conf /etc/coredns/Corefile: plugin/forward: no nameservers found",
          last_published_at: iso(-6 * DAY),
          last_ipv4: "203.0.113.200",
          last_ipv6: "2001:db8:16::9",
          last_publish_error: "cloudflare: 403 Forbidden: Authentication error (code 10000)",
          created_at: iso(-30 * DAY),
          updated_at: iso(-1 * DAY),
        },
      ]
    : [];

export const MONITORS: MonitorView[] = [
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
].filter(() => flags.get("dns") === "dense") as MonitorView[];

const homeserver = nodeByName("[cd]-homeserver");

export const TUNNELS: TunnelView[] =
  flags.get("tunnels") === "dense"
    ? [
        {
          id: "tun_nas",
          name: "nas-web",
          node_id: nodeByName("[cd]-nas-home").id,
          tunnel_id: "6f1c2d3e-4b5a-6978-8a9b-0c1d2e3f4a5b",
          credentials_file: "/etc/cloudflared/6f1c2d3e-4b5a-6978-8a9b-0c1d2e3f4a5b.json",
          ingress: [
            { hostname: "files.roobli.org", service: "http://localhost:8088" },
            { hostname: "photos.roobli.org", service: "http://localhost:2342", path: "/share" },
          ],
          created_at: iso(-20 * DAY),
          updated_at: iso(-20 * DAY),
        },
        {
          id: "tun_home",
          name: "homeserver-ssh",
          node_id: homeserver.id,
          tunnel_id: "home-ssh",
          ingress: [{ hostname: "ssh-home.roobli.org", service: "ssh://localhost:22" }],
          created_at: iso(-11 * DAY),
          updated_at: iso(-11 * DAY),
        },
        {
          id: "tun_gone",
          name: "old-grafana",
          node_id: "node_retired_7k2",
          tunnel_id: "grafana-old",
          ingress: [{ hostname: "grafana.roobli.org", service: "http://localhost:3000" }],
          created_at: iso(-90 * DAY),
          updated_at: iso(-90 * DAY),
        },
      ]
    : [];

const GEO_MODE = flags.get("geo");

export const GEO_ROUTINGS: GeoRouting[] =
  GEO_MODE === "empty"
    ? []
    : [
        {
          id: "geo_demo_preview",
          name: "demo-geo-preview",
          hostname: "demo-geo.invalid",
          node_ids: [nodeByName("[Metix]-DMIT-1").id, nodeByName("[Metix]-Hetzner-FSN").id, nodeByName("[cd]-aws-tokyo").id, nodeByName("[cd]-linode-sgp").id],
          dns_node_ids: [vircs.id],
          ttl: 60,
          strategy: "geoip",
          status: "configured",
          last_applied_at: "0001-01-01T00:00:00Z",
          created_at: iso(-40 * MINUTE),
          updated_at: iso(-40 * MINUTE),
        },
        ...(GEO_MODE === "dense"
          ? [
              {
                id: "geo_apex",
                name: "apex-edge",
                hostname: "edge.roobli.org",
                node_ids: [malibu.id, nodeByName("[cd]-hetzner-hel").id, nodeByName("[cd]-aws-tokyo").id],
                dns_node_ids: [hetzner.id],
                ttl: 60,
                strategy: "geoip",
                status: "configured",
                last_rendered_sha: "c0ffee1234",
                last_applied_at: iso(-2 * DAY),
                created_at: iso(-12 * DAY),
                updated_at: iso(-2 * DAY),
              },
              {
                id: "geo_cdn",
                name: "cdn-failover",
                hostname: "cdn.roobli.org",
                node_ids: [nodeByName("[cd]-vultr-syd").id, homeserver.id],
                dns_node_ids: [hetzner.id],
                ttl: 30,
                strategy: "all-healthy",
                status: "error",
                last_error: "render: no participating node has a public IP and reports online",
                last_applied_at: "0001-01-01T00:00:00Z",
                created_at: iso(-5 * DAY),
                updated_at: iso(-3 * HOUR),
              },
            ]
          : []),
      ];

export function geoPlan(id: string): GeoRoutingPlanView {
  const routing = GEO_ROUTINGS.find((entry) => entry.id === id) ?? GEO_ROUTINGS[0]!;
  return {
    geo_routing_id: routing.id,
    hostname: routing.hostname,
    strategy: routing.strategy,
    sha256: "b41f0e5025e19eebccb96b9a7b54bba6bf8daeb3ae264d5809b6aa9fdf4939d9",
    warnings: [`no self-host DNS deployment runs on ${vircs.name}, so nothing would load this zone today`],
    continent_choice: { AS: "[cd]-aws-tokyo", EU: "[Metix]-Hetzner-FSN", NA: "[Metix]-DMIT-1", OC: "[cd]-linode-sgp" },
    config: `${routing.hostname} {\n    geoip /etc/coredns/GeoLite2-City.mmdb\n    metadata\n}\n`,
  };
}

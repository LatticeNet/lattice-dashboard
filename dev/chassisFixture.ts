/**
 * Production-shaped fixture for the chassis gallery (FACTS.md, 2026-09-30):
 * 34 nodes, 32 online, four agent versions, owner tags cd and Metix.
 *
 * Invented, and marked as such: the ids, the addresses (documentation ranges
 * 203.0.113.0/24 and 198.51.100.0/24), which two nodes are offline, how the
 * four agent versions split across the fleet, and the CPU figures. The names
 * are the fleet's own, from the SSH Guard fixture.
 */
export interface GalleryNode {
  id: string;
  name: string;
  status: "online" | "offline" | "degraded";
  ip: string;
  agent: string;
  lastSeenSec: number;
  cpu: number | null;
  tags: string[];
}

const NAMES = [
  "[cd]-Aaitr-ATT-VDS", "[Metix]-Vultr-SG", "[Metix]-Racknerd-NYC", "[cd]-gomami-hkg", "[cd]-Linode-OSA",
  "[cd]-V.PS-TYO", "[cd]-Netcup-VIE", "[cd]-Hetzner-FSN-1", "[cd]-GreenCloud-SG", "[cd]-HostHatch-HK",
  "[Metix]-Contabo-NUE", "[Metix]-DMIT-1", "[Metix]-Racknerd-LA-2", "[Metix]-Oracle-KIX-arm", "[Metix]-Linode-SIN",
  "[cd]-Contabo-SEA", "[Metix]-Aeza-AMS", "[cd]-homeserver", "[Metix]-Aeza-SWE", "[Metix]-CloudCone-LA",
  "[Metix]-OVH-GRA", "[Metix]-DMIT-2", "[cd]-BWH-CN2GIA", "[Metix]-Vultr-NRT", "[cd]-Oracle-ICN-x86",
  "[cd]-BWH-DC9", "[cd]-Hetzner-HEL-1", "[cd]-GreenCloud-Tokyo", "[cd]-HostHatch-VIE", "[cd]-DO-SFO3",
  "[cd]-Kuroit-LON", "[cd]-Zgovps-HK-BGP", "[cd]-Aaitr-LAX", "[Metix]-DMIT-4",
];

/** Four versions, most nodes current (invented split). */
function agentFor(index: number): string {
  if (index % 11 === 3) return "0.3.6";
  if (index % 7 === 5) return "0.3.8";
  if (index === 17) return "0.3.3";
  return "0.3.9";
}

export const GALLERY_NODES: GalleryNode[] = NAMES.map((name, index) => {
  const offline = name === "[Metix]-DMIT-4" || name === "[cd]-homeserver";
  const hex = ((index + 1) * 0x9e3779b1 >>> 0).toString(16).padStart(8, "0").slice(0, 8);
  return {
    id: `node_${hex}`,
    name,
    status: offline ? "offline" : "online",
    ip: index % 2 === 0 ? `203.0.113.${10 + index}` : `198.51.100.${40 + index}`,
    agent: agentFor(index),
    lastSeenSec: offline ? (name === "[Metix]-DMIT-4" ? 6 * 86_400 : 41 * 60) : 2 + (index % 9),
    cpu: offline ? null : 3 + ((index * 7) % 61),
    tags: [name.startsWith("[Metix]") ? "Metix" : "cd", ...(index % 3 === 0 ? ["VDS"] : []), ...(index % 5 === 0 ? ["HOME"] : [])],
  };
});

/** A deleted node's id, for the NodeLabel and sheet `gone` cases. */
export const GONE_NODE_ID = "node_deadbeef00ff";

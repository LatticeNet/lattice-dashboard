/**
 * The four official plugins as production ran them on 2026-09-30 (FACTS):
 * netguard 0.1.0, sub-store 0.14.0-alpha.1, vpn-core 0.9.0-alpha.1,
 * wireguard 0.1.0, all active. Ids, capabilities and contributed pages come
 * from the plugins' manifests. Digests, timestamps and runtime messages are
 * invented. `?plugins=failed` stops vpn-core's runner with an error and
 * disables wireguard; `?plugins=empty` installs none.
 */
import type { PluginInstallationView, PluginView } from "@/lib/api/index";

import { DAY, HOUR, flags, iso } from "./netplatFixture";

interface Seed {
  id: string;
  name: string;
  version: string;
  capabilities: string[];
  pages: Array<[string, string]>;
  interfaces: string[];
  sha: string;
  activatedDaysAgo: number;
}

const SEEDS: Seed[] = [
  {
    id: "latticenet.netguard",
    name: "NetGuard (nftables security groups)",
    version: "0.1.0",
    capabilities: ["node:read", "network:plan", "network:apply", "task:run"],
    pages: [["firewall", "NetGuard"]],
    interfaces: ["latticenet.netguard/firewall"],
    sha: "3f9a1c0b7e2d4a5f8c6b9d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c",
    activatedDaysAgo: 21,
  },
  {
    id: "latticenet.sub-store",
    name: "Sub-Store companion",
    version: "0.14.0-alpha.1",
    capabilities: ["rpc:call", "http:egress", "http:operator-target", "kv:read", "kv:write", "subscription:serve"],
    pages: [["sub-store", "Sub-Store"]],
    interfaces: ["latticenet.sub-store/engine", "latticenet.sub-store/subscription", "latticenet.sub-store/shares"],
    sha: "a07c55e1d2b3c4f5061728394a5b6c7d8e9f00112233445566778899aabbccdd",
    activatedDaysAgo: 1,
  },
  {
    id: "latticenet.vpn-core",
    name: "vpn-core (sing-box)",
    version: "0.9.0-alpha.1",
    capabilities: ["node:read", "network:plan", "network:apply", "task:run"],
    pages: [
      ["lines", "Lines"],
      ["users", "Users"],
      ["profiles", "Node Profiles"],
      ["usage", "Usage"],
    ],
    interfaces: ["latticenet.vpn-core/nodes", "latticenet.vpn-core/lines", "latticenet.vpn-core/users", "latticenet.vpn-core/usage"],
    sha: "5d2e8f7a6b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e",
    activatedDaysAgo: 3,
  },
  {
    id: "latticenet.wireguard",
    name: "WireGuard (VPN networks)",
    version: "0.1.0",
    capabilities: ["node:read", "network:plan", "network:apply", "task:run"],
    pages: [["networks", "WireGuard"]],
    interfaces: ["latticenet.wireguard/networks"],
    sha: "c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6",
    activatedDaysAgo: 21,
  },
];

const MODE = flags.get("plugins");

function statusOf(seed: Seed): string {
  if (MODE === "failed" && seed.id === "latticenet.wireguard") return "disabled";
  return "active";
}

export const PLUGIN_INSTALLS: PluginInstallationView[] =
  MODE === "empty"
    ? []
    : SEEDS.map((seed) => {
        const status = statusOf(seed);
        const failed = MODE === "failed" && seed.id === "latticenet.vpn-core";
        return {
          id: seed.id,
          name: seed.name,
          type: "system",
          version: seed.version,
          entrypoint: "plugin.wasm",
          publisher: "latticenet",
          capabilities: seed.capabilities,
          artifact_sha256: seed.sha,
          available: true,
          status,
          runtime:
            status === "active"
              ? {
                  plugin_id: seed.id,
                  state: failed ? "failed" : "armed",
                  runner: "wasm",
                  message: failed ? "runner exited: wasm trap: out of bounds memory access in users.list" : undefined,
                  started_at: iso(-seed.activatedDaysAgo * DAY),
                  updated_at: iso(failed ? -2 * HOUR : -seed.activatedDaysAgo * DAY),
                }
              : {
                  plugin_id: seed.id,
                  state: "stopped",
                  runner: "wasm",
                  stopped_at: iso(-5 * HOUR),
                  updated_at: iso(-5 * HOUR),
                },
          verified_at: iso(-seed.activatedDaysAgo * DAY - HOUR),
          installed_at: iso(-seed.activatedDaysAgo * DAY - 30 * 60_000),
          activated_at: iso(-seed.activatedDaysAgo * DAY),
          disabled_at: status === "disabled" ? iso(-5 * HOUR) : undefined,
          created_at: iso(-60 * DAY),
          updated_at: iso(-seed.activatedDaysAgo * DAY),
        };
      });

export function pluginViews(): PluginView[] {
  return PLUGIN_INSTALLS.map((install) => {
    const seed = SEEDS.find((entry) => entry.id === install.id)!;
    const active = install.status === "active";
    return {
      id: install.id,
      name: install.name,
      type: install.type,
      version: install.version,
      publisher: install.publisher,
      capabilities: install.capabilities,
      status: install.status,
      active,
      ui: active
        ? {
            nav: seed.pages.map(([route, title]) => ({ section: "extensions", title, route })),
            views: seed.pages.map(([route, title]) => ({ route, title, kind: "sandbox" })),
          }
        : undefined,
      interfaces: seed.interfaces.map((service) => ({ service, methods: [] })),
    };
  });
}

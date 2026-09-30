/**
 * An in-memory stand-in for `@/lib/api`, wired in by vite.harness.config.ts
 * through a resolve alias so the production config and bundle never see it.
 *
 *   LATTICE_HARNESS=netplat pnpm exec vite --config vite.harness.config.ts
 *   open http://127.0.0.1:5185/dev/netplat-ddns.html
 *
 * The pages of design 23, sections 4.4 to 4.6, that had no harness. Only the
 * calls those pages make are implemented; anything else throws, loudly, so a
 * new call path is noticed rather than silently fed nothing.
 *
 * Fixture switches, on the page's query string:
 *
 *   ?fail=ddns,nodes  the named reads answer 502 (a failed read shows no counts)
 *   ?ddns=empty       no DDNS profiles
 *   ?run=fail         a DDNS run answers 502 and records the error
 *   ?slow             every write takes 1.5 s, to see a confirm's pending state
 */
import { ApiError } from "@/lib/api/client";
import type { DDNSUpsertRequest, DDNSView, Principal } from "@/lib/api/index";

import { DDNS, runDdns } from "./netplatDdnsFixture";
import { NODES, delay, flags, iso } from "./netplatFixture";

export * from "@/lib/api/index";

const FAILING = new Set((flags.get("fail") ?? "").split(",").filter(Boolean));
const WRITE_MS = flags.has("slow") ? 1500 : 200;

function read<T>(name: string, value: () => T): Promise<T> {
  if (FAILING.has(name)) {
    return new Promise((_, reject) =>
      setTimeout(() => reject(new ApiError(502, "bad_gateway", `502 Bad Gateway from lattice.roobli.org (${name})`)), 120),
    );
  }
  return delay(value());
}

const principal: Principal = {
  actor_id: "cdcd",
  username: "cdcd",
  scopes: flags.has("readonly") ? ["node:read", "ddns:read"] : ["*"],
  server_allowlist: [],
  csrf_token: "harness",
};

let seq = 100;

export const api = {
  auth: {
    me: () => delay(principal),
  },
  nodes: {
    list: () => read("nodes", () => ({ nodes: NODES.map((node) => ({ ...node })) })),
  },
  ddns: {
    list: () => read("ddns", () => DDNS.map((profile) => ({ ...profile }))),
    save: async (input: DDNSUpsertRequest) => {
      await delay(undefined, WRITE_MS);
      const existing = DDNS.find((profile) => profile.id === input.id);
      const next: DDNSView = {
        ...(existing ?? {
          id: `ddns_new_${seq++}`,
          has_credential: false,
          created_at: iso(0),
        }),
        name: input.name,
        node_id: input.node_id,
        provider: input.provider,
        domains: input.domains,
        enable_ipv4: input.enable_ipv4,
        enable_ipv6: input.enable_ipv6,
        ttl: input.ttl ?? 60,
        max_retries: input.max_retries ?? 3,
        interval_seconds: input.interval_seconds,
        has_credential: existing?.has_credential || !!input.cf_api_token || !!input.webhook_url,
        webhook_url: input.webhook_url,
        webhook_method: input.webhook_method,
        updated_at: iso(0),
      } as DDNSView;
      if (existing) Object.assign(existing, next);
      else DDNS.push(next);
      return { ...next };
    },
    delete: async (id: string) => {
      await delay(undefined, WRITE_MS);
      const at = DDNS.findIndex((profile) => profile.id === id);
      if (at < 0) throw new ApiError(404, "not_found", "ddns profile not found");
      DDNS.splice(at, 1);
      return { ok: true };
    },
    run: async (id: string) => {
      await delay(undefined, WRITE_MS);
      try {
        return runDdns(id);
      } catch (error) {
        throw new ApiError(502, "bad_gateway", error instanceof Error ? error.message : String(error));
      }
    },
  },
};

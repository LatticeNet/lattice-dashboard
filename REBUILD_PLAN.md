# Lattice Dashboard — Rebuild Plan

> Status: **feature-complete.** The modern Vue console is now the canonical
> `lattice-dashboard` project, replacing the old vanilla-JS app. Every one of the
> 31 sidebar routes is a real, API-backed screen — all 18 server domains are
> covered. Remaining work is polish (i18n, charts, a11y/perf budgets, onboarding)
> and live-server E2E. `vue-tsc` + `vite build` clean; strict-CSP verified.
> Reliability patch 2026-06-17: stale chunk recovery, server cache headers,
> SSO docs linking, permission-correct empty states, and first-cycle CPU telemetry
> are complete. Diagnostics patch 2026-06-17: Nodes detail now exposes the
> server-owned node-agent debug policy, including local-only debug mode versus
> central Logs collection; SSO New Provider includes a field guide and public
> docs link.

## Why rebuild

The current `lattice-dashboard` is a dependency-free vanilla-JS app: one 34 KB
`index.html` + ~15 hand-rolled `assets/*.js` panels stacked on a single
infinite-scroll page, a 935-line hand CSS file, no navigation, manual refresh
only, raw field-wall forms, home-grown SVG dataviz. It works, but it is hard to
navigate and visually crude. The bar is **NodeGet-board** (Vue 3 + Tailwind v4 +
shadcn-vue): a calm, dense, modern operator console. Goal: match and exceed it
while honoring Lattice's constraints.

## Hard constraints (these make it *not* a NodeGet clone)

1. **Strict CSP** from the server (`script-src 'self'; style-src 'self';
   img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'`). The build
   ships bundled JS/CSS with **no inline scripts**, **no data: assets** needing
   font/img exceptions, and talks **only to its own origin**. Vite is configured
   accordingly (`modulePreload.polyfill:false`, `assetsInlineLimit:0`, system
   fonts only). The pre-paint theme script is an external `/theme-init.js`.
2. **No WebSocket / SSE** anywhere on the server — all data is request/response
   JSON. "Real-time" is a disciplined **polling layer** (`useAsyncData` with
   visibility-aware intervals, per-panel error isolation, last-good-data
   retention). We do **not** build NodeGet's xterm webshell (no live-shell API;
   batch tasks are queue+poll).
3. **Maps under CSP** = bundled world GeoJSON rendered locally (echarts/SVG) —
   **no external tile servers** (no Leaflet/MapLibre tiles).
4. **Secret-free + one-time reveal** — the API never returns credentials
   (`has_*` booleans). The UI uses explicit one-time reveal flows (enroll, token
   create, sub-token rotate) and "blank = keep" affordances for write-only
   fields.
5. **Plan → approve → apply** is the core safety pattern. Mutations produce a
   plan that becomes a pending Approval; approving computes `sha256(plan)`
   **client-side** and binds it (TOCTOU defense). The rebuild makes this a
   first-class, legible flow with a unified Approvals inbox.

## Stack

Vue 3.5 (script-setup + TS) · Vite 7 · Tailwind v4 (CSS-first, `@theme inline`)
· reka-ui (shadcn-vue New-York) + cva + `cn()` · lucide icons · Pinia ·
vue-router (history mode; server SPA-fallbacks non-`/api` paths to index.html) ·
uPlot for live charts · echarts (lazy) for the world map · vue-sonner toasts ·
@vueuse/core. Dependency-light, matching Lattice's pure-Go/minimal ethos.

## Design identity

Built on NodeGet's proven OKLCH token system, re-skinned with Lattice's own
face: a **deep slate-indigo** surface set + an **indigo brand accent**
(`--primary`). Two-axis theming: light/dark (pre-painted, no FOUC) + a brand
palette swatch engine (indigo default + 8 presets + custom hex). Added semantic
status tokens (`success`/`warning`/`info`) because this is a status-heavy
control plane. All colors are tokens — re-skinning is a one-file change.

## Information architecture (sidebar, scope-gated)

Permission-derived: each item reveals only if the principal has the scope.

- **Overview** — fleet health at a glance (KPIs, node grid, approvals inbox,
  recent activity)
- **Fleet** — Nodes, Map, Inventory (machines/cost), Monitoring
- **Operations** — Approvals (unified inbox), Tasks, Audit
- **Networking** — Network Guard (nft), Network Policy + graph, Self-host DNS,
  Geo-Routing, DDNS, Tunnels, WireGuard
- **Proxy** — Inbounds, Users, Node Profiles, Subscriptions, Usage
- **Platform** — Plugins, Workers, KV, Static, Logs, Notifications, Agent Updates
- **Settings** — Security & 2FA, Single Sign-On, Access Tokens, Appearance

## API surface (18 domains — all mapped)

Auth/2FA/SSO · Nodes/Agents · Batch Tasks · Monitoring · Inventory/Machines ·
Geo/Map · Geo-Routing · Proxy Core + Subscriptions · Network Guard (nft) ·
Network Policy + graph · Self-host DNS + Cloudflare · DDNS · Tunnels + WireGuard
· Approvals · Audit + Plugins · Logs · Tokens/RBAC · KV/Static/Workers ·
Notifications/Health. Cookie session + `X-Lattice-CSRF`; bearer PAT alt; errors
`{error:{code,message,request_id}}`; polling for "live" data.

## Phasing

- **Phase 1 — Foundation:** project scaffold, design tokens, theme
  engine, API client + polling layer, auth store, UI primitive library, app
  shell (data-driven sidebar + header), router with scope-gated nav, **Login**
  and **Overview** flagship screens.
- **Phase 1.5 — Account security:** **Settings -> Security & 2FA** with admin
  password rotation, TOTP enrollment, activation, recovery-code display, and
  disable flow. Password and 2FA disable actions intentionally return the user
  to login because the server invalidates old sessions.
- **Phase 2 — Fleet & Ops:** **Nodes** (+enroll, host facts, detail dialog,
  rotate/disable), **Fleet Map** (CSP-safe SVG projection + node geo editor),
  **Inventory** (machine profiles, cost metadata, write-only console/detail
  links, renewal reminders), **Monitoring** (TCP/HTTP monitor create/delete,
  assignments, result history, latency trend), **Approvals** inbox (plan review
  + client-side sha bind), **Tasks** runner, and **Audit** viewer are live.
  Remaining Phase 2 work is live-server E2E against a deployed control plane.
- **Phase 3 — Networking & Proxy (flagship): DONE.** Proxy **Inbounds**
  (VLESS+REALITY), **Users** (quota/expiry, one-time sub-token reveal),
  **Subscriptions**, **Node Profiles** (plan→approve + drift signals), **Usage**;
  **Network Guard** (nft), **Network Policy** + inline-SVG topology graph, **Self-host
  DNS** (plan + direct publish), **Geo-Routing** (render preview), **DDNS**,
  **Tunnels**, **WireGuard** (mesh planner) are all live.
- **Phase 4 — Platform & Settings: DONE (polish pending).** **Plugins** (verify +
  lifecycle), **Workers** (deploy/run), **KV**, **Static**, **Logs** (sources +
  query/tail + stats), **Notifications** (channels + test), **Agent Updates**
  (plan→approve); Settings **Single Sign-On** (OIDC), **Access Tokens** (one-time
  PAT reveal), **Appearance** are live.
- **Phase 4 polish — DONE.** **Charts** (CSP-safe inline-SVG trend chart on
  Monitoring latency + Proxy Usage traffic bars), **first-run onboarding**
  (empty-fleet Getting Started checklist), **a11y** (skip link, landmarks,
  `aria-current`, icon-button labels, table semantics, live Copied announce),
  and **i18n** (all 33 views in English + Simplified Chinese with a language
  switcher) are shipped. Only **live-server E2E** against a deployed control
  plane remains, which happens during deploy validation.
- **Deployment reliability — DONE.** Server static hosting now sends `no-cache`
  for app-shell/fallback routes and immutable cache headers for hashed assets;
  the router performs one guarded reload on stale dynamic-import chunk failures.
- **Operator diagnostics — DONE.** Node detail exposes server-controlled
  `lattice-agent v0.2.1+` debug policy: enable local node diagnostics, collect
  centrally by default into managed Logs, or keep debug output local only.
- **SSO setup guidance — DONE.** The New Provider dialog includes the exact
  redirect URI, an IdP checklist, field-by-field explanations, and a deep link
  to `https://latticenet.github.io/guide/sso`.
- **Protocol-level future work — NOT dashboard-only.** KV Store v2
  (bucket-bound credentials and domain/IP binding), Static hosting v2
  (domain-bound sites / optional Cloudflare Pages workflow), browser terminal
  (audited interactive PTY/session transport), and group-leader topology require
  server model/API/auth/audit and agent protocol work before dashboard controls
  can honestly claim full support.

## Serving

Production build emits static assets to `dist/`. Point the server at it:
`LATTICE_WEB_ROOT=.../lattice-dashboard/dist` (or `-web`). SPA history routes
fall back to `index.html` (already handled by the server's static handler).
Dev: `pnpm dev` proxies `/api` + `/sub` to `127.0.0.1:8088`.

### CSP note for the server

The Vue app is fully CSSOM/Tailwind-driven, so `script-src 'self'` and
`style-src 'self'` both hold with no inline scripts. If a future dependency
injects a runtime `<style>` (e.g. some chart libs), prefer a nonce/hash over
`'unsafe-inline'`. `vue-sonner` styling is verified during the build pass.

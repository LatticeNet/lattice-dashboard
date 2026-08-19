# Lattice Dashboard

Modern Vue 3 operator console for Lattice: Vue 3.5, Vite, Tailwind v4,
reka-ui/shadcn-vue primitives, Pinia, vue-router, and polling-based data
loading under the server's strict CSP.

## How it fits

This repository builds static files only. It has no backend of its own. The
control plane (`lattice-server`) serves the built `dist/` and every API the
console calls, so the console is useless on its own and is versioned against a
server through `dashboard.ref`.

Much of what an operator does here is not implemented in this repository.
Proxy management, subscription conversion, the nftables firewall, and WireGuard
are plugins, each shipping its own UI that this console renders inside a
sandboxed iframe. The host deliberately holds no plugin-domain views and no
plugin-specific API routes, and
`src/views/platform/__tests__/pluginIsolation.test.ts` fails the build if either
appears. When you are looking for a proxy or firewall screen and cannot find it
here, that is the reason: it lives in the plugin repository.

See `LATTICE-OVERVIEW.md` at the workspace root for the whole system.

The Operations -> Terminal page uses `@xterm/xterm` for a real shell surface.
Modern agents should run terminal transport `stream`: the browser attaches to a
same-origin WebSocket, the server splices it to an agent-dialed WebSocket, and
the agent binds that stream to an on-node PTY with reconnect/replay handling.
Legacy `poll` remains as a compatibility fallback for older agents or nodes that
have not yet reported `terminal_transport=stream`.

## Develop

```sh
pnpm install
pnpm dev
```

The dev server listens on `127.0.0.1:5273` and proxies `/api` and `/sub` to a
local `lattice-server` on `127.0.0.1:8088`.

## Verify

```sh
pnpm test:navigation
pnpm type-check
pnpm build
```

`test:navigation` is the node test suite covering routing, the navigation and
layout models, the plugin frame contracts, the view models, and the locale
files. Two of its cases police house style on every string the console can
render: no em dash, no en dash, no emoji, in either locale. Check the exit code
directly. Piping the run through `tail` reports the exit code of `tail`, which
has already accepted a failing suite here once.

The production build emits static files to `dist/`. It is designed for the
server CSP:

```txt
script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'
```

## Deploy

For a local source deployment:

```sh
pnpm build
LATTICE_WEB_ROOT=/path/to/lattice-dashboard/dist lattice-server
```

For container deployments, `lattice-server` builds this repository as a named
BuildKit context and embeds `dist/` into `/app/dashboard`.

The server serves `index.html`, SPA fallbacks, and `theme-init.js` with
`Cache-Control: no-cache`, while Vite content-hashed files under `/assets/` are
long-lived immutable assets. The router also reloads once when a stale app shell
tries to import an old chunk after a deploy.

`LATTICE_ADMIN_PASSWORD` is a first-run bootstrap input. After the state file
exists, rotate the password through the authenticated API instead of changing the
environment variable and expecting restart-time mutation.

SSO provider setup notes are maintained at
`https://latticenet.github.io/guide/sso` and linked from Settings -> Single
Sign-On.

Operator-facing interaction contracts for Nodes, Groups, Fleet Map, Network
Guard inputs, Network Policy, Approvals, and official vpn-core plugin pages are
documented in [OPERATIONS_UI_GUIDE.md](./OPERATIONS_UI_GUIDE.md).

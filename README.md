# Lattice Dashboard

Modern Vue 3 operator console for Lattice: Vue 3.5, Vite, Tailwind v4,
reka-ui/shadcn-vue primitives, Pinia, vue-router, and polling-based data
loading under the server's strict CSP.

The Operations -> Terminal page uses `@xterm/xterm` for a real shell surface
while preserving Lattice's no-WebSocket server contract: the dashboard polls
bounded Terminal API events, sends input/resize/close JSON requests, and opens
node-specific sessions from the Nodes page.

## Develop

```sh
pnpm install
pnpm dev
```

The dev server listens on `127.0.0.1:5273` and proxies `/api` and `/sub` to a
local `lattice-server` on `127.0.0.1:8088`.

## Verify

```sh
pnpm type-check
pnpm build
```

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

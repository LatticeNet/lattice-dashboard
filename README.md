# lattice-dashboard

Static dashboard for Lattice.

The current MVP is dependency-free browser code with TypeScript source notes.
It can be served by `lattice-server` through `LATTICE_WEB_ROOT` or by any static
host.

## Features

- Login and session bootstrap.
- Node table and fleet counters, including HostFacts summary (arch/platform,
  cores/RAM, uptime).
- Machines panel for server-only inventory profiles: vendor/region, cost,
  renewal date, write-only console/detail links, mark-renewed, and manual
  reminder evaluation.
- Fleet Map panel for operator-owned NodeGeo records: dependency-free inline SVG
  world map, online/offline pins, and geo edit/clear form. It does not call
  external map tiles or live geo-IP APIs.
- Batch task form and task result cards.
- KV editor.
- Worker deployment form.
- Plugin lifecycle panel for verified plugin availability and safe status
  transitions.
- Network Guard panel for persisted per-node nft inputs, public/WireGuard
  TCP/UDP port sets, ingress policy composition into `lattice_guard`, and nft
  plan approval review with client-computed `sha256(plan)` binding.
- Self-host DNS panel for `DNSDeployment` intent CRUD: node, engine, exposure,
  listen port, hostname/DDNS binding, write-only Cloudflare token, and a safe
  single-zone editor. CoreDNS apply/publish controls are intentionally absent
  until the backend plan/apply path lands.
- Network Policy panel for saved `NetPolicy` intents, a server-derived
  reachability graph with inline-SVG visualization, and a `Plan Apply` action
  that creates the rollback-protected `nftpolicy` approval. Execution still
  requires the existing approvals panel; egress rules apply through the
  dedicated policy table, while ingress rules compose into the Network Guard
  input render.
- Audit stream with action, decision, node, and request-id filters, bounded
  pagination, expandable event details, and one-click request-id tracing.
- Structured Lattice API error display with compatibility for the legacy string
  error response.
- Security-sensitive API codes (`capability_denied`, `invalid_node_token`,
  `invalid_task_lease`, `task_output_limit_exceeded`) are mapped to operator
  guidance with the server request id when present.

## Development

```sh
npm run check
npm test
```

The dashboard currently uses no install-time dependencies. A future version can
move to Vite/Vue or React once API shape and product flows stabilize.

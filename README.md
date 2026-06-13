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
- Batch task form and task result cards.
- KV editor.
- Worker deployment form.
- Plugin lifecycle panel for verified plugin availability and safe status
  transitions.
- Network Guard panel for persisted per-node nft inputs, public/WireGuard
  TCP/UDP port sets, and nft plan approval review.
- Network Policy panel for saved `NetPolicy` intents and a server-derived
  reachability graph. It does not apply firewall rules yet; nft commit support
  belongs to the later rollback-protected `nftpolicy` approval path.
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

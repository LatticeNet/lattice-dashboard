# lattice-dashboard

Static dashboard for Lattice.

The current MVP is dependency-free browser code with TypeScript source notes.
It can be served by `lattice-server` through `LATTICE_WEB_ROOT` or by any static
host.

## Features

- Login and session bootstrap.
- Node table and fleet counters.
- Batch task form and task result cards.
- KV editor.
- Worker deployment form.
- nft plan approval view.
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

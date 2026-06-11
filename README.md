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
- Audit stream.

## Development

```sh
npm run check
```

The dashboard currently uses no install-time dependencies. A future version can
move to Vite/Vue or React once API shape and product flows stabilize.


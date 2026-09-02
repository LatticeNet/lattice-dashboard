import { fileURLToPath, URL } from "node:url";

import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";

// Dev-only harness for rendering a view against an in-memory API.
//
// Separate from vite.config.ts on purpose: the alias below swaps the API
// barrel for a fake under dev/, and that must never be reachable from the
// production build. Nothing here is used by `pnpm build`.
//
// One harness per fake, chosen by name so lanes can add theirs without
// editing this file:
//
//   LATTICE_HARNESS=terminal pnpm exec vite --config vite.harness.config.ts
//   open http://127.0.0.1:5185/dev/terminal.html
const harness = process.env.LATTICE_HARNESS ?? "terminal";
const port = Number(process.env.LATTICE_HARNESS_PORT ?? 5185);

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: [
      // Exact match only: `@/lib/api/index` and `@/lib/api/client` still
      // resolve to the real modules, which is how the fake re-exports them.
      { find: /^@\/lib\/api$/, replacement: fileURLToPath(new URL(`./dev/${harness}FakeApi.ts`, import.meta.url)) },
      { find: "@", replacement: fileURLToPath(new URL("./src", import.meta.url)) },
    ],
  },
  server: {
    port,
    host: "127.0.0.1",
    strictPort: true,
  },
});

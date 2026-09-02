import { fileURLToPath, URL } from "node:url";

import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";

// Dev-only harness for rendering a view against an in-memory API.
//
// Separate from vite.config.ts and from vite.harness.config.ts (the shared
// LATTICE_HARNESS one) because this page also swaps the guard-reality read
// path, which that config cannot express. The alias below swaps the API
// barrel for dev/fakeApi.ts, and that must never be reachable from the
// production build. Nothing here is used by `pnpm build`.
//
//   pnpm exec vite --config vite.harness.ssh-guard.config.ts --port 5182
//   open http://127.0.0.1:5182/dev/ssh-guard.html
export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: [
      // Exact match only: `@/lib/api/index` and `@/lib/api/client` still
      // resolve to the real modules, which is how the fake re-exports them.
      { find: /^@\/lib\/api$/, replacement: fileURLToPath(new URL("./dev/fakeApi.ts", import.meta.url)) },
      { find: /^@\/views\/networking\/sshGuardReality$/, replacement: fileURLToPath(new URL("./dev/fakeGuardReality.ts", import.meta.url)) },
      { find: "@", replacement: fileURLToPath(new URL("./src", import.meta.url)) },
    ],
  },
  server: {
    port: 5182,
    host: "127.0.0.1",
    strictPort: true,
  },
});

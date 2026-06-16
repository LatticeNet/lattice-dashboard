import { fileURLToPath, URL } from "node:url";

import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";

// Lattice dashboard build.
//
// The server serves this under a STRICT Content-Security-Policy:
//   script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'
// So the production bundle must contain NO inline <script>, NO data: assets that
// would need font-src/img-src exceptions, and must only talk to its own origin.
//   - modulePreload.polyfill: false  -> removes Vite's inline modulepreload shim
//   - assetsInlineLimit: 0           -> never emit data: URIs (keeps CSP minimal)
//   - system fonts only              -> no font-src needed
export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 5273,
    host: "127.0.0.1",
    // Dev proxy to a locally running lattice-server (default LATTICE_LISTEN).
    proxy: {
      "/api": { target: "http://127.0.0.1:8088", changeOrigin: true, secure: false },
      "/sub": { target: "http://127.0.0.1:8088", changeOrigin: true, secure: false },
    },
  },
  build: {
    target: "es2022",
    assetsInlineLimit: 0,
    cssCodeSplit: true,
    modulePreload: { polyfill: false },
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ["vue", "vue-router", "pinia"],
          ui: ["reka-ui", "lucide-vue-next", "vue-sonner"],
        },
      },
    },
  },
});

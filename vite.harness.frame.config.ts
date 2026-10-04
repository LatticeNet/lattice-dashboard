import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath, URL } from "node:url";

import { defineConfig, type Plugin } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";

// Dev-only harness for the console's frame: the real index.html, router and
// AppLayout against the in-memory API in dev/frameFakeApi.ts (see its header).
//
// Separate from vite.harness.config.ts because this one also serves plugin
// builds at the path the server serves them from, so a sandboxed plugin page
// renders inside the real PluginFrameHost. Nothing here is used by
// `pnpm build`.
//
//   LATTICE_HARNESS_PLUGINS=latticenet.netguard=../netguard/ui/dist,latticenet.wireguard=../wireguard/ui/dist \
//     pnpm exec vite --config vite.harness.frame.config.ts
//   open http://127.0.0.1:5186/plugins/latticenet.netguard/firewall?view=nodes
const port = Number(process.env.LATTICE_HARNESS_PORT ?? 5186);

/** id=dir pairs, comma separated; each dir is a plugin's built ui/dist. */
function pluginDists(): Map<string, string> {
  const out = new Map<string, string>();
  for (const pair of (process.env.LATTICE_HARNESS_PLUGINS ?? "").split(",")) {
    const [id, dir] = pair.split("=");
    if (id && dir) out.set(id.trim(), resolve(dir.trim()));
  }
  return out;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

/** Serves /api/plugins/assets/<id>/<digest>/ui/<file> from the named build, any digest. */
function pluginAssets(): Plugin {
  const dists = pluginDists();
  return {
    name: "lattice-harness-plugin-assets",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const match = /^\/api\/plugins\/assets\/([^/]+)\/[0-9a-f]{64}\/ui\/([^?#]*)/.exec(req.url ?? "");
        if (!match) return next();
        const root = dists.get(decodeURIComponent(match[1]!));
        const file = normalize(join(root ?? "", decodeURIComponent(match[2] || "index.html")));
        if (!root || !(file === root || file.startsWith(root + sep))) {
          res.statusCode = 404;
          res.end("no plugin build for this id (LATTICE_HARNESS_PLUGINS)");
          return;
        }
        try {
          const body = await readFile(file);
          res.setHeader("Content-Type", TYPES[extname(file)] ?? "application/octet-stream");
          // As the server does (server_plugin_assets.go): the sandboxed
          // document has an opaque origin, so its scripts and styles load
          // through credentialless CORS.
          if (extname(file) !== ".html") res.setHeader("Access-Control-Allow-Origin", "*");
          res.end(body);
        } catch {
          res.statusCode = 404;
          res.end("not found");
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [pluginAssets(), vue(), tailwindcss()],
  resolve: {
    alias: [
      // Exact match only: `@/lib/api/index` and `@/lib/api/client` still
      // resolve to the real modules, which is how the fake re-exports them.
      { find: /^@\/lib\/api$/, replacement: fileURLToPath(new URL("./dev/frameFakeApi.ts", import.meta.url)) },
      // SSH Guard reads its reality through its own module, as in the
      // ssh-guard harness.
      { find: /^@\/views\/networking\/sshGuardReality$/, replacement: fileURLToPath(new URL("./dev/fakeGuardReality.ts", import.meta.url)) },
      { find: "@", replacement: fileURLToPath(new URL("./src", import.meta.url)) },
    ],
  },
  server: {
    port,
    host: "127.0.0.1",
    strictPort: true,
  },
});

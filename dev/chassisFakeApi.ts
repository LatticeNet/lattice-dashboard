/**
 * The chassis gallery reads nothing from a server: every state it shows is
 * passed as props. This fake exists because the harness config swaps the API
 * barrel by name, and chassis components import types and ApiError from it.
 *
 *   LATTICE_HARNESS=chassis LATTICE_HARNESS_PORT=5410 pnpm exec vite --config vite.harness.config.ts
 *   open http://127.0.0.1:5410/dev/chassis.html
 */
export * from "@/lib/api/index";

export const api = new Proxy(
  {},
  {
    get(_target, prop) {
      return new Proxy(
        {},
        {
          get(_inner, method) {
            return () => Promise.reject(new Error(`fake api: ${String(prop)}.${String(method)} is not part of the chassis gallery`));
          },
        },
      );
    },
  },
) as typeof import("@/lib/api/index").api;

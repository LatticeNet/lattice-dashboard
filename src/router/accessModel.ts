/**
 * Whether the signed-in principal may open a console route, and if not,
 * which scopes it would need.
 *
 * A deep link to a page outside the principal's scopes (a teammate's link, a
 * notification) used to redirect to Overview without a word, so the operator
 * could not tell a typo from a permission. The route now stays at the
 * address it was given and the shell renders a denied panel that names the
 * page and the scopes instead of mounting the page. The server enforces the
 * scopes on every call either way; this only decides what the console shows.
 *
 * Route meta `scopes` is the least privilege that reveals the page, and any
 * one of them suffices (the same rule the sidebar and the guard use).
 *
 * Kept free of Vue so `node --test` covers it directly.
 */
export function missingRouteScopes(required: unknown, canAny: (scopes: string[]) => boolean): string[] | null {
  const scopes = Array.isArray(required) ? required.filter((scope): scope is string => typeof scope === "string" && scope !== "") : [];
  if (scopes.length === 0 || canAny(scopes)) return null;
  return scopes;
}

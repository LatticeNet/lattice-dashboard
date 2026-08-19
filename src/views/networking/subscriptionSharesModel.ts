/**
 * Share slug suggestion for the subscription → share deep link.
 *
 * When the Sub-Store frame sends the operator to
 * /network/subscription-shares?create=1&for=<name>, the create form prefills
 * the subscription id and offers a slug derived from the record name. The
 * suggestion is only a starting point: it must already satisfy the server's
 * slug rule and must not collide with an existing share, otherwise the field
 * stays empty and the operator picks one. A wrong-guess slug that silently
 * differed from the record name would be worse than none.
 */

/** Mirrors the server's `shareSlugRe`. Failing here saves a round trip and
 *  states the rule; the server still owns the decision. */
export const SHARE_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Slug cap implied by SHARE_SLUG_RE (1 leading char + 62 more). */
export const SHARE_SLUG_MAX_LENGTH = 63;

/**
 * Lowercase the name, map every run of non-[a-z0-9-] characters to one dash,
 * collapse dash runs, and trim leading/trailing dashes so the result starts
 * with a letter or digit. Returns "" when nothing slug-safe remains (e.g. a
 * name that is entirely non-Latin script).
 */
export function slugifyShareName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  // The length cap can itself leave a trailing dash; trim once more.
  return slug.slice(0, SHARE_SLUG_MAX_LENGTH).replace(/-+$/, "");
}

/**
 * The suggested slug for a subscription record name, or "" when the name
 * cannot produce a valid slug or the valid slug is already taken.
 */
export function suggestShareSlug(name: string, existingSlugs: readonly string[]): string {
  const slug = slugifyShareName(name.trim());
  if (!slug || !SHARE_SLUG_RE.test(slug)) return "";
  if (existingSlugs.includes(slug)) return "";
  return slug;
}

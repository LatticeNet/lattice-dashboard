export interface PluginBreadcrumbInput {
  pluginId: string;
  pluginDisplayName?: string | null | undefined;
  viewTitle?: string | null | undefined;
  viewRoute?: string | null | undefined;
}

function normalizedLabel(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function resolvePluginBreadcrumb(input: PluginBreadcrumbInput) {
  const sectionLabel = normalizedLabel(input.pluginDisplayName) ?? input.pluginId;
  return {
    sectionLabel,
    title: normalizedLabel(input.viewTitle) ?? normalizedLabel(input.viewRoute) ?? sectionLabel,
  };
}

/* ------------------------------------------------------------------ */
/* Breadcrumbs (design 23, section 3.10)                               */
/* ------------------------------------------------------------------ */

/** The part of a nav section the trail needs. */
export interface CrumbSection {
  id: string;
  items: readonly { name: string; scopes?: readonly string[] }[];
}

/**
 * Object pages and the collection they belong to. The trail reads
 * Section / Collection / Object, and the collection is a link back.
 */
export const DETAIL_PARENT: Readonly<Record<string, string>> = {
  "node-detail": "nodes",
  "monitor-detail": "monitoring",
};

export type Crumb =
  | { kind: "section"; id: string; to?: { name: string } }
  | { kind: "collection"; name: string; to: { name: string } }
  | { kind: "page"; name: string };

/**
 * The header's trail for a route. The section links to its first page the
 * operator can open (a section has no page of its own); an object page adds
 * its collection as a link; the current page is last and is not a link. The
 * overview section is the console's home and gets no section crumb.
 */
export function breadcrumbTrail(
  routeName: string,
  sections: readonly CrumbSection[],
  canOpen: (item: { name: string; scopes?: readonly string[] }) => boolean,
): Crumb[] {
  const parent = DETAIL_PARENT[routeName];
  const owner = parent ?? routeName;
  const section = sections.find((entry) => entry.items.some((item) => item.name === owner));
  const trail: Crumb[] = [];
  if (section && section.id !== "overview") {
    const first = section.items.find(canOpen);
    trail.push({ kind: "section", id: section.id, to: first ? { name: first.name } : undefined });
  }
  if (parent) trail.push({ kind: "collection", name: parent, to: { name: parent } });
  trail.push({ kind: "page", name: routeName });
  return trail;
}

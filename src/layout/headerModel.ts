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

/* ------------------------------------------------------------------ */
/* The command palette shortcut                                        */
/* ------------------------------------------------------------------ */

/**
 * Whether the keyboard has a Command key: macOS, and iOS and iPadOS with a
 * hardware keyboard. `platform` is navigator.userAgentData.platform
 * ("macOS") or the older navigator.platform ("MacIntel", "iPad"); the user
 * agent is read only when neither is there.
 */
export function isApplePlatform(platform: string | null | undefined, userAgent = ""): boolean {
  const p = (platform ?? "").trim().toLowerCase();
  if (p) return /mac|iphone|ipad|ipod/.test(p);
  return /macintosh|mac os x|iphone|ipad|ipod/i.test(userAgent);
}

/** The hint printed beside the search field: the chord this keyboard uses. */
export function commandShortcutKey(apple: boolean): "shell.command.shortcutMac" | "shell.command.shortcutOther" {
  return apple ? "shell.command.shortcutMac" : "shell.command.shortcutOther";
}

/** Where focus was when the key went down. */
export type ShortcutTarget = "terminal" | "editable" | "other";

export interface ShortcutKeys {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

/**
 * Whether a keydown opens the command palette. Outside a text field either
 * Command+K or Ctrl+K does, as before. Inside one only this keyboard's own
 * chord does: Ctrl+K is the line-kill key in macOS text fields and must keep
 * working there, and off macOS Ctrl+K in a field used to be swallowed without
 * opening anything. Never inside Terminal, where Ctrl+K belongs to the shell.
 */
export function opensCommandPalette(keys: ShortcutKeys, context: { apple: boolean; target: ShortcutTarget }): boolean {
  if (keys.key.toLowerCase() !== "k" || keys.altKey || keys.shiftKey) return false;
  if (!keys.metaKey && !keys.ctrlKey) return false;
  if (context.target === "terminal") return false;
  if (context.target === "editable") return context.apple ? keys.metaKey && !keys.ctrlKey : keys.ctrlKey && !keys.metaKey;
  return true;
}

/** isApplePlatform for the browser this runs in; false outside one. */
export function currentPlatformIsApple(): boolean {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return isApplePlatform(nav.userAgentData?.platform || nav.platform, nav.userAgent);
}

/* ------------------------------------------------------------------ */
/* The document title                                                  */
/* ------------------------------------------------------------------ */

export const PRODUCT_TITLE = "Lattice";

/**
 * The tab title: the open object, the page, then the product, so three tabs
 * on Approvals, a node and Terminal read differently and the object comes
 * first where a narrow tab cuts the rest off. An object named like its page
 * is said once.
 */
export function documentTitle(parts: { page?: string | null; object?: string | null }): string {
  const page = parts.page?.trim() ?? "";
  const object = parts.object?.trim() ?? "";
  return [object && object !== page ? object : "", page, PRODUCT_TITLE].filter(Boolean).join(" · ");
}

/**
 * The object titles shown at once, newest last: one per open sheet or object
 * page. The tab names the newest; closing it falls back to the one before.
 */
export class ObjectTitleStack {
  private entries: { id: symbol; title: string }[] = [];

  set(id: symbol, title: string | null | undefined): void {
    const text = title?.trim() ?? "";
    this.entries = this.entries.filter((entry) => entry.id !== id);
    if (text) this.entries.push({ id, title: text });
  }

  clear(id: symbol): void {
    this.entries = this.entries.filter((entry) => entry.id !== id);
  }

  get current(): string {
    return this.entries[this.entries.length - 1]?.title ?? "";
  }
}

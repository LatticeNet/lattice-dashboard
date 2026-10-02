/**
 * What the Upcoming panel and the Upcoming list do with `GET /api/expiring`:
 * group the rows by week, sum their cost per currency, decide which state the
 * surface is in, and read and write the kind filter in the address bar.
 *
 * Weeks start on Monday and are counted in UTC days, the same days the server
 * counts `days` in, and "today" is the server's `generated_at` rather than the
 * viewer's clock, so a row due tomorrow is not moved into next week by a
 * browser sitting in another time zone.
 */
import type { ExpiringItem, ExpiringResponse, ExpiringTotal } from "@/lib/api/types";
import { canonicalCurrency } from "@/lib/currency";

/** The kinds the console knows how to name and filter, in the order the chips show them. */
export const EXPIRING_KINDS = ["machine_renewal", "vpn_user", "share", "tls_certificate"] as const;

/**
 * Each kind needs the read scope of its own list (inventory, proxy users,
 * shares, monitors), and the server counts what a session cannot read in
 * `hidden`. Any one of them makes the page worth opening.
 */
export const UPCOMING_SCOPES = ["inventory:read", "proxy:read", "proxy:admin", "monitor:read"];

/** Home shows the next 30 days; the full list looks 90 days ahead. Overdue rows come either way. */
export const PANEL_WITHIN_DAYS = 30;
export const LIST_WITHIN_DAYS = 90;

const DAY_MS = 86_400_000;

function utcDay(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The server's today, or the viewer's when the response carries no usable time. */
export function todayOf(data: Pick<ExpiringResponse, "generated_at"> | undefined, fallbackMs: number): number {
  const at = data?.generated_at ? Date.parse(data.generated_at) : Number.NaN;
  return utcDay(Number.isNaN(at) ? fallbackMs : at);
}

/** Past due and renewed by hand. An auto-roll row is charged on its date, so it never counts. */
export function isOverdue(item: Pick<ExpiringItem, "days" | "state">): boolean {
  return item.state === "overdue" || (item.days < 0 && item.state !== "auto");
}

export type WeekGroupKind = "overdue" | "thisWeek" | "nextWeek" | "dated";

export interface WeekGroup {
  key: string;
  kind: WeekGroupKind;
  /** Monday of the week (YYYY-MM-DD), for the dated weeks. */
  weekStart?: string;
  items: ExpiringItem[];
  totals: ExpiringTotal[];
}

/** Date order, then title, the order the contract promises; kept here so a stray row cannot break the weeks. */
function compareItems(a: ExpiringItem, b: ExpiringItem): number {
  return a.days - b.days || a.title.localeCompare(b.title);
}

/**
 * Overdue first, then this week, next week, and one group per later week
 * named by its Monday. Empty weeks are not printed.
 */
export function groupByWeek(items: readonly ExpiringItem[], todayMs: number): WeekGroup[] {
  const today = utcDay(todayMs);
  const monday = today - ((new Date(today).getUTCDay() + 6) % 7) * DAY_MS;
  const overdue: ExpiringItem[] = [];
  const weeks = new Map<number, ExpiringItem[]>();

  for (const item of [...items].sort(compareItems)) {
    if (isOverdue(item)) {
      overdue.push(item);
      continue;
    }
    const parsed = Date.parse(item.due_at);
    const due = Number.isNaN(parsed) ? today + item.days * DAY_MS : utcDay(parsed);
    const index = Math.max(0, Math.floor((due - monday) / (7 * DAY_MS)));
    const bucket = weeks.get(index);
    if (bucket) bucket.push(item);
    else weeks.set(index, [item]);
  }

  const groups: WeekGroup[] = [];
  if (overdue.length) groups.push({ key: "overdue", kind: "overdue", items: overdue, totals: sumTotals(overdue) });
  for (const index of [...weeks.keys()].sort((a, b) => a - b)) {
    const rows = weeks.get(index)!;
    const kind: WeekGroupKind = index === 0 ? "thisWeek" : index === 1 ? "nextWeek" : "dated";
    const weekStart = isoDay(monday + index * 7 * DAY_MS);
    groups.push({
      key: `week:${weekStart}`,
      kind,
      weekStart: kind === "dated" ? weekStart : undefined,
      items: rows,
      totals: sumTotals(rows),
    });
  }
  return groups;
}

/**
 * Cost per currency over the rows given. A row without a price counts in no
 * currency, and currencies are never added to each other. Ordered by code so
 * the line reads the same on every refresh.
 */
export function sumTotals(items: readonly Pick<ExpiringItem, "cost_cents" | "currency">[]): ExpiringTotal[] {
  const by = new Map<string, ExpiringTotal>();
  for (const item of items) {
    const currency = canonicalCurrency(item.currency);
    if (!currency || !(item.cost_cents > 0)) continue;
    const total = by.get(currency) ?? { currency, cost_cents: 0, count: 0 };
    total.cost_cents += item.cost_cents;
    total.count += 1;
    by.set(currency, total);
  }
  return [...by.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}

const AMOUNT = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** `USD 1,234.50`: the code first, as the reminders and the proof line write it. */
export function formatAmount(cents: number, currency: string): string {
  return `${canonicalCurrency(currency) || currency} ${AMOUNT.format(cents / 100)}`;
}

export function formatTotals(totals: readonly ExpiringTotal[]): string {
  return totals.map((total) => formatAmount(total.cost_cents, total.currency)).join(" · ");
}

// ── surface state ───────────────────────────────────────────────────────────

/**
 * `unsupported` is a server that predates the endpoint (a plain 404): the
 * surface says so and points at Inventory instead of claiming nothing is due.
 * `failed` has nothing to show; a failure after a good load keeps the rows and
 * is `ready` or `empty` with `stale` set, so the age of what is shown can be
 * printed beside it.
 */
export type UpcomingState = "loading" | "unsupported" | "forbidden" | "failed" | "empty" | "ready";

export interface UpcomingStateInput {
  loading: boolean;
  error?: unknown;
  data?: Pick<ExpiringResponse, "items">;
  /** Rows left after the kind filter, when one applies. */
  visible?: number;
}

function statusOf(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | undefined)?.status;
  return typeof status === "number" ? status : undefined;
}

export function isUnsupported(error: unknown): boolean {
  return statusOf(error) === 404;
}

export function upcomingState(input: UpcomingStateInput): { state: UpcomingState; stale: boolean } {
  if (isUnsupported(input.error)) return { state: "unsupported", stale: false };
  if (input.data) {
    const count = input.visible ?? input.data.items.length;
    return { state: count > 0 ? "ready" : "empty", stale: !!input.error };
  }
  if (input.error) return { state: statusOf(input.error) === 403 ? "forbidden" : "failed", stale: false };
  return { state: "loading", stale: false };
}

// ── kind filter in the address bar ──────────────────────────────────────────

export type KnownKind = (typeof EXPIRING_KINDS)[number];

function isKnownKind(value: string): value is KnownKind {
  return (EXPIRING_KINDS as readonly string[]).includes(value);
}

/**
 * `?kind=share,vpn_user` (or the key repeated) as a set in chip order.
 * Unknown words are dropped, and every kind selected is the same as none:
 * both mean "all", and both come back as an empty list.
 */
export function parseKindFilter(value: unknown): KnownKind[] {
  const raw = (Array.isArray(value) ? value : [value])
    .filter((v): v is string => typeof v === "string")
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter(isKnownKind);
  const picked = EXPIRING_KINDS.filter((kind) => raw.includes(kind));
  return picked.length === EXPIRING_KINDS.length ? [] : picked;
}

/** The query value for a selection; undefined removes the parameter. */
export function kindFilterQuery(kinds: readonly KnownKind[]): string | undefined {
  const picked = parseKindFilter(kinds.join(","));
  return picked.length ? picked.join(",") : undefined;
}

export function toggleKind(current: readonly KnownKind[], kind: KnownKind): KnownKind[] {
  const next = current.includes(kind) ? current.filter((k) => k !== kind) : [...current, kind];
  return parseKindFilter(next.join(","));
}

/** No selection shows every row, kinds the console does not know yet included. */
export function filterByKinds<T extends Pick<ExpiringItem, "kind">>(items: readonly T[], kinds: readonly KnownKind[]): T[] {
  if (!kinds.length) return [...items];
  return items.filter((item) => (kinds as readonly string[]).includes(item.kind));
}

/**
 * The kinds the session cannot read, in chip order, then any kind the console
 * does not know yet. An older server's `hidden` row count is not read: the
 * contract dropped it because a count leaks fleet size.
 */
export function hiddenKindsOf(data: Pick<ExpiringResponse, "hidden_kinds"> | undefined): string[] {
  const raw = Array.isArray(data?.hidden_kinds) ? data.hidden_kinds.filter((k): k is string => typeof k === "string" && k !== "") : [];
  const known = EXPIRING_KINDS.filter((kind) => raw.includes(kind));
  const unknown = [...new Set(raw.filter((kind) => !isKnownKind(kind)))];
  return [...known, ...unknown];
}

/**
 * Home's one-line signal: rows past due, and rows due within the week that
 * need a hand (`due`). Auto-roll rows inside the week are left out on
 * purpose: they renew and are charged without anyone acting.
 */
export function dueSoonCounts(items: readonly Pick<ExpiringItem, "days" | "state">[]): { overdue: number; due: number } {
  let overdue = 0;
  let due = 0;
  for (const item of items) {
    if (isOverdue(item)) overdue += 1;
    else if (item.state === "due" && item.days >= 0 && item.days <= 7) due += 1;
  }
  return { overdue, due };
}

export function kindCounts(items: readonly Pick<ExpiringItem, "kind">[]): Record<KnownKind, number> {
  const counts = Object.fromEntries(EXPIRING_KINDS.map((kind) => [kind, 0])) as Record<KnownKind, number>;
  for (const item of items) if (isKnownKind(item.kind)) counts[item.kind] += 1;
  return counts;
}

/** Whole percent of a VPN user's quota used, or undefined without a quota. */
export function quotaPercent(item: Pick<ExpiringItem, "used_bytes" | "quota_bytes">): number | undefined {
  const quota = item.quota_bytes;
  if (!(typeof quota === "number" && quota > 0)) return undefined;
  const used = typeof item.used_bytes === "number" && item.used_bytes > 0 ? item.used_bytes : 0;
  return Math.round((used / quota) * 100);
}

// ── where a row goes ────────────────────────────────────────────────────────

/** vpn-core's Users page; `?open=<identity id>` opens that identity's panel. */
export const VPN_USERS_PATH = "/plugins/latticenet.vpn-core/users";

// Where each kind lives when a row arrives without an href. The server sends
// `/inventory?machine=<profile id>`, `/plugins/latticenet.vpn-core/users`,
// `/platform/publishing?origin=share&share=<id>` and `/monitoring/<id>`.
const FALLBACK_HREF: Partial<Record<string, string>> = {
  vpn_user: VPN_USERS_PATH,
  share: "/platform/publishing?origin=share",
  tls_certificate: "/monitoring",
};

function localPath(href: string | undefined): string | undefined {
  const trimmed = href?.trim();
  return trimmed && trimmed.startsWith("/") && !trimmed.startsWith("//") ? trimmed : undefined;
}

/**
 * A VPN identity's row opens that identity, not the whole Users list: the
 * server's href (lattice-server expiring.go, as of e596325) is the bare
 * Users page, and vpn-core opens an identity's panel from `?open=<id>`
 * (its page state, which the console passes through the bridge). An href
 * that already names an object, or points anywhere else, is left alone.
 */
function withIdentity(href: string, id: string | undefined): string {
  if (!id) return href;
  const [path, query = ""] = href.split("?", 2);
  if (path !== VPN_USERS_PATH) return href;
  const params = new URLSearchParams(query);
  if (params.has("open")) return href;
  params.set("open", id);
  return `${path}?${params.toString()}`;
}

/**
 * The console route a row opens: the server's `href` when it is a path on
 * this origin, otherwise the page that owns the kind, otherwise nothing.
 */
export function rowHref(item: Pick<ExpiringItem, "href" | "kind"> & { id?: string }): string | undefined {
  const href = localPath(item.href);
  if (item.kind === "vpn_user") return withIdentity(href ?? VPN_USERS_PATH, item.id);
  if (href) return href;
  if (item.kind === "machine_renewal") {
    return item.id ? `/inventory?machine=${encodeURIComponent(item.id)}` : "/inventory?group=renewal";
  }
  return FALLBACK_HREF[item.kind];
}

<script setup lang="ts" generic="T">
import { computed, getCurrentInstance, nextTick, onMounted, ref, watch, type HTMLAttributes } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter, type RouteLocationRaw } from "vue-router";
import { useDebounceFn, useMediaQuery } from "@vueuse/core";
import { PaginationRoot } from "reka-ui";
import { ChevronDown, ChevronUp, ChevronsUpDown, ChevronLeft, ChevronRight, Funnel, Search, X } from "lucide-vue-next";
import { cn } from "@/lib/utils";
import { evalFilterExpression, normalizeExprToken, tokenMatchesText } from "@/lib/filterExpressions";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import DataState from "./DataState.vue";
import { tableSearchVisible } from "./chassisModel";
import {
  readTableUrlState,
  tableStateParams,
  tableUrlStatesEqual,
  writeTableUrlState,
  type TableUrlState,
} from "./tableUrlState";

/** Column descriptor for a single table column. */
export interface DataTableColumn<Row> {
  /** Stable identifier; also the key looked up on the row for the default cell + sort value. */
  key: string;
  /** Header label (plain text). */
  label: string;
  /** Horizontal alignment of the header + cell. */
  align?: "left" | "right" | "center";
  /** Enables a clickable, sortable header for this column. */
  sortable?: boolean;
  /** Include this column's value in the built-in text search. */
  searchable?: boolean;
  /** Include this column in the expression filter even when it is not text-searchable. */
  filterable?: boolean;
  /** Extra field names accepted by expression filters, e.g. ["scope", "permission"]. */
  filterAliases?: string[];
  /** Extra classes applied to both the header cell and body cells. */
  class?: HTMLAttributes["class"];
  /** Custom accessor for sort/search/default-cell value (defaults to `row[key]`). */
  value?: (row: Row) => unknown;
  /**
   * Pins the column to the table's end in the scroll layout, so the row's
   * menu stays in reach while the columns between scroll. Opt-in, for a
   * column that holds a RowMenu: a cell of two to four inline buttons pinned
   * at 375 left 60 px for the scrolling middle (DNS) or none at all
   * (Geo-Routing), and an empty cell for a read-only operator still took its
   * width (Notifications).
   */
  pin?: "end";
}

type SortDir = "asc" | "desc" | null;

const props = withDefaults(
  defineProps<{
    /** Column descriptors, left-to-right. */
    columns: DataTableColumn<T>[];
    /** Row data. */
    rows: T[];
    /** Returns a stable string key for a row (used for v-for keys + selection ids). */
    rowKey: (row: T) => string;
    /** Forwarded to DataState. */
    loading?: boolean;
    /** Forwarded to DataState. */
    error?: Error | null;
    /**
     * True when a previous load succeeded. Forwarded to DataState so a failed
     * refresh keeps the last good table instead of blanking it. Callers were
     * already passing this; until now it was silently dropped on the floor.
     */
    hasData?: boolean;
    /** Number of skeleton rows shown while loading. */
    skeletonRows?: number;
    /** Empty (no rows at all) title/description, forwarded to DataState. */
    emptyTitle?: string;
    emptyDescription?: string;
    /** Title/description shown when a search/filter yields no matches. */
    noMatchTitle?: string;
    noMatchDescription?: string;
    /** Enables per-row + header selection checkboxes. */
    selectable?: boolean;
    /** When set, each row becomes a drill-through link to this route (and emits `row-select`). */
    rowTo?: (row: T) => RouteLocationRaw;
    /**
     * A row click opens the row in place (the object sheet, design 23
     * section 3.5). Receives the row element so focus can return to it when
     * the sheet closes.
     */
    rowClick?: (row: T, opener: HTMLElement) => void;
    /** The row open in a sheet right now; it is highlighted and marked current. */
    activeRowId?: string | null;
    /** Client-side page size; 0 disables pagination. */
    pageSize?: number;
    /** Shows the built-in debounced search box (requires >=1 searchable column). */
    searchable?: boolean;
    /** Shows the compact expression filter. Defaults on when searchable columns exist. */
    expressionFilter?: boolean;
    /** Placeholder for the search box. */
    searchPlaceholder?: string;
    /** Placeholder for the expression filter. */
    expressionPlaceholder?: string;
    /** Helper text below the expression filter. */
    expressionHelp?: string;
    /** Accessible label for the clear-search button. */
    clearSearchLabel?: string;
    /** "Showing {shown} of {total}" template parts. */
    showingLabel?: string;
    ofLabel?: string;
    /** Pagination range template: "{from}-{to} of {total}" parts. */
    pageOfLabel?: string;
    /** Accessible label for the previous/next pagination buttons. */
    prevLabel?: string;
    nextLabel?: string;
    /** Accessible label for the select-all header checkbox. */
    selectAllLabel?: string;
    /** Accessible label for the "drop the selection" button in the bulk bar. */
    clearSelectionLabel?: string;
    selectRowLabel?: string;
    /**
     * Opts this table into linkable view state.
     *
     * When set, the search box, expression filter, sort and page are mirrored
     * into the route query under this key, so a narrowed list can be
     * bookmarked, pasted to someone else, and survives a reload. Must be
     * unique among the tables rendered on one route.
     */
    stateKey?: string;
    /**
     * Rows that carry a `row-detail` panel, and whether that panel is open.
     *
     * A table column is a bad home for a sentence: auto layout gives width to
     * whatever cannot wrap, so a column of prose is squeezed to its longest
     * word while a column of one unbreakable identifier keeps everything it
     * asks for. A detail panel spans the whole row instead, so the sentence is
     * read at the table's width rather than at its column's.
     */
    rowExpanded?: (row: T) => boolean;
    /**
     * The "Showing X of Y" line. A caller that states its own count (Evidence
     * says how many rows were loaded and how many the query kept) turns it
     * off so the page does not say the same number twice.
     */
    showSummary?: boolean;
    /**
     * What the table becomes below 768px. "scroll" (the default, design 23
     * section 3.7) keeps the columns, lets the table scroll sideways, pins
     * the first column (capped at 38vw) and any column marked `pin: "end"`:
     * rows are compared down a column, which a stack of cards makes
     * impossible.
     * "cards" stacks each row as a card of label and value pairs; opt into it
     * only for lists whose rows are read one at a time.
     */
    narrowLayout?: "cards" | "scroll";
    /** Wrapper class. */
    class?: HTMLAttributes["class"];
  }>(),
  {
    loading: false,
    error: null,
    hasData: false,
    skeletonRows: 5,
    emptyTitle: undefined,
    emptyDescription: undefined,
    noMatchTitle: undefined,
    noMatchDescription: undefined,
    selectable: false,
    pageSize: 0,
    searchable: false,
    expressionFilter: true,
    searchPlaceholder: undefined,
    expressionPlaceholder: undefined,
    expressionHelp: undefined,
    clearSearchLabel: undefined,
    showingLabel: undefined,
    ofLabel: undefined,
    pageOfLabel: undefined,
    prevLabel: undefined,
    nextLabel: undefined,
    selectAllLabel: undefined,
    clearSelectionLabel: undefined,
    selectRowLabel: undefined,
    rowExpanded: undefined,
    showSummary: true,
    narrowLayout: "scroll",
    stateKey: undefined,
    rowTo: undefined,
    rowClick: undefined,
    activeRowId: null,
  },
);

const { t } = useI18n();

/**
 * Table chrome speaks the console's language by default.
 *
 * Each of these stayed a prop so a caller can still say something more specific
 * ("Search 412 nodes"), but the default is now a translation rather than an
 * English literal that only looked right in one locale.
 */
const label = {
  noMatchTitle: computed(() => props.noMatchTitle ?? t("common.table.noMatchTitle")),
  noMatchDescription: computed(() => props.noMatchDescription ?? t("common.table.noMatchDescription")),
  searchPlaceholder: computed(() => props.searchPlaceholder ?? t("common.table.searchPlaceholder")),
  clearSearch: computed(() => props.clearSearchLabel ?? t("common.table.clearSearch")),
  showing: computed(() => props.showingLabel ?? t("common.table.showing")),
  of: computed(() => props.ofLabel ?? t("common.table.of")),
  pageOf: computed(() => props.pageOfLabel ?? t("common.table.of")),
  prev: computed(() => props.prevLabel ?? t("common.table.previousPage")),
  next: computed(() => props.nextLabel ?? t("common.table.nextPage")),
  selectAll: computed(() => props.selectAllLabel ?? t("common.table.selectAll")),
  selectRow: computed(() => props.selectRowLabel ?? t("common.table.selectRow")),
  clearSelection: computed(() => props.clearSelectionLabel ?? t("common.table.clearSelection")),
};

const emit = defineEmits<{ retry: []; "row-select": [row: T] }>();
const router = useRouter();
const instance = getCurrentInstance();

/**
 * A row is activatable when it goes somewhere (rowTo) OR when the parent is
 * listening for the selection. Requiring rowTo alone made every table that
 * selects in place. An inbox with a detail pane beside it. Silently ignore
 * row clicks: the listener was attached, the handler was never called, and the
 * page just looked broken.
 */
const rowActivatable = computed(() => !!props.rowTo || !!props.rowClick || !!instance?.vnode.props?.onRowSelect);

/**
 * Activate a row (click or keyboard). Suppressed when the interaction
 * originates inside an interactive cell control (checkbox, button, link,
 * input, or anything marked [data-no-row-nav]) so per-row actions still work.
 */
function onRowActivate(row: T, event: MouseEvent | KeyboardEvent): void {
  const target = event.target as HTMLElement | null;
  if (target?.closest('button, a, input, label, [role="checkbox"], [data-no-row-nav]')) return;
  emit("row-select", row);
  if (props.rowClick) props.rowClick(row, event.currentTarget as HTMLElement);
  if (props.rowTo) router.push(props.rowTo(row));
}

/**
 * An activatable row keeps its row semantics.
 *
 * `role="button"` was on the `<tr>` for drill-through tables, which both erases
 * the row from the table's structure for a screen reader and, on any table with
 * a per-row action button, claims a button contains a button. The row stays a
 * row; it is still reachable by Tab and still activates on Enter or Space, and
 * the cursor says so.
 */
function onRowKeydown(row: T, event: KeyboardEvent): void {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  onRowActivate(row, event);
}

/** Selected row ids. Two-way bindable via `v-model:selected`. */
const selected = defineModel<Set<string>>("selected", {
  default: () => new Set<string>(),
});

defineSlots<
  {
    /** Toolbar area to the right of the built-in search. */
    toolbar?: () => unknown;
    /** Sticky bulk-action bar, rendered only when selection > 0. */
    "bulk-actions"?: (props: { selected: Set<string>; count: number; clear: () => void }) => unknown;
    /** Shown when there are zero rows at all (overrides DataState empty). */
    empty?: () => unknown;
    /** Shown when search/filter removes every row. */
    "no-match"?: () => unknown;
    /** Full-width panel under a row, rendered while `rowExpanded` holds for it. */
    "row-detail"?: (props: { row: T }) => unknown;
  } & Record<`cell-${string}`, (props: { row: T; value: unknown }) => unknown>
>();

const isDesktop = useMediaQuery("(min-width: 768px)");

/**
 * The first data column stays in view while a scroll-layout table scrolls
 * sideways. Only in that layout: a table that fits never needed it. Its cap
 * is 38% of the viewport at every width (a column's own class may set
 * `--pin-max` lower), so a wide screen does not clip a name that fits.
 */
function pinned(index: number): boolean {
  return props.narrowLayout === "scroll" && index === 0;
}

/** A column that asked for it pins to the end in the scroll layout. */
function pinnedEnd(column: DataTableColumn<T>): boolean {
  return props.narrowLayout === "scroll" && column.pin === "end";
}

/**
 * The gutters pin with the column beside them. Without it a sideways scroll
 * slid the selection checkbox under the pinned first cell, and a pinned
 * actions column slid over the row chevron. Pinned cells paint the row's
 * `--row-bg`, so hover, the open row and a selected row tint all the way
 * across instead of stopping at the pin.
 */
const pinsEnd = computed(() => props.narrowLayout === "scroll" && props.columns.some((column) => column.pin === "end"));
const PINNED_GUTTER = "sticky z-10 bg-[var(--row-bg,var(--background))]";

function cellPinClass(column: DataTableColumn<T>, index: number): string | undefined {
  if (pinned(index)) return cn("pin-start [--pin-max:38vw]", props.selectable && "[--pin-left:2.5rem]");
  if (pinnedEnd(column)) return cn("pin-end", props.rowTo && "[--pin-right:2rem]");
  return undefined;
}

/** The selection checkbox: pinned at the left edge, ahead of the first column. */
const selectGutterClass = computed(() => (props.narrowLayout === "scroll" ? `${PINNED_GUTTER} left-0` : undefined));

/** The row chevron: pinned at the right edge, after any pinned actions column. */
const chevronGutterClass = computed(() => {
  if (props.narrowLayout !== "scroll") return undefined;
  return pinsEnd.value ? `${PINNED_GUTTER} right-0` : "pin-end";
});

function isActive(row: T): boolean {
  return !!props.activeRowId && props.rowKey(row) === props.activeRowId;
}

/** Columns a detail row has to span: the data columns plus the two optional gutters. */
const spannedColumns = computed(
  () => props.columns.length + (props.selectable ? 1 : 0) + (props.rowTo ? 1 : 0),
);

/** Whether this row is currently showing its detail panel. */
function isRowExpanded(row: T): boolean {
  return !!props.rowExpanded?.(row);
}

/* ----------------------------- linkable state ----------------------------- */
const route = useRoute();
const sortableKeys = computed(() => props.columns.filter((c) => c.sortable).map((c) => c.key));

/**
 * Seed from the URL at construction rather than assigning after the fact, so
 * no watcher observes a transition out of the default state. A deep link that
 * carries both a search and a page would otherwise have the search watcher
 * knock the page back to one before the first render.
 */
const seed: TableUrlState = (() => {
  const empty: TableUrlState = { q: "", expr: "", sort: "", dir: null, page: 1 };
  if (!props.stateKey) return empty;
  const state = readTableUrlState(route.query, props.stateKey, sortableKeys.value);
  // A search term with nothing to search would filter every row away behind a
  // hidden input. Refuse the parts of the URL this table cannot honour; the
  // sync below then drops them from the address bar rather than leaving a
  // stale param that does nothing.
  const anySearchable = props.columns.some((c) => c.searchable);
  if (!props.searchable || !anySearchable) state.q = "";
  if (!props.searchable || !props.expressionFilter || !props.columns.some((c) => c.searchable || c.filterable)) {
    state.expr = "";
  }
  return state;
})();

/* ----------------------------- search ----------------------------- */
const searchInput = ref(seed.q);
const searchTerm = ref(seed.q);
const expressionInput = ref(seed.expr);
const expressionTerm = ref(seed.expr);
const applySearch = useDebounceFn((value: string) => {
  searchTerm.value = value;
}, 200);
const applyExpression = useDebounceFn((value: string) => {
  expressionTerm.value = value;
}, 200);
watch(searchInput, (value) => applySearch(value));
watch(expressionInput, (value) => applyExpression(value));

const searchableColumns = computed(() => props.columns.filter((c) => c.searchable));
const showSearch = computed(() => props.searchable && searchableColumns.value.length > 0);
const expressionColumns = computed(() => props.columns.filter((c) => c.searchable || c.filterable));
const showExpression = computed(() => props.searchable && props.expressionFilter && expressionColumns.value.length > 0);

function rawValue(row: T, column: DataTableColumn<T>): unknown {
  if (column.value) return column.value(row);
  return (row as Record<string, unknown>)[column.key];
}

function textOf(value: unknown): string {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join(" ");
  return String(value);
}

function fieldName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function columnFieldNames(column: DataTableColumn<T>): string[] {
  return [
    column.key,
    column.label,
    ...(column.filterAliases ?? []),
  ]
    .map(fieldName)
    .filter(Boolean);
}

function expressionPlaceholderText(): string {
  if (props.expressionPlaceholder) return props.expressionPlaceholder;
  const names = expressionColumns.value.flatMap(columnFieldNames);
  const shown = [...new Set(names)].slice(0, 4);
  if (shown.length === 0) return "AND(status:ok, name:edge)";
  return `AND(${shown.map((name) => `${name}:...`).join(", ")})`;
}

const expressionHelpText = computed(() => {
  if (props.expressionHelp) return props.expressionHelp;
  const names = expressionColumns.value.flatMap(columnFieldNames);
  const shown = [...new Set(names)].slice(0, 8);
  return shown.length
    ? t("common.table.expressionHelp", { fields: shown.join(", ") })
    : t("common.table.expressionHelpBare");
});

const expressionError = computed(() => {
  const expr = expressionTerm.value.trim();
  if (!expr) return "";
  const result = evalFilterExpression(expr, () => true);
  return result.ok ? "" : result.error ?? t("common.table.expressionInvalid");
});

function rowMatchesExpression(row: T, expression: string): boolean {
  if (!expression || expressionError.value) return true;
  const result = evalFilterExpression(expression, (rawToken) => {
    const token = normalizeExprToken(rawToken);
    const prefixed = token.match(/^([a-z0-9._-]+):(.*)$/);
    if (prefixed) {
      const [, rawField, value] = prefixed;
      const field = fieldName(rawField ?? "");
      if (!field || !value) return false;
      return expressionColumns.value.some((column) => {
        if (!columnFieldNames(column).includes(field)) return false;
        return tokenMatchesText(textOf(rawValue(row, column)), value);
      });
    }
    return expressionColumns.value.some((column) => tokenMatchesText(textOf(rawValue(row, column)), token));
  });
  return result.ok ? result.value : true;
}

/* ----------------------------- filtering ----------------------------- */
const filteredRows = computed(() => {
  const term = searchTerm.value.trim().toLowerCase();
  const expression = expressionTerm.value.trim();
  const cols = searchableColumns.value;
  return props.rows.filter((row) => {
    const matchesSearch =
      !term || cols.some((col) => textOf(rawValue(row, col)).toLowerCase().includes(term));
    return matchesSearch && rowMatchesExpression(row, expression);
  });
});

/* ----------------------------- sorting ----------------------------- */
const sortKey = ref<string | null>(seed.sort || null);
const sortDir = ref<SortDir>(seed.dir);

function toggleSort(column: DataTableColumn<T>): void {
  if (!column.sortable) return;
  if (sortKey.value !== column.key) {
    sortKey.value = column.key;
    sortDir.value = "asc";
    return;
  }
  // asc -> desc -> none
  if (sortDir.value === "asc") sortDir.value = "desc";
  else if (sortDir.value === "desc") {
    sortDir.value = null;
    sortKey.value = null;
  } else sortDir.value = "asc";
}

function compareValues(a: unknown, b: unknown): number {
  // null/undefined always sort last regardless of direction
  const aNil = a == null || a === "";
  const bNil = b == null || b === "";
  if (aNil && bNil) return 0;
  if (aNil) return 1;
  if (bNil) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  const an = typeof a === "number" ? a : Number(a);
  const bn = typeof b === "number" ? b : Number(b);
  if (!Number.isNaN(an) && !Number.isNaN(bn)) return an - bn;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}

const sortedRows = computed(() => {
  if (!sortKey.value || !sortDir.value) return filteredRows.value;
  const key = sortKey.value;
  const column = props.columns.find((c) => c.key === key);
  if (!column) return filteredRows.value;
  const dir = sortDir.value === "asc" ? 1 : -1;
  // copy before sorting to avoid mutating the source array
  return [...filteredRows.value].sort((a, b) => compareValues(rawValue(a, column), rawValue(b, column)) * dir);
});

function ariaSortFor(column: DataTableColumn<T>): "ascending" | "descending" | "none" | undefined {
  if (!column.sortable) return undefined;
  if (sortKey.value !== column.key || !sortDir.value) return "none";
  return sortDir.value === "asc" ? "ascending" : "descending";
}

/* ----------------------------- pagination ----------------------------- */
const page = ref(seed.page);
const paginationEnabled = computed(() => props.pageSize > 0);
const totalRows = computed(() => sortedRows.value.length);
const pageCount = computed(() =>
  paginationEnabled.value ? Math.max(1, Math.ceil(totalRows.value / props.pageSize)) : 1,
);

// Reset to first page whenever the result set shrinks below the current page window.
watch([totalRows, () => props.pageSize], () => {
  if (page.value > pageCount.value) page.value = pageCount.value;
  if (page.value < 1) page.value = 1;
});
/**
 * Narrowing or re-sorting the set invalidates the current page window, so the
 * table returns to the first page. Suppressed while a whole state is being
 * applied from the URL, where the page is part of what was asked for and must
 * not be reset by the search term arriving alongside it.
 */
let applyingFromUrl = false;
function resetPage(): void {
  if (!applyingFromUrl) page.value = 1;
}
watch(searchTerm, resetPage);
watch(expressionTerm, resetPage);
watch([sortKey, sortDir], resetPage);

const pagedRows = computed(() => {
  if (!paginationEnabled.value) return sortedRows.value;
  const start = (page.value - 1) * props.pageSize;
  return sortedRows.value.slice(start, start + props.pageSize);
});

const pageFrom = computed(() => (totalRows.value === 0 ? 0 : (page.value - 1) * props.pageSize + 1));
const pageTo = computed(() =>
  paginationEnabled.value ? Math.min(page.value * props.pageSize, totalRows.value) : totalRows.value,
);

/* ----------------------------- url sync ----------------------------- */
/**
 * Two-way mirror between the table's view state and the route query, active
 * only when the caller passed a `state-key`.
 *
 * Outbound: any change to search, filter, sort or page rewrites the query,
 * preserving every key this table does not own. `replace` rather than `push`
 * so typing in the search box does not bury the previous page under a stack
 * of history entries.
 *
 * Inbound: a query change this table did not cause (a pasted link, a
 * back-navigation, a filter chip elsewhere in the view) is applied to the
 * table. Both directions compare before acting, so the two watchers settle
 * instead of chasing each other.
 */
const urlState = computed<TableUrlState>(() => ({
  q: searchTerm.value.trim(),
  expr: expressionTerm.value.trim(),
  sort: sortDir.value ? sortKey.value ?? "" : "",
  dir: sortKey.value ? sortDir.value : null,
  page: page.value,
}));

if (props.stateKey) {
  const stateKey = props.stateKey;

  watch(urlState, (state) => {
    const current = readTableUrlState(route.query, stateKey, sortableKeys.value);
    if (tableUrlStatesEqual(current, state)) return;
    router.replace({ query: writeTableUrlState(route.query, stateKey, state) }).catch(() => {});
  });

  /**
   * Rewrite the address bar once if it asked for something this table refused:
   * a column that is not sortable, a direction that is not asc/desc, a page
   * below one, or a search on a table with nothing searchable. The URL then
   * describes the table actually on screen, so copying it hands over the same
   * view rather than the same broken request.
   */
  onMounted(() => {
    const canonical = writeTableUrlState(route.query, stateKey, urlState.value);
    const owned = Object.values(tableStateParams(stateKey));
    const drifted = owned.some((name) => (route.query[name] ?? undefined) !== (canonical[name] ?? undefined));
    if (drifted) router.replace({ query: canonical }).catch(() => {});
  });

  watch(
    () => route.query,
    (query) => {
      const incoming = readTableUrlState(query, stateKey, sortableKeys.value);
      if (tableUrlStatesEqual(incoming, urlState.value)) return;
      applyingFromUrl = true;
      nextTick(() => {
        applyingFromUrl = false;
      });
      // Mirror into both the debounced term and the visible input so the box
      // shows what is actually filtering.
      if (incoming.q !== searchTerm.value) {
        searchInput.value = incoming.q;
        searchTerm.value = incoming.q;
      }
      if (incoming.expr !== expressionTerm.value) {
        expressionInput.value = incoming.expr;
        expressionTerm.value = incoming.expr;
      }
      sortKey.value = incoming.sort || null;
      sortDir.value = incoming.dir;
      page.value = incoming.page;
    },
  );
}

/* ----------------------------- selection ----------------------------- */
const filteredIds = computed(() => filteredRows.value.map((row) => props.rowKey(row)));
const selectedCount = computed(() => selected.value.size);

const headerCheckboxState = computed<boolean | "indeterminate">(() => {
  const ids = filteredIds.value;
  if (ids.length === 0) return false;
  let count = 0;
  for (const id of ids) if (selected.value.has(id)) count++;
  if (count === 0) return false;
  if (count === ids.length) return true;
  return "indeterminate";
});

function toggleAll(value: boolean | "indeterminate"): void {
  const next = new Set(selected.value);
  if (value === true) {
    for (const id of filteredIds.value) next.add(id);
  } else {
    for (const id of filteredIds.value) next.delete(id);
  }
  selected.value = next;
}

function isRowSelected(row: T): boolean {
  return selected.value.has(props.rowKey(row));
}

function toggleRow(row: T, value: boolean | "indeterminate"): void {
  const id = props.rowKey(row);
  const next = new Set(selected.value);
  if (value === true) next.add(id);
  else next.delete(id);
  selected.value = next;
}

function clearSelection(): void {
  selected.value = new Set<string>();
}

/* ----------------------------- view state ----------------------------- */
const isEmpty = computed(() => props.rows.length === 0);
/**
 * No search over nothing: with zero rows and no filter the empty state
 * carries the create action, and a search box above it only pushes it down.
 * The page's #toolbar slot is not gated: it may hold the upstream filter that
 * emptied the rows, and hiding it would strand the operator.
 */
const searchShown = computed(() =>
  tableSearchVisible({
    rowCount: props.rows.length,
    filterActive: searchInput.value.trim() !== "" || expressionInput.value.trim() !== "",
  }),
);
const isNoMatch = computed(() => props.rows.length > 0 && filteredRows.value.length === 0);
const totalCount = computed(() => props.rows.length);
const shownCount = computed(() => filteredRows.value.length);

function alignClass(align: DataTableColumn<T>["align"]): string {
  if (align === "right") return "text-right";
  if (align === "center") return "text-center";
  return "text-left";
}
</script>

<template>
  <div :class="cn('space-y-4', props.class)">
    <!-- Toolbar -->
    <div v-if="(searchShown && (showSearch || showExpression)) || $slots.toolbar" class="space-y-2">
      <div class="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
        <div v-if="searchShown && (showSearch || showExpression)" class="grid grid-cols-1 min-w-0 flex-1 gap-2 md:grid-cols-2">
          <div v-if="showSearch" class="relative min-w-0 sm:min-w-[220px]">
            <Search
              class="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              v-model="searchInput"
              class="pl-8 pr-8"
              type="search"
              :placeholder="label.searchPlaceholder.value"
            />
            <button
              v-if="searchInput"
              type="button"
              class="absolute right-2 top-2.5 text-muted-foreground transition-colors hover:text-foreground"
              :aria-label="label.clearSearch.value"
              @click="searchInput = ''"
            >
              <X class="size-4" aria-hidden="true" />
            </button>
          </div>
          <div v-if="showExpression" class="relative min-w-0 sm:min-w-[240px]">
            <Funnel
              class="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              v-model="expressionInput"
              class="pl-8 pr-8 font-mono text-xs"
              :class="expressionError && 'border-destructive focus-visible:ring-destructive/20'"
              type="text"
              :placeholder="expressionPlaceholderText()"
              :aria-label="$t('common.table.expressionLabel')"
            />
            <button
              v-if="expressionInput"
              type="button"
              class="absolute right-2 top-2.5 text-muted-foreground transition-colors hover:text-foreground"
              :aria-label="label.clearSearch.value"
              @click="expressionInput = ''"
            >
              <X class="size-4" aria-hidden="true" />
            </button>
          </div>
        </div>
        <div v-if="$slots.toolbar" class="flex shrink-0 items-center gap-2 lg:ml-auto">
          <slot name="toolbar" />
        </div>
      </div>
      <p v-if="searchShown && showExpression" class="text-xs" :class="expressionError ? 'text-destructive' : 'text-muted-foreground'">
        {{ expressionError || expressionHelpText }}
      </p>
    </div>

    <!-- Showing X of Y -->
    <div
      v-if="showSummary && !loading && !error && !isEmpty"
      class="flex items-center justify-between text-xs text-muted-foreground"
    >
      <span>{{ label.showing.value }} {{ shownCount }} {{ label.of.value }} {{ totalCount }}</span>
    </div>

    <!-- Bulk action bar -->
    <div
      v-if="selectable && selectedCount > 0"
      class="sticky top-0 z-20 flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted px-3 py-2 text-sm"
    >
      <span class="font-medium tabular-nums">{{ selectedCount }}</span>
      <span class="text-muted-foreground">{{ label.of.value }} {{ shownCount }}</span>
      <Button
        size="sm"
        variant="ghost"
        type="button"
        :aria-label="label.clearSelection.value"
        :title="label.clearSelection.value"
        @click="clearSelection"
      >
        <X class="size-4" aria-hidden="true" />
      </Button>
      <div class="ms-auto flex items-center gap-2">
        <slot
          name="bulk-actions"
          :selected="selected"
          :count="selectedCount"
          :clear="clearSelection"
        />
      </div>
    </div>

    <DataState
      :loading="loading"
      :error="error"
      :has-data="hasData"
      :skeleton-rows="skeletonRows"
      :is-empty="isEmpty || isNoMatch"
      :empty-title="isNoMatch ? label.noMatchTitle.value : emptyTitle"
      :empty-description="isNoMatch ? label.noMatchDescription.value : emptyDescription"
      @retry="emit('retry')"
    >
      <template #empty>
        <slot v-if="isNoMatch" name="no-match">
          <slot name="empty" />
        </slot>
        <slot v-else name="empty" />
      </template>

      <!-- Desktop / tablet: real table (and phones too, in scroll layout) -->
      <!-- The scroller is the containing block (relative) for anything
           absolutely positioned in a cell: screen-reader text is position:
           absolute, and with the containing block outside the scroller it
           escaped the overflow clip and widened the page (NetGuard measured
           886 px at 375). A table with row detail is also a size
           container, so the detail sentence can be held to the visible
           width below. Only that table: containment is a cost every other
           table has no use for. (Measured in Chrome: a position:fixed child
           of this container still lands on the viewport, so the container
           does not capture fixed menus. A non-portaled absolute menu in a
           cell is clipped by the scroller's overflow either way; the
           console's menus are portaled.) -->
      <div
        :class="[
          narrowLayout === 'scroll' ? 'relative overflow-x-auto' : 'relative hidden overflow-x-auto md:block',
          $slots['row-detail'] && '[container-type:inline-size]',
        ]"
      >
        <table class="w-full min-w-[640px] text-sm">
          <thead class="sticky top-0 z-10 bg-background">
            <tr class="border-b border-border text-xs text-muted-foreground">
              <th v-if="selectable" scope="col" :class="cn('w-10 px-3 py-2', selectGutterClass)">
                <Checkbox
                  :model-value="headerCheckboxState"
                  :aria-label="label.selectAll.value"
                  @update:model-value="toggleAll"
                />
              </th>
              <th
                v-for="(column, index) in columns"
                :key="column.key"
                scope="col"
                :class="cn('px-3 py-2 font-medium', alignClass(column.align), cellPinClass(column, index), column.class)"
                :aria-sort="ariaSortFor(column)"
              >
                <button
                  v-if="column.sortable"
                  type="button"
                  class="inline-flex items-center gap-1 rounded-sm outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  :class="{
                    'ms-auto flex-row-reverse': column.align === 'right',
                    'mx-auto': column.align === 'center',
                  }"
                  @click="toggleSort(column)"
                >
                  <span>{{ column.label }}</span>
                  <ChevronUp
                    v-if="sortKey === column.key && sortDir === 'asc'"
                    class="size-3.5"
                    aria-hidden="true"
                  />
                  <ChevronDown
                    v-else-if="sortKey === column.key && sortDir === 'desc'"
                    class="size-3.5"
                    aria-hidden="true"
                  />
                  <ChevronsUpDown
                    v-else
                    class="size-3.5 opacity-50"
                    aria-hidden="true"
                  />
                </button>
                <span v-else>{{ column.label }}</span>
              </th>
              <th v-if="rowTo" scope="col" :class="cn('w-8 px-2', chevronGutterClass)" aria-hidden="true"></th>
            </tr>
          </thead>
          <tbody>
            <template v-for="row in pagedRows" :key="rowKey(row)">
            <tr
              class="group border-b border-border last:border-0 bg-(--row-bg) [--row-hover:color-mix(in_oklab,var(--muted)_40%,var(--background))] hover:[--row-bg:var(--row-hover)] data-[active]:[--row-bg:var(--muted)]"
              :class="{
                '[--row-bg:color-mix(in_oklab,var(--muted)_30%,var(--background))]': selectable && isRowSelected(row),
                'cursor-pointer focus-row': rowActivatable,
              }"
              :data-row-key="rowKey(row)"
              :data-active="isActive(row) ? '' : undefined"
              :aria-current="isActive(row) ? 'true' : undefined"
              :tabindex="rowActivatable ? 0 : undefined"
              @click="rowActivatable && onRowActivate(row, $event)"
              @keydown="rowActivatable && onRowKeydown(row, $event)"
            >
              <td v-if="selectable" :class="cn('w-10 px-3 py-3 align-top', selectGutterClass)">
                <Checkbox
                  :model-value="isRowSelected(row)"
                  :aria-label="label.selectRow.value"
                  @update:model-value="(value) => toggleRow(row, value)"
                />
              </td>
              <td
                v-for="(column, index) in columns"
                :key="column.key"
                :class="cn('px-3 py-3 align-middle', alignClass(column.align), cellPinClass(column, index), column.class)"
              >
                <slot
                  :name="`cell-${column.key}`"
                  :row="row"
                  :value="rawValue(row, column)"
                >
                  {{ textOf(rawValue(row, column)) }}
                </slot>
              </td>
              <td v-if="rowTo" :class="cn('w-8 px-2 text-right align-middle', chevronGutterClass)">
                <ChevronRight
                  class="ms-auto size-4 text-muted-foreground opacity-40 transition-opacity group-hover:opacity-90"
                  aria-hidden="true"
                />
              </td>
            </tr>
            <tr v-if="isRowExpanded(row)" class="border-b border-border bg-muted/20 last:border-0">
              <td :colspan="spannedColumns" class="px-3 pb-3 pt-0">
                <!-- The cell spans every column, so it is as wide as the
                     table; the sentence stays on the visible part while the
                     columns scroll, and wraps to it. -->
                <div class="sticky left-3 max-w-[calc(100cqw-1.5rem)]">
                  <slot name="row-detail" :row="row" />
                </div>
              </td>
            </tr>
            </template>
          </tbody>
        </table>
      </div>

      <!-- Mobile: stacked cards -->
      <ul v-if="!isDesktop && narrowLayout === 'cards'" class="space-y-3 md:hidden">
        <li
          v-for="row in pagedRows"
          :key="rowKey(row)"
          class="rounded-lg border border-border p-3"
          :class="{
            'ring-1 ring-primary/40': (selectable && isRowSelected(row)) || isActive(row),
            'surface-interactive focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring': rowActivatable,
          }"
          :data-row-key="rowKey(row)"
          :aria-current="isActive(row) ? 'true' : undefined"
          :tabindex="rowActivatable ? 0 : undefined"
          @click="rowActivatable && onRowActivate(row, $event)"
          @keydown="rowActivatable && onRowKeydown(row, $event)"
        >
          <div v-if="selectable" class="mb-2 flex items-center gap-2">
            <Checkbox
              :model-value="isRowSelected(row)"
              :aria-label="label.selectRow.value"
              @update:model-value="(value) => toggleRow(row, value)"
            />
          </div>
          <dl class="space-y-2">
            <div
              v-for="column in columns"
              :key="column.key"
              class="flex items-start justify-between gap-3"
            >
              <dt class="shrink-0 text-xs font-medium text-muted-foreground">{{ column.label }}</dt>
              <dd class="min-w-0 text-right text-sm">
                <slot
                  :name="`cell-${column.key}`"
                  :row="row"
                  :value="rawValue(row, column)"
                >
                  {{ textOf(rawValue(row, column)) }}
                </slot>
              </dd>
            </div>
          </dl>
          <div v-if="isRowExpanded(row)" class="mt-3 border-t border-border pt-3">
            <slot name="row-detail" :row="row" />
          </div>
        </li>
      </ul>

      <!-- Pagination -->
      <PaginationRoot
        v-if="paginationEnabled && totalRows > 0"
        v-slot="{ pageCount: pages }"
        v-model:page="page"
        :total="totalRows"
        :items-per-page="pageSize"
        :sibling-count="1"
        show-edges
        class="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
      >
        <p class="text-xs text-muted-foreground">
          {{ label.showing.value }} {{ pageFrom }}-{{ pageTo }} {{ label.pageOf.value }} {{ totalRows }}
        </p>
        <div class="flex items-center gap-1">
          <Button
            size="icon-sm"
            variant="outline"
            type="button"
            :disabled="page <= 1"
            :aria-label="label.prev.value"
            @click="page = Math.max(1, page - 1)"
          >
            <ChevronLeft class="size-4" aria-hidden="true" />
          </Button>
          <span class="px-2 text-xs tabular-nums text-muted-foreground">
            {{ page }} / {{ pages }}
          </span>
          <Button
            size="icon-sm"
            variant="outline"
            type="button"
            :disabled="page >= pages"
            :aria-label="label.next.value"
            @click="page = Math.min(pages, page + 1)"
          >
            <ChevronRight class="size-4" aria-hidden="true" />
          </Button>
        </div>
      </PaginationRoot>
    </DataState>
  </div>
</template>

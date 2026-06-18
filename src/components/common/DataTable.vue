<script setup lang="ts" generic="T">
import { computed, ref, watch, type HTMLAttributes } from "vue";
import { useDebounceFn, useMediaQuery } from "@vueuse/core";
import { PaginationRoot } from "reka-ui";
import { ChevronDown, ChevronUp, ChevronsUpDown, ChevronLeft, ChevronRight, Search, X } from "lucide-vue-next";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import DataState from "./DataState.vue";

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
  /** Extra classes applied to both the header cell and body cells. */
  class?: HTMLAttributes["class"];
  /** Custom accessor for sort/search/default-cell value (defaults to `row[key]`). */
  value?: (row: Row) => unknown;
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
    /** Client-side page size; 0 disables pagination. */
    pageSize?: number;
    /** Shows the built-in debounced search box (requires >=1 searchable column). */
    searchable?: boolean;
    /** Placeholder for the search box. */
    searchPlaceholder?: string;
    /** Accessible label for the clear-search button. */
    clearSearchLabel?: string;
    /** Label for the actions column shown in the stacked mobile card. */
    actionsLabel?: string;
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
    selectRowLabel?: string;
    /** Wrapper class. */
    class?: HTMLAttributes["class"];
  }>(),
  {
    loading: false,
    error: null,
    skeletonRows: 5,
    emptyTitle: undefined,
    emptyDescription: undefined,
    noMatchTitle: "No matching results",
    noMatchDescription: "Try adjusting your search or filters.",
    selectable: false,
    pageSize: 0,
    searchable: false,
    searchPlaceholder: "Search…",
    clearSearchLabel: "Clear search",
    actionsLabel: "Actions",
    showingLabel: "Showing",
    ofLabel: "of",
    pageOfLabel: "of",
    prevLabel: "Previous page",
    nextLabel: "Next page",
    selectAllLabel: "Select all rows",
    selectRowLabel: "Select row",
  },
);

const emit = defineEmits<{ retry: [] }>();

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
  } & Record<`cell-${string}`, (props: { row: T; value: unknown }) => unknown>
>();

const isDesktop = useMediaQuery("(min-width: 768px)");

/* ----------------------------- search ----------------------------- */
const searchInput = ref("");
const searchTerm = ref("");
const applySearch = useDebounceFn((value: string) => {
  searchTerm.value = value;
}, 200);
watch(searchInput, (value) => applySearch(value));

const searchableColumns = computed(() => props.columns.filter((c) => c.searchable));
const showSearch = computed(() => props.searchable && searchableColumns.value.length > 0);

function rawValue(row: T, column: DataTableColumn<T>): unknown {
  if (column.value) return column.value(row);
  return (row as Record<string, unknown>)[column.key];
}

function textOf(value: unknown): string {
  if (value == null) return "";
  return String(value);
}

/* ----------------------------- filtering ----------------------------- */
const filteredRows = computed(() => {
  const term = searchTerm.value.trim().toLowerCase();
  if (!term) return props.rows;
  const cols = searchableColumns.value;
  return props.rows.filter((row) =>
    cols.some((col) => textOf(rawValue(row, col)).toLowerCase().includes(term)),
  );
});

/* ----------------------------- sorting ----------------------------- */
const sortKey = ref<string | null>(null);
const sortDir = ref<SortDir>(null);

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
const page = ref(1);
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
watch(searchTerm, () => {
  page.value = 1;
});

const pagedRows = computed(() => {
  if (!paginationEnabled.value) return sortedRows.value;
  const start = (page.value - 1) * props.pageSize;
  return sortedRows.value.slice(start, start + props.pageSize);
});

const pageFrom = computed(() => (totalRows.value === 0 ? 0 : (page.value - 1) * props.pageSize + 1));
const pageTo = computed(() =>
  paginationEnabled.value ? Math.min(page.value * props.pageSize, totalRows.value) : totalRows.value,
);

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
    <div
      v-if="showSearch || $slots.toolbar"
      class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
    >
      <div v-if="showSearch" class="relative w-full sm:max-w-xs">
        <Search
          class="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          v-model="searchInput"
          class="pl-8 pr-8"
          type="search"
          :placeholder="searchPlaceholder"
        />
        <button
          v-if="searchInput"
          type="button"
          class="absolute right-2 top-2.5 text-muted-foreground transition-colors hover:text-foreground"
          :aria-label="clearSearchLabel"
          @click="searchInput = ''"
        >
          <X class="size-4" aria-hidden="true" />
        </button>
      </div>
      <div class="flex items-center gap-2">
        <slot name="toolbar" />
      </div>
    </div>

    <!-- Showing X of Y -->
    <div
      v-if="!loading && !error && !isEmpty"
      class="flex items-center justify-between text-xs text-muted-foreground"
    >
      <span>{{ showingLabel }} {{ shownCount }} {{ ofLabel }} {{ totalCount }}</span>
    </div>

    <!-- Bulk action bar -->
    <div
      v-if="selectable && selectedCount > 0"
      class="sticky top-0 z-20 flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/60 px-3 py-2 text-sm backdrop-blur"
    >
      <span class="font-medium tabular-nums">{{ selectedCount }}</span>
      <span class="text-muted-foreground">{{ ofLabel }} {{ shownCount }}</span>
      <Button size="sm" variant="ghost" type="button" @click="clearSelection">
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
      :skeleton-rows="skeletonRows"
      :is-empty="isEmpty || isNoMatch"
      :empty-title="isNoMatch ? noMatchTitle : emptyTitle"
      :empty-description="isNoMatch ? noMatchDescription : emptyDescription"
      @retry="emit('retry')"
    >
      <template #empty>
        <slot v-if="isNoMatch" name="no-match">
          <slot name="empty" />
        </slot>
        <slot v-else name="empty" />
      </template>

      <!-- Desktop / tablet: real table -->
      <div class="hidden overflow-x-auto md:block">
        <table class="w-full min-w-[640px] text-sm">
          <thead class="sticky top-0 z-10 bg-background">
            <tr class="border-b border-border text-xs text-muted-foreground">
              <th v-if="selectable" scope="col" class="w-10 px-3 py-2">
                <Checkbox
                  :model-value="headerCheckboxState"
                  :aria-label="selectAllLabel"
                  @update:model-value="toggleAll"
                />
              </th>
              <th
                v-for="column in columns"
                :key="column.key"
                scope="col"
                class="px-3 py-2 font-medium"
                :class="[alignClass(column.align), column.class]"
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
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in pagedRows"
              :key="rowKey(row)"
              class="border-b border-border last:border-0 hover:bg-muted/40"
              :class="{ 'bg-muted/30': selectable && isRowSelected(row) }"
            >
              <td v-if="selectable" class="px-3 py-3 align-top">
                <Checkbox
                  :model-value="isRowSelected(row)"
                  :aria-label="selectRowLabel"
                  @update:model-value="(value) => toggleRow(row, value)"
                />
              </td>
              <td
                v-for="column in columns"
                :key="column.key"
                class="px-3 py-3 align-middle"
                :class="[alignClass(column.align), column.class]"
              >
                <slot
                  :name="`cell-${column.key}`"
                  :row="row"
                  :value="rawValue(row, column)"
                >
                  {{ textOf(rawValue(row, column)) }}
                </slot>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Mobile: stacked cards -->
      <ul v-if="!isDesktop" class="space-y-3 md:hidden">
        <li
          v-for="row in pagedRows"
          :key="rowKey(row)"
          class="rounded-lg border border-border p-3"
          :class="{ 'ring-1 ring-primary/40': selectable && isRowSelected(row) }"
        >
          <div v-if="selectable" class="mb-2 flex items-center gap-2">
            <Checkbox
              :model-value="isRowSelected(row)"
              :aria-label="selectRowLabel"
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
          {{ showingLabel }} {{ pageFrom }}-{{ pageTo }} {{ pageOfLabel }} {{ totalRows }}
        </p>
        <div class="flex items-center gap-1">
          <Button
            size="icon-sm"
            variant="outline"
            type="button"
            :disabled="page <= 1"
            :aria-label="prevLabel"
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
            :aria-label="nextLabel"
            @click="page = Math.min(pages, page + 1)"
          >
            <ChevronRight class="size-4" aria-hidden="true" />
          </Button>
        </div>
      </PaginationRoot>
    </DataState>
  </div>
</template>

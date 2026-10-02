/**
 * The QueryBar wiring an Operations collection shares (Tasks, Audit,
 * Approvals history): the applied tokens, the range and the server page, all
 * read from the page's own address and written back with `replace`, the way
 * Evidence Explore does it.
 *
 *   const q = useOpsQuery({ grammar, resolvers, defaultRange: "24h", unchecked });
 *   <QueryBar ref="bar" :applied-text="q.appliedText.value" :applied-key="q.appliedKey.value"
 *     :problems="q.problems" :canonical="q.canonical" @submit="q.submit" @clear="q.clear"
 *     :range="q.range.value.range" @update:range="q.setRange" ... />
 *
 * A new question or a new window is a new first page, so both drop the
 * offset. Reads and writes go through useOwnedRoute: a page that is leaving
 * never writes the next page's address.
 */
import { computed, ref, type Ref } from "vue";
import { useI18n } from "vue-i18n";

import type QueryBar from "@/components/common/QueryBar.vue";
import { useOwnedRoute, type OwnedRoute } from "@/composables/useOwnedRoute";
import {
  EMPTY_TOKEN_VALUES,
  formatTokens,
  parseTokens,
  readTokenQuery,
  writeTokenQuery,
  type TokenGrammar,
  type TokenProblem,
  type TokenResolvers,
  type TokenValues,
} from "@/lib/queryTokens";

import { isOpsRange, readOffset, readRange, writeOffset, writeRange, type OpsRange } from "./opsQueryModel";

export interface OpsQueryOptions {
  grammar: TokenGrammar;
  resolvers: () => TokenResolvers;
  defaultRange: OpsRange;
  /**
   * True while a list names resolve against has not loaded: a name that does
   * not resolve was then never looked up, and the copy says so instead of
   * saying it names nothing.
   */
  unchecked?: () => boolean;
  /**
   * For a collection the server cannot search by text: free text is left out
   * of the address and the request, and this sentence says so while typing.
   */
  noText?: () => string;
  /**
   * With noText: the sentence for a `key:` word the page has no filter for
   * (actor: on Approvals history). Such a word is named on its own instead
   * of as "words", and stays in the field after Apply, so the operator sees
   * what was left out rather than an empty field over an unfiltered list.
   */
  notFilter?: (key: string) => string;
  owned?: OwnedRoute;
}

/** A `key:value` word, as an operator types a filter. */
const KEYED_WORD = /^([a-z][a-z0-9_-]*):\S/i;

export function useOpsQuery(options: OpsQueryOptions) {
  const { t } = useI18n();
  const owned = options.owned ?? useOwnedRoute();
  const grammar = options.grammar;

  const applied = computed<TokenValues>(() => readTokenQuery(owned.query(), grammar));
  /**
   * The `key:` words the last Apply left out (notFilter). They are not in
   * the address, so a reload drops them; until the next question they ride
   * along in the field's text, beside the sentence that says they were not
   * applied.
   */
  const kept = ref<string[]>([]);
  const appliedText = computed(() => [formatTokens(applied.value, grammar, options.resolvers()), ...kept.value].filter(Boolean).join(" "));
  /** Whether the address narrows the list at all; the kept words do not. */
  const narrowed = computed(() => formatTokens(applied.value, grammar, options.resolvers()) !== "");
  /** The applied question itself, which a name list loading later does not change. */
  const appliedKey = computed(() => JSON.stringify(applied.value));
  const range = computed(() => readRange(owned.query(), options.defaultRange));
  const offset = computed(() => readOffset(owned.query()));

  function write(values: TokenValues): void {
    owned.replace(writeOffset(writeTokenQuery(owned.query(), grammar, values), 0));
  }

  function parse(text: string) {
    const parsed = parseTokens(text, grammar, options.resolvers());
    return options.noText ? { ...parsed, text: "" } : parsed;
  }

  function freeText(text: string): string {
    return parseTokens(text, grammar, options.resolvers()).text;
  }

  /** The free words, and the ones among them that look like filters this page lacks. */
  function leftOut(text: string): { words: string[]; keyed: string[] } {
    const words = freeText(text).split(/\s+/).filter(Boolean);
    return { words, keyed: options.noText && options.notFilter ? words.filter((word) => KEYED_WORD.test(word)) : [] };
  }

  function problemText(problem: TokenProblem): string {
    if (problem.kind === "unresolved") {
      return t(options.unchecked?.() ? "operations.query.problemUnchecked" : "operations.query.problemUnresolved", { token: problem.token });
    }
    return t(problem.kind === "empty-value" ? "operations.query.problemEmpty" : "operations.query.problemUnknown", { token: problem.token });
  }

  return {
    owned,
    applied,
    appliedText,
    narrowed,
    appliedKey,
    range,
    offset,
    submit(text: string): void {
      kept.value = leftOut(text).keyed;
      write(parse(text));
    },
    clear(): void {
      kept.value = [];
      write(EMPTY_TOKEN_VALUES);
    },
    problems(text: string): string[] {
      const list = parse(text).problems.map(problemText);
      if (!options.noText) return list;
      const { words, keyed } = leftOut(text);
      for (const key of new Set(keyed.map((word) => word.slice(0, word.indexOf(":")).toLowerCase()))) list.push(options.notFilter?.(key) ?? "");
      if (words.length > keyed.length) list.push(options.noText());
      return list.filter(Boolean);
    },
    canonical(text: string): string {
      const applied = formatTokens(parse(text), grammar, options.resolvers());
      return [applied, ...leftOut(text).keyed].filter(Boolean).join(" ");
    },
    /** Apply a change the page made itself (a Filters choice) and show it in the field. */
    edit(bar: Ref<InstanceType<typeof QueryBar> | null>, mutate: (values: TokenValues) => void): void {
      const next = parse(bar.value?.draft ?? appliedText.value);
      const values: TokenValues = {
        values: { ...next.values },
        enums: Object.fromEntries(Object.entries(next.enums).map(([key, list]) => [key, [...list]])),
        flags: [...next.flags],
        text: next.text,
      };
      mutate(values);
      kept.value = [];
      write(values);
      bar.value?.settle(formatTokens(values, grammar, options.resolvers()));
    },
    setRange(value: string): void {
      if (!isOpsRange(value)) return;
      owned.replace(writeRange(owned.query(), { ...range.value, range: value }, options.defaultRange));
    },
    setBound(which: "since" | "until", iso: string): void {
      owned.replace(writeRange(owned.query(), { ...range.value, range: "custom", [which]: iso }, options.defaultRange));
    },
    setOffset(next: number): void {
      owned.replace(writeOffset(owned.query(), Math.max(0, next)));
    },
  };
}

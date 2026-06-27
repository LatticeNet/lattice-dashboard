// Line-based diff used by the plan/approval review UI so an operator can see
// exactly what a change does (before → after) instead of re-reading a whole
// rendered config. Pure + dependency-free.

export type DiffLineType = "add" | "del" | "ctx";
export interface DiffLine {
  type: DiffLineType;
  text: string;
}
export interface DiffResult {
  lines: DiffLine[];
  added: number;
  removed: number;
  /** true when the inputs were too large for an LCS diff and we fell back. */
  truncated: boolean;
}

// Guard the O(n·m) LCS table: ~2000×2000 lines is already 4M cells. Beyond that
// we skip the diff and let the caller show the full plan instead of janking.
const MAX_LCS_CELLS = 4_000_000;

function splitLines(s: string): string[] {
  if (!s) return [];
  return s.replace(/\r\n/g, "\n").split("\n");
}

export function diffLines(before: string, after: string): DiffResult {
  const a = splitLines(before);
  const b = splitLines(after);
  const n = a.length;
  const m = b.length;

  if (n * m > MAX_LCS_CELLS) {
    // Fallback: present the new content as all-added; the caller can offer the
    // raw full-plan toggle for very large artifacts.
    const lines = b.map<DiffLine>((text) => ({ type: "add", text }));
    return { lines, added: b.length, removed: 0, truncated: true };
  }

  // dp[i][j] = LCS length of a[i:], b[j:].
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      lines.push({ type: "ctx", text: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      lines.push({ type: "del", text: a[i]! });
      removed++;
      i++;
    } else {
      lines.push({ type: "add", text: b[j]! });
      added++;
      j++;
    }
  }
  while (i < n) {
    lines.push({ type: "del", text: a[i]! });
    removed++;
    i++;
  }
  while (j < m) {
    lines.push({ type: "add", text: b[j]! });
    added++;
    j++;
  }
  return { lines, added, removed, truncated: false };
}

/**
 * A shell tokenizer for reading scripts, not for running them.
 *
 * The console shows scripts a node ran or will run: a task's script after
 * step-up, and the plans that are shell (SSH Guard's apply, the witness
 * configure, the line-chain apply). Highlighting them is a reading aid only,
 * so this is deliberately small and audited rather than a grammar:
 *
 * - Lossless. Every character of the input lands in exactly one token, in
 *   order, and the lines joined with "\n" are the input. The view renders
 *   token text as text nodes (never HTML), so what the operator reads is
 *   byte for byte what was hashed and what Copy copies.
 * - Total. Any input tokenizes: an unterminated quote, substitution or
 *   heredoc runs to the end as what it was, and nothing throws.
 * - Linear and flat. One pass over the characters with an explicit frame
 *   stack, so a deeply nested `$( $( ... ) )` cannot overflow the call stack.
 *
 * Known approximations, all of which only change a colour: a `case` pattern's
 * `)` inside `$( ... )` closes the substitution early; a heredoc opened inside
 * a double-quoted string that spans lines starts at the next unquoted line
 * end; expansions inside an unquoted heredoc body are found per line.
 */

export type ShellTokenKind =
  | "plain"
  | "comment"
  | "string"
  | "heredoc"
  | "variable"
  | "keyword"
  | "builtin"
  | "operator"
  | "number";

export interface ShellToken {
  kind: ShellTokenKind;
  text: string;
}

export interface ShellLine {
  tokens: ShellToken[];
  /** A line inside a heredoc body: the text of a file the script writes. */
  heredoc: boolean;
}

export type ScriptLanguage = "shell" | "plain";

/**
 * Above this many characters a script is shown without colour. Task scripts
 * are capped at 64 KiB by the server; a plan can be larger, and past this the
 * cost is the thousands of rows, not the tokenizer.
 */
export const HIGHLIGHT_LIMIT = 512 * 1024;

const KEYWORDS = new Set([
  "if", "then", "elif", "else", "fi", "case", "esac", "for", "select", "while", "until",
  "do", "done", "function", "time", "coproc", "{", "}", "!", "[[", "]]",
]);

/** Keywords after which the next word is a command again. */
const LEADS_COMMAND = new Set(["if", "then", "elif", "else", "while", "until", "do", "time", "{", "!"]);

const BUILTINS = new Set([
  ".", ":", "[", "alias", "bg", "bind", "break", "builtin", "caller", "cd", "command", "compgen",
  "complete", "continue", "declare", "dirs", "disown", "echo", "enable", "eval", "exec", "exit",
  "export", "false", "fc", "fg", "getopts", "hash", "help", "history", "jobs", "kill", "let",
  "local", "logout", "mapfile", "popd", "printf", "pushd", "pwd", "read", "readarray", "readonly",
  "return", "set", "shift", "shopt", "source", "suspend", "test", "times", "trap", "true", "type",
  "typeset", "ulimit", "umask", "unalias", "unset", "wait",
]);

/** Longest first, so `<<-` wins over `<<` and `&&` over `&`. */
const OPERATORS = ["<<<", "<<-", ";;&", "&>>", "<<", ">>", "&&", "||", ";;", ";&", "|&", ">&", "<&", "&>", ">|", "<>", "|", "&", ";", "<", ">", "(", ")"];

/** Operators after which the next word is a command. */
const SEPARATES = new Set(["&&", "||", ";;", ";&", ";;&", "|&", "|", "&", ";", "("]);

const NUMBER = /^\d+(\.\d+)?$/;
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?)(\+?=)/;
const NAME_START = /[A-Za-z_]/;
const NAME_CHAR = /[A-Za-z0-9_]/;

type Frame =
  | { t: "cmd"; end: "" | ")" | "`"; depth: number; atCommand: boolean; pendingIn: boolean }
  | { t: "dq" }
  | { t: "param"; depth: number }
  | { t: "arith"; depth: number };

interface PendingHeredoc {
  delim: string;
  stripTabs: boolean;
  quoted: boolean;
}

/** Characters that end a word at command level. */
function endsWord(c: string): boolean {
  return c === " " || c === "\t" || c === "\r" || c === "\n" || c === "|" || c === "&" || c === ";" || c === "<" || c === ">"
    || c === "(" || c === ")" || c === "'" || c === "\"" || c === "`" || c === "$" || c === "\\";
}

function isBoundary(c: string | undefined): boolean {
  return c === undefined || c === " " || c === "\t" || c === "\r" || c === "\n" || c === "|" || c === "&" || c === ";"
    || c === "<" || c === ">" || c === "(" || c === ")";
}

class Lexer {
  private readonly src: string;
  private readonly n: number;
  private i = 0;
  readonly lines: ShellLine[] = [];
  private cur: ShellLine;
  private readonly frames: Frame[] = [{ t: "cmd", end: "", depth: 0, atCommand: true, pendingIn: false }];
  private pending: PendingHeredoc[] = [];

  constructor(src: string) {
    this.src = src;
    this.n = src.length;
    this.cur = { tokens: [], heredoc: false };
    this.lines.push(this.cur);
  }

  run(): ShellLine[] {
    while (this.i < this.n) {
      const frame = this.frames[this.frames.length - 1]!;
      switch (frame.t) {
        case "cmd":
          this.stepCommand(frame);
          break;
        case "dq":
          this.stepDouble();
          break;
        case "param":
          this.stepParam(frame);
          break;
        case "arith":
          this.stepArith(frame);
          break;
      }
    }
    return this.lines;
  }

  /** Append text as one kind, starting a new line at every "\n". */
  private emit(kind: ShellTokenKind, text: string): void {
    if (!text) return;
    let start = 0;
    for (;;) {
      const nl = text.indexOf("\n", start);
      const part = nl === -1 ? text.slice(start) : text.slice(start, nl);
      if (part) {
        const tokens = this.cur.tokens;
        const last = tokens[tokens.length - 1];
        if (last && last.kind === kind) last.text += part;
        else tokens.push({ kind, text: part });
      }
      if (nl === -1) return;
      this.cur = { tokens: [], heredoc: false };
      this.lines.push(this.cur);
      start = nl + 1;
    }
  }

  private take(kind: ShellTokenKind, length: number): void {
    this.emit(kind, this.src.slice(this.i, this.i + length));
    this.i += length;
  }

  private stepCommand(frame: Extract<Frame, { t: "cmd" }>): void {
    const src = this.src;
    const c = src[this.i]!;

    if (frame.end === ")" && c === ")" && frame.depth === 0) {
      this.take("variable", 1);
      this.frames.pop();
      return;
    }
    if (frame.end === "`" && c === "`") {
      this.take("variable", 1);
      this.frames.pop();
      return;
    }
    if (c === "\n") {
      this.take("plain", 1);
      frame.atCommand = true;
      frame.pendingIn = false;
      if (this.pending.length) this.readHeredocs();
      return;
    }
    if (c === " " || c === "\t" || c === "\r") {
      let j = this.i + 1;
      while (j < this.n && (src[j] === " " || src[j] === "\t" || src[j] === "\r")) j++;
      this.take("plain", j - this.i);
      return;
    }
    if (c === "\\") {
      this.take("plain", Math.min(2, this.n - this.i));
      frame.atCommand = false;
      return;
    }
    if (c === "#" && (this.i === 0 || isBoundary(src[this.i - 1]))) {
      const nl = src.indexOf("\n", this.i);
      this.take("comment", (nl === -1 ? this.n : nl) - this.i);
      return;
    }
    if (c === "'") {
      const close = src.indexOf("'", this.i + 1);
      this.take("string", (close === -1 ? this.n : close + 1) - this.i);
      frame.atCommand = false;
      return;
    }
    if (c === "\"") {
      this.take("string", 1);
      this.frames.push({ t: "dq" });
      frame.atCommand = false;
      return;
    }
    if (c === "$") {
      frame.atCommand = false;
      this.dollar(true);
      return;
    }
    if (c === "`") {
      this.take("variable", 1);
      frame.atCommand = false;
      this.frames.push({ t: "cmd", end: "`", depth: 0, atCommand: true, pendingIn: false });
      return;
    }
    const op = OPERATORS.find((candidate) => src.startsWith(candidate, this.i));
    if (op) {
      this.operator(frame, op);
      return;
    }
    this.word(frame);
  }

  private operator(frame: Extract<Frame, { t: "cmd" }>, op: string): void {
    this.take("operator", op.length);
    if (op === "(" && frame.end === ")") frame.depth++;
    if (op === ")" && frame.end === ")" && frame.depth > 0) frame.depth--;
    if (SEPARATES.has(op)) {
      frame.atCommand = true;
      frame.pendingIn = false;
    }
    if (op === "<<" || op === "<<-") this.heredocStart(op === "<<-");
  }

  /** After `<<` or `<<-`: the delimiter word, which may be quoted in part or whole. */
  private heredocStart(stripTabs: boolean): void {
    const src = this.src;
    let j = this.i;
    while (j < this.n && (src[j] === " " || src[j] === "\t")) j++;
    this.take("plain", j - this.i);
    let k = this.i;
    while (k < this.n) {
      const c = src[k]!;
      if (c === "'" || c === "\"") {
        const close = src.indexOf(c, k + 1);
        k = close === -1 ? this.n : close + 1;
        continue;
      }
      if (c === "\\") {
        k = Math.min(this.n, k + 2);
        continue;
      }
      if (c === " " || c === "\t" || c === "\n" || c === "|" || c === "&" || c === ";" || c === "<" || c === ">" || c === "(" || c === ")") break;
      k++;
    }
    const raw = src.slice(this.i, k);
    this.take("string", k - this.i);
    const delim = raw.replace(/\\(.)/g, "$1").replace(/['"]/g, "");
    if (delim) this.pending.push({ delim, stripTabs, quoted: /['"\\]/.test(raw) });
  }

  /** Each pending heredoc body in turn, starting at the line after the one that opened it. */
  private readHeredocs(): void {
    const src = this.src;
    for (const doc of this.pending) {
      while (this.i < this.n) {
        const nl = src.indexOf("\n", this.i);
        const end = nl === -1 ? this.n : nl;
        const line = src.slice(this.i, end);
        const compared = doc.stripTabs ? line.replace(/^\t+/, "") : line;
        if (compared === doc.delim) {
          this.take("string", end - this.i);
          if (nl !== -1) this.take("plain", 1);
          break;
        }
        this.cur.heredoc = true;
        if (doc.quoted) this.emit("heredoc", line);
        else this.heredocLine(line);
        this.i = end;
        if (nl !== -1) this.take("plain", 1);
      }
    }
    this.pending = [];
  }

  /** An unquoted heredoc line: the shell expands `$name`, `${...}`, `$(...)` and backquotes in it. */
  private heredocLine(line: string): void {
    let start = 0;
    let k = 0;
    const flush = (to: number) => {
      this.emit("heredoc", line.slice(start, to));
    };
    while (k < line.length) {
      const c = line[k]!;
      if (c === "\\") {
        k += 2;
        continue;
      }
      if (c === "$" || c === "`") {
        const end = expansionEnd(line, k);
        if (end > k) {
          flush(k);
          this.emit("variable", line.slice(k, end));
          start = end;
          k = end;
          continue;
        }
      }
      k++;
    }
    flush(Math.min(k, line.length));
  }

  /**
   * `$` at the cursor. In a command or a double-quoted string the forms are
   * the same, except that `$'...'` quoting exists only outside quotes.
   */
  private dollar(unquoted: boolean): void {
    const src = this.src;
    const next = src[this.i + 1];
    if (next === "(" && src[this.i + 2] === "(") {
      this.take("variable", 3);
      this.frames.push({ t: "arith", depth: 0 });
      return;
    }
    if (next === "(") {
      this.take("variable", 2);
      this.frames.push({ t: "cmd", end: ")", depth: 0, atCommand: true, pendingIn: false });
      return;
    }
    if (next === "{") {
      this.take("variable", 2);
      this.frames.push({ t: "param", depth: 0 });
      return;
    }
    if (unquoted && next === "'") {
      let k = this.i + 2;
      while (k < this.n && src[k] !== "'") k += src[k] === "\\" ? 2 : 1;
      this.take("string", Math.min(this.n, k + 1) - this.i);
      return;
    }
    if (unquoted && next === "\"") {
      this.take("string", 2);
      this.frames.push({ t: "dq" });
      return;
    }
    if (next !== undefined && NAME_START.test(next)) {
      let k = this.i + 2;
      while (k < this.n && NAME_CHAR.test(src[k]!)) k++;
      this.take("variable", k - this.i);
      return;
    }
    if (next !== undefined && /[0-9@*#?$!-]/.test(next)) {
      this.take("variable", 2);
      return;
    }
    this.take(unquoted ? "plain" : "string", 1);
  }

  private word(frame: Extract<Frame, { t: "cmd" }>): void {
    const src = this.src;
    let j = this.i;
    while (j < this.n && !endsWord(src[j]!)) j++;
    if (j === this.i) {
      // A character no rule claimed; never stall on it.
      this.take("plain", 1);
      return;
    }
    const text = src.slice(this.i, j);
    const standalone = isBoundary(src[j]);
    const assignment = frame.atCommand ? ASSIGNMENT.exec(text) : null;
    if (assignment) {
      this.take("variable", assignment[1]!.length);
      this.take("operator", assignment[2]!.length);
      this.take("plain", text.length - assignment[0].length);
      return;
    }
    if (standalone && ((frame.atCommand && KEYWORDS.has(text)) || text === "]]")) {
      this.take("keyword", text.length);
      frame.atCommand = LEADS_COMMAND.has(text);
      if (text === "for" || text === "select" || text === "case") frame.pendingIn = true;
      return;
    }
    if (standalone && frame.pendingIn && text === "in") {
      this.take("keyword", text.length);
      frame.pendingIn = false;
      return;
    }
    if (standalone && frame.atCommand && BUILTINS.has(text)) {
      this.take("builtin", text.length);
      frame.atCommand = false;
      return;
    }
    frame.atCommand = false;
    this.take(standalone && NUMBER.test(text) ? "number" : "plain", text.length);
  }

  private stepDouble(): void {
    const src = this.src;
    const c = src[this.i]!;
    if (c === "\"") {
      this.take("string", 1);
      this.frames.pop();
      return;
    }
    if (c === "\\") {
      this.take("string", Math.min(2, this.n - this.i));
      return;
    }
    if (c === "$") {
      this.dollar(false);
      return;
    }
    if (c === "`") {
      this.take("variable", 1);
      this.frames.push({ t: "cmd", end: "`", depth: 0, atCommand: true, pendingIn: false });
      return;
    }
    let j = this.i + 1;
    while (j < this.n && src[j] !== "\"" && src[j] !== "\\" && src[j] !== "$" && src[j] !== "`") j++;
    this.take("string", j - this.i);
  }

  private stepParam(frame: Extract<Frame, { t: "param" }>): void {
    const src = this.src;
    const c = src[this.i]!;
    if (c === "}") {
      this.take("variable", 1);
      if (frame.depth === 0) this.frames.pop();
      else frame.depth--;
      return;
    }
    if (c === "{") {
      frame.depth++;
      this.take("variable", 1);
      return;
    }
    if (c === "$") {
      this.dollar(true);
      return;
    }
    if (c === "\"") {
      this.take("string", 1);
      this.frames.push({ t: "dq" });
      return;
    }
    if (c === "'") {
      const close = src.indexOf("'", this.i + 1);
      this.take("string", (close === -1 ? this.n : close + 1) - this.i);
      return;
    }
    if (c === "\\") {
      this.take("variable", Math.min(2, this.n - this.i));
      return;
    }
    let j = this.i + 1;
    while (j < this.n && !"{}$\"'\\".includes(src[j]!)) j++;
    this.take("variable", j - this.i);
  }

  private stepArith(frame: Extract<Frame, { t: "arith" }>): void {
    const src = this.src;
    const c = src[this.i]!;
    if (c === ")" && frame.depth === 0 && src[this.i + 1] === ")") {
      this.take("variable", 2);
      this.frames.pop();
      return;
    }
    if (c === "(") {
      frame.depth++;
      this.take("operator", 1);
      return;
    }
    if (c === ")") {
      if (frame.depth > 0) frame.depth--;
      this.take("operator", 1);
      return;
    }
    if (c === "$") {
      this.dollar(true);
      return;
    }
    if (c === "\"") {
      this.take("string", 1);
      this.frames.push({ t: "dq" });
      return;
    }
    let j = this.i + 1;
    if (/[0-9]/.test(c)) {
      while (j < this.n && /[0-9A-Za-z_]/.test(src[j]!)) j++;
      this.take("number", j - this.i);
      return;
    }
    if (NAME_START.test(c)) {
      while (j < this.n && NAME_CHAR.test(src[j]!)) j++;
      this.take("variable", j - this.i);
      return;
    }
    if (c === " " || c === "\t" || c === "\n") {
      while (j < this.n && (src[j] === " " || src[j] === "\t" || src[j] === "\n")) j++;
      this.take("plain", j - this.i);
      return;
    }
    this.take("operator", 1);
  }
}

/**
 * Where a `$...` or backquoted expansion that starts at `k` ends, within one
 * line. Unbalanced runs to the end of the line; a lone `$` ends where it
 * started (no expansion).
 */
function expansionEnd(line: string, k: number): number {
  const c = line[k];
  if (c === "`") {
    let j = k + 1;
    while (j < line.length && line[j] !== "`") j += line[j] === "\\" ? 2 : 1;
    return Math.min(line.length, j + 1);
  }
  const next = line[k + 1];
  if (next === "{" || next === "(") {
    const open = next;
    const close = open === "{" ? "}" : ")";
    let depth = 0;
    for (let j = k + 1; j < line.length; j++) {
      if (line[j] === open) depth++;
      else if (line[j] === close) {
        depth--;
        if (depth === 0) return j + 1;
      }
    }
    return line.length;
  }
  if (next !== undefined && NAME_START.test(next)) {
    let j = k + 2;
    while (j < line.length && NAME_CHAR.test(line[j]!)) j++;
    return j;
  }
  if (next !== undefined && /[0-9@*#?$!-]/.test(next)) return k + 2;
  return k;
}

/** Split a script into shell-coloured lines. Lossless: the token texts joined line by line with "\n" are `source`. */
export function tokenizeShell(source: string): ShellLine[] {
  return new Lexer(source).run();
}

/** The same shape with no colour, for a language this does not read or a script over the limit. */
export function plainLines(source: string): ShellLine[] {
  return source.split("\n").map((text) => ({ tokens: text ? [{ kind: "plain" as const, text }] : [], heredoc: false }));
}

/** sh and bash scripts are shell; python3 and node, the other two task interpreters, are shown plain. */
export function scriptLanguage(interpreter: string | undefined): ScriptLanguage {
  const name = (interpreter ?? "").trim().toLowerCase();
  return name === "sh" || name === "bash" ? "shell" : "plain";
}

/**
 * A plan is shell when it says so: a shebang naming a shell, or, after any
 * leading comments, a first line that sets shell options (`set -eu`). JSON
 * plans, nft rulesets (whose shebang names nft) and key-value plans are not.
 */
export function looksLikeShell(text: string): boolean {
  const lines = text.split("\n", 40);
  const first = lines.find((line) => line.trim() !== "");
  if (first === undefined) return false;
  if (first.startsWith("#!")) return /^#!\s*(?:\S*\/)?(?:env\s+)?(?:ba|da|a|k|z)?sh\b/.test(first);
  const code = lines.find((line) => line.trim() !== "" && !line.trimStart().startsWith("#"));
  return code !== undefined && /^\s*set\s+[-+][a-zA-Z]/.test(code);
}

/** Lines for the view: coloured when the language is shell and the script is under the limit. */
export function scriptLines(source: string, language: ScriptLanguage): { lines: ShellLine[]; highlighted: boolean } {
  const highlighted = language === "shell" && source.length <= HIGHLIGHT_LIMIT;
  return { lines: highlighted ? tokenizeShell(source) : plainLines(source), highlighted };
}

export type ExprResult = { ok: boolean; value: boolean; error?: string };

export type TokenMatcher = (token: string) => boolean;

const TOKEN_ALIASES: Record<string, string> = {
  singbox: "sing-box",
  "sing_box": "sing-box",
  vpncore: "vpn-lines",
  "vpn-core": "vpn-lines",
  "vpn_line": "vpn-lines",
  "vpn-lines": "vpn-lines",
  "line-recorded": "vpn-lines",
  "line_recorded": "vpn-lines",
  lines: "vpn-lines",
  macos: "darwin",
  mac: "darwin",
  drawin: "darwin",
};

export function normalizeExprToken(raw: string): string {
  const token = raw.trim().replace(/^["']|["']$/g, "").toLowerCase();
  return TOKEN_ALIASES[token] ?? token;
}

function splitTopLevelArgs(input: string): string[] | undefined {
  const args: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    else if (ch === "," && depth === 0) {
      args.push(input.slice(start, i).trim());
      start = i + 1;
    }
    if (depth < 0) return undefined;
  }
  if (depth !== 0) return undefined;
  args.push(input.slice(start).trim());
  return args.filter(Boolean);
}

function parseCall(input: string): { op: string; args: string[] } | undefined {
  const open = input.indexOf("(");
  if (open <= 0 || !input.endsWith(")")) return undefined;
  const op = input.slice(0, open).trim().toUpperCase();
  if (!["AND", "OR", "NOT"].includes(op)) return undefined;
  const inner = input.slice(open + 1, -1);
  const args = splitTopLevelArgs(inner);
  if (!args) return { op, args: [] };
  return { op, args };
}

function parenError(input: string): string | undefined {
  let depth = 0;
  for (const ch of input) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (depth < 0) return "Unexpected closing parenthesis";
  }
  return depth === 0 ? undefined : "Unclosed parenthesis";
}

export function evalFilterExpression(input: string, matchesToken: TokenMatcher): ExprResult {
  const src = input.trim();
  if (!src) return { ok: true, value: true };
  const invalidParens = parenError(src);
  if (invalidParens) return { ok: false, value: false, error: invalidParens };
  const call = parseCall(src);
  if (!call) return { ok: true, value: matchesToken(normalizeExprToken(src)) };

  if (call.op === "NOT") {
    if (call.args.length !== 1) return { ok: false, value: false, error: "NOT expects exactly one expression" };
    const res = evalFilterExpression(call.args[0]!, matchesToken);
    return res.ok ? { ok: true, value: !res.value } : res;
  }

  if (call.args.length === 0) return { ok: false, value: false, error: `${call.op} expects at least one expression` };
  const results = call.args.map((arg) => evalFilterExpression(arg, matchesToken));
  const bad = results.find((res) => !res.ok);
  if (bad) return bad;
  if (call.op === "AND") return { ok: true, value: results.every((res) => res.value) };
  return { ok: true, value: results.some((res) => res.value) };
}

export function fuzzyMatch(haystack: string, needle: string): boolean {
  if (!needle) return true;
  let i = 0;
  for (let j = 0; j < haystack.length && i < needle.length; j += 1) {
    if (haystack[j] === needle[i]) i += 1;
  }
  return i === needle.length;
}

export function tokenMatchesText(value: unknown, token: string): boolean {
  const wanted = normalizeExprToken(token);
  const text = String(value ?? "").toLowerCase();
  return !!text && (text.includes(wanted) || fuzzyMatch(text, wanted));
}

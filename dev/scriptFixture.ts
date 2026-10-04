/**
 * Scripts for the views that show one: a task's revealed script and a plan
 * that is shell. Written in the shape the server writes them
 * (server_witness_plan.go's configure script, sshguard/apply.go's revert
 * heredoc), so the colours are judged on what production actually holds:
 * `set -eu`, a function, `case`, command substitution inside quotes, and a
 * quoted heredoc that writes a unit file.
 */

export const WITNESS_SCRIPT = [
  "set -eu",
  "export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  "umask 077",
  "fail() { echo \"lattice witness: $*\" >&2; exit 1; }",
  "command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ] || fail 'systemd is required'",
  "SRC=\"${LATTICE_AGENT_BIN:-}\"",
  "case \"$SRC\" in /*) ;; *) fail 'the agent did not name its binary (LATTICE_AGENT_BIN)';; esac",
  "\"$SRC\" -compat-json 2>/dev/null | grep -q '\"witness\"' || fail 'this agent has no witness mode; update the agent first'",
  "",
  "# The unit runs the agent's witness mode with its own key and nothing else.",
  "install -d -m 0700 /etc/lattice/witness",
  "cat > /etc/systemd/system/lattice-witness.service <<'LATTICE_WITNESS_UNIT'",
  "[Unit]",
  "Description=Lattice off-box witness",
  "After=network-online.target",
  "",
  "[Service]",
  "ExecStart=/usr/local/bin/lattice-witness -config /etc/lattice/witness/config.json",
  "Restart=on-failure",
  "LATTICE_WITNESS_UNIT",
  "",
  "for attempt in 1 2 3; do",
  "  if systemctl daemon-reload && systemctl enable --now lattice-witness.service; then",
  "    echo \"witness running after $attempt attempt(s), pid $(systemctl show -p MainPID --value lattice-witness)\"",
  "    exit 0",
  "  fi",
  "  sleep $(( attempt * 2 ))",
  "done",
  "fail \"systemd did not start lattice-witness after 3 attempts\"",
  "",
].join("\n");

export const PYTHON_SCRIPT = [
  "import json, socket",
  "",
  "# Report the resolver this node uses, one JSON line.",
  "with open('/etc/resolv.conf') as f:",
  "    servers = [line.split()[1] for line in f if line.startswith('nameserver')]",
  "print(json.dumps({'host': socket.gethostname(), 'resolvers': servers}))",
  "",
].join("\n");

/** WITNESS_SCRIPT repeated past `bytes`, for the long-script render check. */
export function longScript(bytes: number): string {
  let out = "#!/bin/sh\n";
  let round = 0;
  while (out.length < bytes) {
    out += `# round ${round++}\n${WITNESS_SCRIPT}`;
  }
  return out;
}

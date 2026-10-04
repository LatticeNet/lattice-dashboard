/**
 * Text for the views that show a script or a plan. The scripts are written
 * in the shape the server writes its apply task scripts
 * (server_witness_plan.go's configure script, sshguard/apply.go's revert
 * heredoc), so the colours are judged on what production actually holds:
 * `set -eu`, a function, `case`, command substitution inside quotes, and a
 * quoted heredoc that writes a unit file. WITNESS_PLAN is the approval plan
 * itself, which is prose, key-value lines and file sections, not shell.
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

/**
 * The witness configure approval plan, as renderWitnessConfigurePlan
 * (server_witness_plan.go) writes it with the default intervals: prose,
 * key-value lines, then the config and the unit after "--- file <path>"
 * markers and a closing "--- end". Not shell, so the review shows it with
 * line numbers and no colour.
 */
export function witnessPlan(nodeName: string, nodeId: string): string {
  const config = [
    "{",
    '  "version": 1,',
    `  "node_name": "${nodeName}",`,
    '  "health_url": "https://lattice.example.org/readyz",',
    '  "reference_urls": [',
    '    "https://www.cloudflare.com/cdn-cgi/trace",',
    '    "https://www.apple.com/library/test/success.html"',
    "  ],",
    '  "bark_url": "https://bark.example.org",',
    '  "bark_device_key_file": "/etc/lattice-witness/bark-device-key",',
    '  "bark_group": "lattice-witness",',
    '  "bark_level": "critical",',
    '  "interval_seconds": 30,',
    '  "hold_seconds": 180,',
    '  "recover_seconds": 60,',
    '  "state_file": "/var/lib/lattice-witness/status.json"',
    "}",
    "",
  ].join("\n");
  const unit = [
    "[Unit]",
    "Description=Lattice control-plane witness",
    "Documentation=https://github.com/LatticeNet/lattice-node-agent#control-plane-witness",
    "After=network-online.target",
    "Wants=network-online.target",
    "StartLimitIntervalSec=0",
    "",
    "[Service]",
    "Type=simple",
    "ExecStart=/usr/local/lib/lattice-witness/lattice-agent -witness /etc/lattice-witness/witness.json",
    "Restart=always",
    "RestartSec=10",
    "StateDirectory=lattice-witness",
    "StateDirectoryMode=0755",
    "NoNewPrivileges=yes",
    "ProtectSystem=strict",
    "ProtectHome=yes",
    "PrivateTmp=yes",
    "PrivateDevices=yes",
    "ProtectKernelTunables=yes",
    "ProtectKernelModules=yes",
    "ProtectControlGroups=yes",
    "RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX",
    "MemoryMax=64M",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
  return [
    `Control-plane witness: configure on ${nodeName} (${nodeId})`,
    "",
    "The witness is `lattice-agent -witness`, its own process under",
    "lattice-witness.service on this node. Every 30 s it asks:",
    "  https://lattice.example.org/readyz",
    "After 180 s of failures while a reference URL still answers, it pushes one",
    "Bark message (level critical) through the bark-server at https://bark.example.org,",
    "then one recovery once the control plane has answered for 60 s.",
    "When the control plane and every reference fail together, the node's own",
    "network is down and it pushes nothing. References:",
    "  https://www.cloudflare.com/cdn-cgi/trace",
    "  https://www.apple.com/library/test/success.html",
    "It holds no node token, sends no fleet data, and reads nothing but its config",
    "and the key file. The agent relays its status file on the heartbeat.",
    "",
    "device_key_channel_id: ch_bark_urgent",
    "device_key_channel: Bark urgent (bark)",
    "device_key_sha256_prefix: 3f9c2a71d0be",
    "device_key_file: /etc/lattice-witness/bark-device-key (0600, root)",
    "config_sha256: 6b1d0c7e4a2f98d3c5e17b40a9f2d6e8c1b3a5f7092d4e6c8a0b2d4f6e8a0c2e",
    "",
    "The key is not in this plan. Approving re-reads the channel above and refuses",
    "when its key no longer matches that prefix; the apply task writes the key to",
    "the file and never prints it.",
    "",
    "Steps on the node:",
    "1. Refuse unless systemd runs and the agent binary lists",
    "   control-plane-witness-v1 in -compat-json.",
    "2. Copy that binary to /usr/local/lib/lattice-witness/lattice-agent (0755), so an",
    "   agent update or rollback never changes the witness; only a new plan does.",
    "3. Write the key file, then the config below to /etc/lattice-witness/witness.json (0600).",
    "4. Run the copy with -witness-check on that config; stop if it fails.",
    "5. Write the unit below, daemon-reload, enable and restart lattice-witness.service,",
    "   and require it active.",
    "",
    `--- file /etc/lattice-witness/witness.json\n${config}--- file /etc/systemd/system/lattice-witness.service\n${unit}--- end`,
    "",
  ].join("\n");
}

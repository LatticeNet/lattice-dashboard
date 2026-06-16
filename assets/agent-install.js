export const DEFAULT_AGENT_VERSION = "v0.2.0";

export function normalizeAgentServerURL(value) {
  return String(value || "http://127.0.0.1:8088").trim().replace(/\/+$/, "");
}

export function agentRunCommand({ serverURL, nodeID, token }) {
  return [
    "lattice-agent \\",
    `  -server ${shellQuote(normalizeAgentServerURL(serverURL))} \\`,
    `  -node-id ${shellQuote(nodeID)} \\`,
    `  -token ${shellQuote(token)}`,
  ].join("\n");
}

export function agentSystemdInstallScript({ serverURL, nodeID, token, version = DEFAULT_AGENT_VERSION }) {
  const normalizedServerURL = normalizeAgentServerURL(serverURL);
  return [
    "#!/usr/bin/env sh",
    "set -eu",
    "",
    `VERSION=${shellQuote(version)}`,
    "case \"$(uname -m)\" in",
    "  x86_64|amd64) ARCH=amd64 ;;",
    "  aarch64|arm64) ARCH=arm64 ;;",
    "  *) echo \"unsupported architecture: $(uname -m)\" >&2; exit 1 ;;",
    "esac",
    "if [ \"$(uname -s)\" != \"Linux\" ]; then",
    "  echo \"lattice-agent release binaries are Linux only\" >&2",
    "  exit 1",
    "fi",
    "if [ \"$(id -u)\" -eq 0 ]; then SUDO=\"\"; else SUDO=sudo; fi",
    "command -v curl >/dev/null 2>&1 || { echo \"curl is required\" >&2; exit 1; }",
    "command -v sha256sum >/dev/null 2>&1 || { echo \"sha256sum is required\" >&2; exit 1; }",
    "tmp=\"$(mktemp -d)\"",
    "trap 'rm -rf \"$tmp\"' EXIT",
    "cd \"$tmp\"",
    "base=\"https://github.com/LatticeNet/lattice-node-agent/releases/download/${VERSION}\"",
    "curl -fsSLO \"${base}/lattice-agent-linux-${ARCH}\"",
    "curl -fsSLO \"${base}/SHA256SUMS\"",
    "grep \"lattice-agent-linux-${ARCH}$\" SHA256SUMS | sha256sum -c -",
    "$SUDO install -m 0755 \"lattice-agent-linux-${ARCH}\" /usr/local/bin/lattice-agent",
    "$SUDO mkdir -p /etc/lattice /var/lib/lattice-agent/logtail",
    "$SUDO tee /etc/lattice/agent.env >/dev/null <<'ENV'",
    `LATTICE_SERVER_URL=${systemdEnvQuote(normalizedServerURL)}`,
    `LATTICE_NODE_ID=${systemdEnvQuote(nodeID)}`,
    `LATTICE_NODE_TOKEN=${systemdEnvQuote(token)}`,
    "ENV",
    "$SUDO tee /etc/systemd/system/lattice-agent.service >/dev/null <<'SERVICE'",
    "[Unit]",
    "Description=Lattice node agent",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    "EnvironmentFile=/etc/lattice/agent.env",
    "ExecStart=/usr/local/bin/lattice-agent \\",
    "  -server ${LATTICE_SERVER_URL} \\",
    "  -node-id ${LATTICE_NODE_ID} \\",
    "  -token ${LATTICE_NODE_TOKEN} \\",
    "  -log-state-dir /var/lib/lattice-agent/logtail",
    "Restart=always",
    "RestartSec=5s",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "SERVICE",
    "$SUDO systemctl daemon-reload",
    "$SUDO systemctl enable --now lattice-agent.service",
    "/usr/local/bin/lattice-agent -version",
  ].join("\n");
}

function shellQuote(value) {
  return `'${String(value || "").replaceAll("'", "'\"'\"'")}'`;
}

function systemdEnvQuote(value) {
  return `"${String(value || "").replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

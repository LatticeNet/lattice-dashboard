/**
 * An in-memory stand-in for `@/lib/api`, wired in by vite.harness.config.ts
 * through a resolve alias so the production config and bundle never see it.
 *
 * Everything the real barrel exports is re-exported unchanged (types,
 * ApiError, unwrap, the CSRF helpers); only `api` is replaced, and only the
 * calls the Terminal page makes are implemented. Anything else throws,
 * loudly, so a new call path is noticed rather than silently fed nothing.
 *
 * The fleet is the production shape from DESIGN-PROGRAM-2026-09.md: 33 nodes
 * across five providers, most agents on the poll transport and the relay hubs
 * on stream. Two of the operator's sessions are live at load, one of them
 * expires for inactivity twenty-five seconds in, one ended two hours ago, and
 * `term_other_operator` answers 403 on every per-session route the way
 * lattice-server does since the session-ownership fix.
 */
import { ApiError } from "@/lib/api/client";
import type { Node, NodeStatus, Principal, TerminalEvent, TerminalEventsResponse, TerminalSession } from "@/lib/api/index";

export * from "@/lib/api/index";

const NOW = Date.now();
const ZERO_TIME = "0001-01-01T00:00:00Z";
const LATENCY_MS = 60;
const OTHER_OPERATORS_SESSION = "term_other_operator";
const MAX_PER_NODE = 4;

function iso(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}

function delay<T>(value: T, ms = LATENCY_MS): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

const query = new URLSearchParams(window.location.search);
const scenario = query.get("scope") ?? "";

// --- fleet --------------------------------------------------------------------

type Transport = "stream" | "poll";

interface FleetEntry {
  name: string;
  ip: string;
  host: string;
  transport: Transport;
  online?: boolean;
  terminal?: boolean;
  disabled?: boolean;
  version?: string;
  /** The control plane's word, when it is not simply derived from `online`. */
  status?: NodeStatus;
}

const FLEET: FleetEntry[] = [
  { name: "[cd]-DMIT-pro-malibu", ip: "203.0.113.11", host: "dmit-proxy-us", transport: "stream" },
  { name: "[Metix]-DMIT-1", ip: "198.51.100.21", host: "metix-dmit-1", transport: "stream" },
  { name: "[Metix]-DMIT-2", ip: "198.51.100.22", host: "metix-dmit-2", transport: "stream" },
  { name: "[Metix]-DMIT-3", ip: "198.51.100.23", host: "metix-dmit-3", transport: "stream" },
  { name: "[Metix]-DMIT-4", ip: "198.51.100.24", host: "metix-dmit-4", transport: "stream" },
  { name: "gomami-hk-turin-mini", ip: "203.0.113.12", host: "hk-turin", transport: "poll" },
  { name: "gomami-jp-pulse-mini", ip: "203.0.113.13", host: "jp-pulse", transport: "poll" },
  { name: "qqpw-cd2-VDS", ip: "203.0.113.14", host: "cd2", transport: "poll" },
  { name: "qqpw-cd3-VDS", ip: "203.0.113.15", host: "cd3", transport: "poll" },
  { name: "Aaitr-ATT-VDS", ip: "203.0.113.16", host: "att-vds", transport: "poll" },
  { name: "Aaitr-Frontier-VDS", ip: "203.0.113.17", host: "frontier-vds", transport: "poll" },
  { name: "VIRCS-ATT-VDS", ip: "203.0.113.18", host: "vircs-att", transport: "poll" },
  { name: "Aaitr-Frontier-NAT", ip: "203.0.113.19", host: "frontier-nat", transport: "poll" },
  { name: "Aaitr-jp-softbank-NAT", ip: "203.0.113.20", host: "jp-softbank", transport: "poll" },
  { name: "mkcloud-hr-iplc", ip: "203.0.113.21", host: "hr-iplc", transport: "poll" },
  { name: "DMIT-eb-wee", ip: "203.0.113.22", host: "eb-wee", transport: "poll" },
  { name: "[cd]-homeserver", ip: "203.0.113.5", host: "homeserver", transport: "poll", version: "0.3.8" },
  { name: "[cd]-mac-air", ip: "", host: "mac-air", transport: "poll", online: false, version: "0.3.8" },
  { name: "[Metix]-Racknerd-LA-2", ip: "198.51.100.25", host: "racknerd-la-2", transport: "poll" },
  { name: "[cd]-BWH-DC9", ip: "203.0.113.23", host: "bwh-dc9", transport: "poll" },
  { name: "[Metix]-Vultr-SG", ip: "198.51.100.26", host: "vultr-sg", transport: "poll" },
  { name: "[cd]-Hetzner-FSN-1", ip: "203.0.113.24", host: "hetzner-fsn-1", transport: "poll" },
  { name: "[cd]-GreenCloud-Tokyo", ip: "203.0.113.25", host: "greencloud-tokyo", transport: "poll", terminal: false },
  { name: "[Metix]-Oracle-KIX-arm", ip: "198.51.100.27", host: "oracle-kix", transport: "poll", online: false },
  { name: "[cd]-Linode-OSA", ip: "203.0.113.26", host: "linode-osa", transport: "poll" },
  { name: "[Metix]-Contabo-NUE", ip: "198.51.100.28", host: "contabo-nue", transport: "poll", terminal: false },
  { name: "[cd]-HostHatch-HK", ip: "203.0.113.27", host: "hosthatch-hk", transport: "poll" },
  { name: "[cd]-DO-SFO3", ip: "203.0.113.28", host: "do-sfo3", transport: "poll" },
  { name: "[Metix]-Kuroit-LON", ip: "198.51.100.29", host: "kuroit-lon", transport: "poll" },
  { name: "[cd]-Netcup-VIE", ip: "203.0.113.29", host: "netcup-vie", transport: "poll", disabled: true },
  { name: "[Metix]-Crunchbits-SPO", ip: "198.51.100.30", host: "crunchbits-spo", transport: "poll" },
  { name: "[cd]-Evoxt-KUL", ip: "203.0.113.30", host: "evoxt-kul", transport: "poll" },
  { name: "[Metix]-Tencent-SG-lite", ip: "198.51.100.31", host: "tencent-sg", transport: "poll", version: "0.3.8" },
  // Enrolled, agent never installed. The picker used to refuse it with "node
  // offline", which is a different problem with a different fix.
  { name: "[cd]-new-hkbn-hub", ip: "", host: "", transport: "poll", online: false, status: "never_reported", version: "" },
];

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/\[|\]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

const nodes: Node[] = FLEET.map((entry) => ({
  id: `node_${slug(entry.name)}`,
  name: entry.name,
  public_ip: entry.ip || undefined,
  agent_version: entry.version ?? "0.3.9-alpha.2",
  online: entry.online ?? true,
  disabled: entry.disabled,
  status: entry.status,
  last_seen:
    entry.status === "never_reported"
      ? "0001-01-01T00:00:00Z"
      : iso(-(entry.online === false ? 3 * 3600_000 : 8_000)),
  agent_runtime: {
    allow_terminal: entry.terminal ?? true,
    no_exec: false,
    terminal_transport: entry.transport,
    reported_at: iso(-8_000),
  },
}));

const hostByNode = new Map(FLEET.map((entry) => [`node_${slug(entry.name)}`, entry.host]));
const transportByNode = new Map(FLEET.map((entry) => [`node_${slug(entry.name)}`, entry.transport]));

// --- principal ----------------------------------------------------------------

const principal: Principal = {
  actor_id: "cdcd",
  username: "cdcd",
  scopes: scenario === "none" ? ["node:read", "approval:read"] : ["terminal:open", "node:read", "approval:read"],
  server_allowlist: [],
  csrf_token: "harness",
};

// --- PTY emulation ------------------------------------------------------------

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface SessionOptions {
  id: string;
  nodeId: string;
  shell: string;
  createdAt: string;
  status: "pending" | "open" | "closed" | "failed";
  openedAt?: string;
  closedAt?: string;
  error?: string;
}

class Pty {
  session: TerminalSession;
  events: TerminalEvent[] = [];
  output = "";
  private seq = 0;
  private line = "";
  private sink?: (bytes: Uint8Array) => void;
  private readonly host: string;
  private readonly user = "root";
  private cwd = "/root";

  constructor(options: SessionOptions) {
    this.host = hostByNode.get(options.nodeId) ?? "node";
    this.session = {
      id: options.id,
      node_id: options.nodeId,
      actor_id: principal.actor_id,
      token_id: "tok_browser",
      shell: options.shell,
      cols: 120,
      rows: 34,
      status: options.status,
      error: options.error,
      bytes_in: 0,
      bytes_out: 0,
      created_at: options.createdAt,
      opened_at: options.openedAt ?? ZERO_TIME,
      closed_at: options.closedAt ?? ZERO_TIME,
      last_seen: options.openedAt ?? options.createdAt,
    };
    if (options.status === "open") this.banner();
  }

  get live(): boolean {
    return this.session.status === "pending" || this.session.status === "open";
  }

  snapshot(): TerminalSession {
    return { ...this.session };
  }

  attach(sink: (bytes: Uint8Array) => void, fromByte: number) {
    this.sink = sink;
    const replay = encoder.encode(this.output).slice(fromByte);
    if (replay.byteLength) sink(replay);
  }

  detach(sink: (bytes: Uint8Array) => void) {
    if (this.sink === sink) this.sink = undefined;
  }

  eventsAfter(cursor: number): TerminalEvent[] {
    return this.events.filter((event) => event.seq > cursor);
  }

  open() {
    if (this.session.status !== "pending") return;
    this.session.status = "open";
    this.session.opened_at = new Date().toISOString();
    this.banner();
  }

  private banner() {
    const at = new Date(NOW - 86_400_000 * 3).toUTCString().replace(" GMT", "");
    this.emit(`Last login: ${at} from 203.0.113.5\r\n`);
    this.prompt();
  }

  private prompt() {
    const cwd = this.cwd === "/root" ? "~" : this.cwd;
    this.emit(`\x1b[1;32m${this.user}@${this.host}\x1b[0m:\x1b[1;34m${cwd}\x1b[0m# `);
  }

  private emit(text: string) {
    this.output += text;
    this.seq += 1;
    const now = new Date().toISOString();
    this.events.push({ seq: this.seq, kind: "output", data: text, created_at: now });
    this.session.bytes_out = (this.session.bytes_out ?? 0) + encoder.encode(text).byteLength;
    this.session.last_seen = now;
    this.sink?.(encoder.encode(text));
  }

  input(data: string) {
    if (this.session.status !== "open") return;
    this.session.bytes_in = (this.session.bytes_in ?? 0) + data.length;
    this.session.last_seen = new Date().toISOString();
    for (const ch of data) {
      if (ch === "\r" || ch === "\n") {
        this.emit("\r\n");
        this.run(this.line.trim());
        this.line = "";
        if (this.session.status === "open") this.prompt();
      } else if (ch === "\x7f" || ch === "\b") {
        if (this.line.length) {
          this.line = this.line.slice(0, -1);
          this.emit("\b \b");
        }
      } else if (ch === "\x03") {
        this.line = "";
        this.emit("^C\r\n");
        this.prompt();
      } else if (ch === "\x0c") {
        this.emit("\x1b[2J\x1b[H");
        this.prompt();
      } else if (ch >= " ") {
        this.line += ch;
        this.emit(ch);
      }
    }
  }

  private run(command: string) {
    if (!command) return;
    const [verb, ...args] = command.split(/\s+/);
    switch (verb) {
      case "ls":
        this.emit("bin   dev  home  lib64  mnt  proc  run   srv  tmp  var\r\nboot  etc  lib   media  opt  root  sbin  sys  usr\r\n");
        return;
      case "pwd":
        this.emit(`${this.cwd}\r\n`);
        return;
      case "cd":
        this.cwd = args[0] && args[0] !== "~" ? (args[0].startsWith("/") ? args[0] : `${this.cwd}/${args[0]}`) : "/root";
        return;
      case "whoami":
        this.emit(`${this.user}\r\n`);
        return;
      case "id":
        this.emit("uid=0(root) gid=0(root) groups=0(root)\r\n");
        return;
      case "hostname":
        this.emit(`${this.host}\r\n`);
        return;
      case "uname":
        this.emit(`Linux ${this.host} 6.8.0-45-generic #45-Ubuntu SMP PREEMPT_DYNAMIC Fri Aug 30 12:02:04 UTC 2026 x86_64 GNU/Linux\r\n`);
        return;
      case "date":
        this.emit(`${new Date().toUTCString()}\r\n`);
        return;
      case "uptime":
        this.emit(" 03:56:22 up 41 days,  6:12,  1 user,  load average: 0.08, 0.05, 0.01\r\n");
        return;
      case "df":
        this.emit(
          "Filesystem      Size  Used Avail Use% Mounted on\r\n/dev/vda1        40G   11G   29G  28% /\r\ntmpfs           2.0G     0  2.0G   0% /dev/shm\r\n",
        );
        return;
      case "echo":
        this.emit(`${args.join(" ")}\r\n`);
        return;
      case "cat":
        if (args[0] === "/etc/os-release") {
          this.emit('PRETTY_NAME="Ubuntu 24.04.1 LTS"\r\nNAME="Ubuntu"\r\nVERSION_ID="24.04"\r\nID=ubuntu\r\n');
          return;
        }
        this.emit(`cat: ${args[0] ?? ""}: No such file or directory\r\n`);
        return;
      case "systemctl":
        this.emit("● lattice-agent.service - Lattice node agent\r\n     Loaded: loaded (/etc/systemd/system/lattice-agent.service; enabled)\r\n     Active: active (running) since Mon 2026-08-31 22:14:09 UTC; 1 day 5h ago\r\n");
        return;
      case "exit":
      case "logout":
        this.emit("logout\r\n");
        this.close("closed");
        return;
      default:
        this.emit(`bash: ${verb}: command not found\r\n`);
    }
  }

  close(status: "closed" | "failed", error = "") {
    if (!this.live) return;
    this.session.status = status;
    this.session.error = error || undefined;
    this.session.closed_at = new Date().toISOString();
    this.emit(status === "closed" ? "\r\n[session closed]\r\n" : `\r\n[session ended: ${error}]\r\n`);
  }
}

const ptys = new Map<string, Pty>();
let created = 0;

function nodeIdOf(name: string): string {
  return `node_${slug(name)}`;
}

ptys.set(
  "term_d23lpfmz4xd",
  new Pty({
    id: "term_d23lpfmz4xd",
    nodeId: nodeIdOf("[cd]-DMIT-pro-malibu"),
    shell: "/bin/bash",
    status: "open",
    createdAt: iso(-252_000),
    openedAt: iso(-250_000),
  }),
);
ptys.set(
  "term_9f2ak1s0hk",
  new Pty({
    id: "term_9f2ak1s0hk",
    nodeId: nodeIdOf("gomami-hk-turin-mini"),
    shell: "bash",
    status: "open",
    createdAt: iso(-31 * 60_000),
    openedAt: iso(-31 * 60_000 + 1_800),
  }),
);
ptys.set(
  "term_3b71x0qpe2",
  new Pty({
    id: "term_3b71x0qpe2",
    nodeId: nodeIdOf("qqpw-cd2-VDS"),
    shell: "bash",
    status: "closed",
    createdAt: iso(-2 * 3600_000 - 600_000),
    openedAt: iso(-2 * 3600_000 - 598_000),
    closedAt: iso(-2 * 3600_000),
  }),
);

// The idle reaper: the hk session has had no activity for thirty minutes by
// the time the page has been open for twenty-five seconds.
setTimeout(() => ptys.get("term_9f2ak1s0hk")?.close("failed", "terminal session expired after inactivity"), 25_000);

function forbidden(): ApiError {
  return new ApiError(403, "forbidden", "terminal session belongs to another operator", "req_7a1c02");
}

function ptyFor(sessionId: string): Pty {
  if (sessionId === OTHER_OPERATORS_SESSION) throw forbidden();
  const pty = ptys.get(sessionId);
  if (!pty) throw new ApiError(404, "not_found", "terminal session not found");
  return pty;
}

// --- api ------------------------------------------------------------------------

const unimplemented = new Proxy(
  {},
  {
    get(_target, prop) {
      return () => Promise.reject(new Error(`fake api: ${String(prop)} is not implemented in the harness`));
    },
  },
);

export const api = {
  auth: {
    me: () => delay(principal),
  },
  nodes: {
    list: () => delay({ nodes: nodes.map((node) => ({ ...node })) }),
  },
  terminal: {
    list: async (): Promise<{ sessions: TerminalSession[] }> => {
      await delay(undefined);
      if (scenario === "forbid") throw new ApiError(403, "forbidden", "scope terminal:open is required", "req_1f0b77");
      return { sessions: [...ptys.values()].map((pty) => pty.snapshot()) };
    },
    create: async (input: { node_id: string; shell?: string; cols?: number; rows?: number }): Promise<TerminalSession> => {
      await delay(undefined, 140);
      const node = nodes.find((candidate) => candidate.id === input.node_id);
      if (!node) throw new ApiError(404, "not_found", "node not found");
      const liveOnNode = [...ptys.values()].filter((pty) => pty.live && pty.session.node_id === input.node_id).length;
      if (liveOnNode >= MAX_PER_NODE) {
        throw new ApiError(429, "too_many_sessions", `node already has ${MAX_PER_NODE} active terminal sessions`, "req_9d44a1");
      }
      created += 1;
      const id = `term_${(0x5a3f1c + created * 104_729).toString(36)}h${created}`;
      const pty = new Pty({ id, nodeId: input.node_id, shell: input.shell || "/bin/sh", status: "pending", createdAt: new Date().toISOString() });
      ptys.set(id, pty);
      // The agent picks the session up shortly after; a stream node opens on
      // attach instead, the way the real bridge does.
      if (transportByNode.get(input.node_id) !== "stream") setTimeout(() => pty.open(), 900);
      return pty.snapshot();
    },
    events: async (session_id: string, cursor = 0): Promise<TerminalEventsResponse> => {
      const pty = ptyFor(session_id);
      return { session: pty.snapshot(), events: pty.eventsAfter(cursor) };
    },
    input: async (session_id: string, data: string): Promise<TerminalSession> => {
      const pty = ptyFor(session_id);
      pty.input(data);
      return pty.snapshot();
    },
    resize: async (session_id: string, cols: number, rows: number): Promise<TerminalSession> => {
      const pty = ptyFor(session_id);
      pty.session.cols = cols;
      pty.session.rows = rows;
      return pty.snapshot();
    },
    close: async (session_id: string): Promise<TerminalSession> => {
      await delay(undefined);
      const pty = ptyFor(session_id);
      pty.close("closed");
      return pty.snapshot();
    },
    streamURL: (session_id: string) => `ws://harness/api/terminal/sessions/${encodeURIComponent(session_id)}/attach`,
  },
  approvals: unimplemented,
  tasks: unimplemented,
  plugins: unimplemented,
};

// --- stream transport -----------------------------------------------------------

const OPCODE_STDIN = 0x00;
const OPCODE_CLOSE = 0x02;
const OPCODE_RESUME = 0x04;

/**
 * The WebSocket the stream transport opens, answered in memory by the same
 * PTYs the poll transport reads. Frames follow the agent protocol the real
 * XtermSession speaks: opcode byte, then payload; output is raw bytes.
 */
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly url: string;
  binaryType: BinaryType = "blob";
  readyState = FakeWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<ArrayBuffer>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  private pty?: Pty;
  private readonly sink = (bytes: Uint8Array) => {
    if (this.readyState !== FakeWebSocket.OPEN) return;
    const copy = bytes.slice().buffer as ArrayBuffer;
    this.onmessage?.(new MessageEvent("message", { data: copy }));
  };

  constructor(url: string) {
    this.url = url;
    const match = /\/api\/terminal\/sessions\/([^/]+)\/attach/.exec(url);
    const id = decodeURIComponent(match?.[1] ?? "");
    setTimeout(() => this.handshake(id), 150);
  }

  private handshake(id: string) {
    // The HTTP status of a refused upgrade never reaches the page: a 403 and
    // a dead proxy both arrive as an abnormal close before open.
    if (id === OTHER_OPERATORS_SESSION || !ptys.has(id)) {
      this.finish(1006, "");
      return;
    }
    const pty = ptys.get(id)!;
    if (transportByNode.get(pty.session.node_id) !== "stream") {
      // The server closes with 1013 when the agent never dials for a stream attach.
      this.finish(1013, "agent did not connect");
      return;
    }
    if (!pty.live) {
      this.finish(1000, "terminal session closed");
      return;
    }
    this.pty = pty;
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(new Event("open"));
    pty.open();
  }

  send(data: Uint8Array | ArrayBuffer | string) {
    if (this.readyState !== FakeWebSocket.OPEN || !this.pty) return;
    const frame = typeof data === "string" ? encoder.encode(data) : new Uint8Array(data instanceof ArrayBuffer ? data : data.buffer);
    const opcode = frame[0];
    const payload = frame.subarray(1);
    if (opcode === OPCODE_RESUME) {
      this.pty.attach(this.sink, Number(decoder.decode(payload)) || 0);
    } else if (opcode === OPCODE_STDIN) {
      this.pty.input(decoder.decode(payload));
    } else if (opcode === OPCODE_CLOSE) {
      this.pty.close("closed");
      this.finish(1000, "terminal session closed");
    }
  }

  close(code = 1000, reason = "") {
    this.finish(code, reason);
  }

  private finish(code: number, reason: string) {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.pty?.detach(this.sink);
    this.pty = undefined;
    this.onclose?.(new CloseEvent("close", { code, reason, wasClean: code === 1000 }));
  }
}

/** Route the page's WebSocket at the in-memory PTYs. Called once by the harness. */
export function installFakeWebSocket() {
  (window as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
}

import type {
  NotifyChannelView,
  WitnessNodeView,
  WitnessPlanRequest,
  WitnessReport,
  WitnessStatusResponse,
} from "@/lib/api";

/*
 * The control-plane witness as the Notifications page reads it.
 *
 * The witness is `lattice-agent -witness` on one node: it watches this
 * server's public /readyz and pushes through that node's own Bark server when
 * the control plane stops answering. The server reports, per node, the last
 * applied plan, any plan still waiting, and the status file the node's agent
 * relays on every heartbeat. Everything below turns that into one sentence per
 * node, and the form into the plan request. Pure, so the node test runner
 * covers it.
 */

export type WitnessTone = "muted" | "warning" | "danger";

export type WitnessLineKey =
  | "notConfigured"
  | "planned"
  | "neverReported"
  | "notReporting"
  | "starting"
  | "watching"
  | "failing"
  | "down"
  | "networkDown"
  | "unknown";

/** One sentence for a witness node: what it sees and since when. */
export interface WitnessLine {
  key: WitnessLineKey;
  tone: WitnessTone;
  /** When the claim dates from: the last check, the last relay, or the push. */
  at?: string;
  /** When the current failure or outage began. */
  since?: string;
  /** The classified reason of the last failed check ("http 503", "timeout"). */
  detail?: string;
  failures?: number;
}

export function witnessLine(node: WitnessNodeView): WitnessLine {
  const report = node.report;
  if (!node.configured && !(report && node.report_fresh)) {
    return node.pending ? { key: "planned", tone: "muted", at: node.pending.created_at } : { key: "notConfigured", tone: "muted" };
  }
  if (!report) return { key: "neverReported", tone: "warning" };
  if (!node.report_fresh) return { key: "notReporting", tone: "warning", at: node.reported_at };
  return reportLine(report);
}

function reportLine(report: WitnessReport): WitnessLine {
  switch (report.phase) {
    case "watching":
      return { key: "watching", tone: "muted", at: report.last_check_at };
    case "starting":
      return { key: "starting", tone: "muted", at: report.started_at };
    case "failing":
      return {
        key: "failing",
        tone: "warning",
        at: report.last_check_at,
        since: report.failing_since,
        detail: report.last_check_detail,
        failures: report.consecutive_failures ?? 0,
      };
    case "down":
      return {
        key: "down",
        tone: "danger",
        at: report.alerted_at ?? report.last_push_at,
        since: report.down_since ?? report.failing_since,
        detail: report.last_check_detail,
      };
    case "network_down":
      return { key: "networkDown", tone: "warning", at: report.last_check_at, since: report.network_down_since };
    default:
      return { key: "unknown", tone: "warning", at: report.last_check_at };
  }
}

/** The witness's last push, or none yet. */
export interface WitnessPushLine {
  key: "none" | "down" | "recovery";
  ok: boolean;
  at?: string;
  error?: string;
  pushes: number;
}

export function witnessPushLine(report?: WitnessReport): WitnessPushLine | undefined {
  if (!report) return undefined;
  const pushes = report.pushes ?? 0;
  if (!report.last_push_at || (report.last_push_kind !== "down" && report.last_push_kind !== "recovery")) {
    return { key: "none", ok: true, pushes };
  }
  return { key: report.last_push_kind, ok: report.last_push_ok, at: report.last_push_at, error: report.last_push_error, pushes };
}

/**
 * Whether the node runs the config the last applied plan wrote. "differs" is
 * a node still on an older config (a restart that has not happened, or a hand
 * edit); "unknown" is a node with nothing to compare yet.
 */
export function witnessConfigState(node: WitnessNodeView): "matches" | "differs" | "unknown" {
  if (!node.configured || !node.report || !node.report_fresh || !node.report.config_sha256) return "unknown";
  return node.config_matches ? "matches" : "differs";
}

export type WitnessAttentionKind = "down" | "failing" | "networkDown" | "neverReported" | "notReporting" | "pushFailed" | "planFailed" | "differs";

export interface WitnessAttention {
  kind: WitnessAttentionKind;
  tone: "danger" | "warning";
  node: WitnessNodeView;
  line: WitnessLine;
}

/**
 * What about the witness needs the operator, worst first. A witness that sees
 * the control plane down while this console still loads means the public path
 * is broken (DNS, proxy, certificate) even though the agents reach the server
 * by theirs. One that stopped relaying is a safety net that may be gone.
 */
export function witnessAttention(nodes: readonly WitnessNodeView[]): WitnessAttention[] {
  const out: WitnessAttention[] = [];
  for (const node of nodes) {
    const line = witnessLine(node);
    switch (line.key) {
      case "down":
        out.push({ kind: "down", tone: "danger", node, line });
        break;
      case "failing":
        out.push({ kind: "failing", tone: "warning", node, line });
        break;
      case "networkDown":
        out.push({ kind: "networkDown", tone: "warning", node, line });
        break;
      case "neverReported":
        out.push({ kind: "neverReported", tone: "warning", node, line });
        break;
      case "notReporting":
        out.push({ kind: "notReporting", tone: "warning", node, line });
        break;
    }
    const push = witnessPushLine(node.report);
    if (node.report_fresh && push && push.key !== "none" && !push.ok) out.push({ kind: "pushFailed", tone: "warning", node, line });
    if (node.last_failed) out.push({ kind: "planFailed", tone: "warning", node, line });
    if (witnessConfigState(node) === "differs") out.push({ kind: "differs", tone: "warning", node, line });
  }
  return out.sort((a, b) => (a.tone === b.tone ? 0 : a.tone === "danger" ? -1 : 1));
}

/** Whether any node has an applied witness, so the page can say nothing watches the control plane. */
export function witnessConfiguredCount(status?: WitnessStatusResponse): number {
  return (status?.nodes ?? []).filter((node) => !!node.configured).length;
}

// ── The setup form ──────────────────────────────────────────────────────────

export interface WitnessForm {
  nodeId: string;
  channelId: string;
  barkUrl: string;
  barkLevel: string;
  /** One reference URL per line. */
  references: string;
  interval: string;
  hold: string;
  recover: string;
}

export function barkChannels<T extends Pick<NotifyChannelView, "id" | "kind" | "name">>(channels: readonly T[]): T[] {
  return channels.filter((channel) => channel.kind === "bark").sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
}

/**
 * The form a setup or change starts from. A change starts from the node and
 * channel of its applied plan; a new setup picks the only capable node and
 * the only Bark channel when there is exactly one, and leaves the bark-server
 * URL for the operator, since only they know where it listens.
 */
export function witnessFormDefaults(
  status: WitnessStatusResponse,
  channels: readonly Pick<NotifyChannelView, "id" | "kind" | "name">[],
  node?: WitnessNodeView,
): WitnessForm {
  const bark = barkChannels(channels);
  const capable = status.capable_nodes;
  const d = status.defaults;
  const applied = node?.configured?.channel_id;
  return {
    nodeId: node?.node_id ?? (capable.length === 1 ? (capable[0]?.node_id ?? "") : ""),
    channelId: applied && bark.some((c) => c.id === applied) ? applied : bark.length === 1 ? (bark[0]?.id ?? "") : "",
    barkUrl: "",
    barkLevel: d.bark_level,
    references: d.reference_urls.join("\n"),
    interval: String(d.interval_seconds),
    hold: String(d.hold_seconds),
    recover: String(d.recover_seconds),
  };
}

/** Mirrors the server and the witness: an http(s) base URL on the node's loopback interface. */
export function isLoopbackBaseURL(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username || url.password || url.search || url.hash) return false;
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host);
}

export function parseReferences(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export type WitnessFormProblem = "node" | "channel" | "barkUrl" | "barkUrlLoopback" | "references" | "interval" | "hold" | "recover";

function whole(raw: string): number | undefined {
  if (!/^\d+$/.test(raw.trim())) return undefined;
  return Number(raw.trim());
}

/**
 * What stops the form from filing a plan, checked the way the server checks
 * the plan so the operator learns it here and not from a 400. The bounds are
 * the witness's: a 15 to 600 s interval, a hold of at least two intervals and
 * a recovery of at least one, both at most an hour, one to three references.
 */
export function witnessFormProblems(form: WitnessForm): WitnessFormProblem[] {
  const problems: WitnessFormProblem[] = [];
  if (!form.nodeId) problems.push("node");
  if (!form.channelId) problems.push("channel");
  if (!form.barkUrl.trim()) problems.push("barkUrl");
  else if (!isLoopbackBaseURL(form.barkUrl)) problems.push("barkUrlLoopback");
  const refs = parseReferences(form.references);
  if (refs.length > 3 || refs.some((ref) => !/^https:\/\/[^\s/]+/.test(ref) && !/^http:\/\/(localhost|127\.|\[::1\])/.test(ref))) problems.push("references");
  const interval = whole(form.interval);
  if (interval === undefined || interval < 15 || interval > 600) problems.push("interval");
  const hold = whole(form.hold);
  if (hold === undefined || hold > 3600 || (interval !== undefined && hold < 2 * interval)) problems.push("hold");
  const recover = whole(form.recover);
  if (recover === undefined || recover > 3600 || (interval !== undefined && recover < interval)) problems.push("recover");
  return problems;
}

/** The plan request the form files. Empty references fall back to the server's defaults. */
export function witnessPlanRequest(form: WitnessForm): WitnessPlanRequest {
  const refs = parseReferences(form.references);
  return {
    node_id: form.nodeId,
    channel_id: form.channelId,
    bark_url: form.barkUrl.trim().replace(/\/+$/, ""),
    bark_level: form.barkLevel || undefined,
    reference_urls: refs.length ? refs : undefined,
    interval_seconds: whole(form.interval),
    hold_seconds: whole(form.hold),
    recover_seconds: whole(form.recover),
  };
}

// ── A channel's critical fallback ───────────────────────────────────────────

/** Channels a channel may hand its critical messages to: any other stored channel. */
export function channelFallbackChoices<T extends { id: string }>(channels: readonly T[], channelId: string | undefined): T[] {
  return channels.filter((channel) => channel.id !== channelId);
}

/**
 * The fallback a channel save sends: "" clears one the channel had, and
 * undefined leaves a channel that never had one untouched on a server that
 * may not know the field.
 */
export function channelFallbackForSave(selected: string, channelId: string | undefined, hadFallback: boolean): string | undefined {
  const value = selected === channelId ? "" : selected;
  if (!value && !hadFallback) return undefined;
  return value;
}

import { apiErrorMessage } from "./api-error.js";
import {
  DEFAULT_AUDIT_LIMIT,
  auditCorrelationFilters,
  auditDetailRows,
  auditPath,
  nextAuditOffset,
  normalizeAuditResponse,
} from "./audit.js";

const state = {
  csrf: "",
  nodes: [],
  tasks: [],
  results: [],
  approvals: [],
  kv: [],
  workers: [],
  audit: [],
  auditPage: {
    total: 0,
    limit: DEFAULT_AUDIT_LIMIT,
    offset: 0,
  },
  auditFilters: {
    action: "",
    decision: "",
    node_id: "",
    correlation_id: "",
  },
};

const $ = (id) => document.getElementById(id);

async function api(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (state.csrf && options.method && options.method !== "GET") {
    headers["X-Lattice-CSRF"] = state.csrf;
  }
  const res = await fetch(path, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(apiErrorMessage(data, res.statusText));
  }
  return data;
}

function showConsole(on) {
  $("login").classList.toggle("hidden", on);
  $("console").classList.toggle("hidden", !on);
}

async function login(event) {
  event.preventDefault();
  $("login-error").textContent = "";
  const form = new FormData(event.currentTarget);
  try {
    const data = await api("/api/login", {
      method: "POST",
      body: JSON.stringify({
        username: String(form.get("username") || ""),
        password: String(form.get("password") || ""),
      }),
    });
    state.csrf = data.csrf_token;
    showConsole(true);
    await refresh();
  } catch (error) {
    $("login-error").textContent = error.message;
  }
}

async function refresh() {
  const [me, nodes, tasks, results, approvals, kv, workers, auditPayload] = await Promise.all([
    api("/api/me"),
    api("/api/nodes"),
    api("/api/tasks"),
    api("/api/task-results"),
    api("/api/network/approvals"),
    api("/api/kv?bucket=default"),
    api("/api/workers"),
    api(auditPath({ ...state.auditFilters, limit: state.auditPage.limit, offset: state.auditPage.offset })),
  ]);
  const audit = normalizeAuditResponse(auditPayload, state.auditPage);
  state.csrf = me.csrf_token || state.csrf;
  state.nodes = nodes;
  state.tasks = tasks;
  state.results = results;
  state.approvals = approvals;
  state.kv = kv;
  state.workers = workers;
  state.audit = audit.events;
  state.auditPage = { total: audit.total, limit: audit.limit, offset: audit.offset };
  render();
}

function render() {
  $("node-count").textContent = state.nodes.length;
  $("online-count").textContent = state.nodes.filter((n) => n.online).length;
  $("queued-count").textContent = state.tasks.filter((t) => t.status === "queued").length;
  $("approval-count").textContent = state.approvals.filter((a) => a.status === "pending").length;
  renderNodes();
  renderResults();
  renderApprovals();
  renderKV();
  renderWorkers();
  renderAudit();
}

function renderNodes() {
  $("nodes-table").innerHTML = state.nodes
    .map((node) => {
      const mem = percent(node.metrics?.memory_used, node.metrics?.memory_total);
      const disk = percent(node.metrics?.disk_used, node.metrics?.disk_total);
      return `<tr>
        <td><span class="status ${node.online ? "online" : ""}">${escapeHtml(node.name || node.id)}</span><br><small>${escapeHtml(node.id)}</small></td>
        <td>${escapeHtml(node.role || "node")}</td>
        <td>${formatNumber(node.metrics?.cpu_percent)}%</td>
        <td>${mem}</td>
        <td>${disk}</td>
        <td>${escapeHtml(node.agent_version || "-")}</td>
        <td>${formatDate(node.last_seen)}</td>
      </tr>`;
    })
    .join("");
}

function renderResults() {
  $("task-results").innerHTML = state.results
    .slice(0, 12)
    .map((result) => `<article class="result">
      <strong>${escapeHtml(result.node_id)}</strong>
      <span class="pill">exit ${result.exit_code}</span>
      ${result.error ? `<span class="danger">${escapeHtml(result.error)}</span>` : ""}
      <pre>${escapeHtml([result.stdout, result.stderr].filter(Boolean).join("\n"))}</pre>
    </article>`)
    .join("");
}

function renderApprovals() {
  $("approvals").innerHTML = state.approvals
    .slice(0, 8)
    .map((approval) => `<article class="result">
      <strong>${escapeHtml(approval.node_id)}</strong>
      <span class="pill">${escapeHtml(approval.status)}</span>
      <button data-approval="${escapeHtml(approval.id)}" ${approval.status !== "pending" ? "disabled" : ""}>Approve Check</button>
      <pre>${escapeHtml(approval.plan)}</pre>
    </article>`)
    .join("");
  document.querySelectorAll("[data-approval]").forEach((button) => {
    button.addEventListener("click", () => approve(button.dataset.approval));
  });
}

function renderKV() {
  $("kv-list").innerHTML = state.kv
    .map((entry) => `<article class="kv-item"><strong>${escapeHtml(entry.key)}</strong><br>${escapeHtml(entry.value)}</article>`)
    .join("");
}

function renderWorkers() {
  $("workers").innerHTML = state.workers
    .map((worker) => `<article class="kv-item"><strong>${escapeHtml(worker.name)}</strong><br><span class="pill">${escapeHtml(worker.id)}</span></article>`)
    .join("");
}

function renderAudit() {
  const end = Math.min(state.auditPage.total, state.auditPage.offset + state.audit.length);
  $("audit-page-label").textContent = state.auditPage.total
    ? `${state.auditPage.offset + 1}-${end} / ${state.auditPage.total}`
    : "0 / 0";
  $("audit-prev").disabled = state.auditPage.offset <= 0;
  $("audit-next").disabled = state.auditPage.offset + state.auditPage.limit >= state.auditPage.total;
  $("audit-list").innerHTML = state.audit
    .map(renderAuditEvent)
    .join("");
  document.querySelectorAll("[data-audit-correlation]").forEach((button) => {
    button.addEventListener("click", () => traceAuditCorrelation(button.dataset.auditCorrelation));
  });
}

function renderAuditEvent(event) {
  const rows = auditDetailRows(event);
  const traceButton = event.correlation_id
    ? `<button type="button" class="secondary audit-trace" data-audit-correlation="${escapeHtml(event.correlation_id)}">Trace request</button>`
    : "";
  const details = rows.length
    ? `<details class="audit-details">
        <summary>Details</summary>
        <dl>${rows.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl>
      </details>`
    : "";

  return `<article class="audit-item">
    <div class="audit-head">
      <div>
        <strong>${escapeHtml(event.action)}</strong>
        <span class="${event.decision === "deny" ? "danger" : "warn"}">${escapeHtml(event.decision)}</span>
      </div>
      ${traceButton}
    </div>
    <small>${formatDate(event.at)} ${escapeHtml(event.node_id || event.actor_id || "")}</small>
    ${event.correlation_id ? `<small class="mono">${escapeHtml(event.correlation_id)}</small>` : ""}
    ${details}
  </article>`;
}

async function filterAudit(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  state.auditFilters = {
    action: String(form.get("action") || ""),
    decision: String(form.get("decision") || ""),
    node_id: String(form.get("node_id") || ""),
    correlation_id: String(form.get("correlation_id") || ""),
  };
  state.auditPage.offset = 0;
  await refresh();
}

function syncAuditFilterForm() {
  const form = $("audit-filter-form");
  for (const [key, value] of Object.entries(state.auditFilters)) {
    if (form.elements[key]) {
      form.elements[key].value = value;
    }
  }
}

async function traceAuditCorrelation(correlationID) {
  const filters = auditCorrelationFilters({ correlation_id: correlationID });
  if (!filters) {
    return;
  }
  state.auditFilters = filters;
  state.auditPage.offset = 0;
  syncAuditFilterForm();
  await refresh();
}

async function pageAudit(direction) {
  state.auditPage.offset = nextAuditOffset(state.auditPage, direction);
  await refresh();
}

async function enroll(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const data = await api("/api/nodes/enroll-token", {
    method: "POST",
    body: JSON.stringify({
      node_id: String(form.get("node_id") || ""),
      name: String(form.get("name") || ""),
    }),
  });
  alert(`Token for ${data.node_id}:\n${data.token}\n\n${data.command}`);
  event.currentTarget.reset();
  await refresh();
}

async function queueTask(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  await api("/api/tasks", {
    method: "POST",
    body: JSON.stringify({
      targets: String(form.get("targets") || "").split(",").map((v) => v.trim()).filter(Boolean),
      interpreter: String(form.get("interpreter") || "sh"),
      timeout_sec: Number(form.get("timeout_sec") || 30),
      output_limit: 65536,
      script: String(form.get("script") || ""),
    }),
  });
  await refresh();
}

async function saveKV(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  await api("/api/kv", {
    method: "POST",
    body: JSON.stringify({
      bucket: String(form.get("bucket") || "default"),
      key: String(form.get("key") || ""),
      value: String(form.get("value") || ""),
    }),
  });
  await refresh();
}

async function deployWorker(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  await api("/api/workers", {
    method: "POST",
    body: JSON.stringify({
      name: String(form.get("name") || ""),
      source: String(form.get("source") || ""),
      capabilities: ["worker:route"],
      public: false,
    }),
  });
  await refresh();
}

async function createNFTPlan(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  await api("/api/network/nft/plan", {
    method: "POST",
    body: JSON.stringify({
      node_id: String(form.get("node_id") || ""),
      public_tcp: ports(form.get("public_tcp")),
      wireguard_tcp: ports(form.get("wg_tcp")),
      wireguard_udp: ports(form.get("wg_udp")),
    }),
  });
  await refresh();
}

async function approve(approvalId) {
  await api("/api/network/approvals/approve", {
    method: "POST",
    body: JSON.stringify({ approval_id: approvalId, queue_apply: true }),
  });
  await refresh();
}

async function logout() {
  await api("/api/logout", { method: "POST", body: "{}" });
  state.csrf = "";
  showConsole(false);
}

function ports(value) {
  return String(value || "")
    .split(",")
    .map((v) => Number(v.trim()))
    .filter((v) => Number.isInteger(v) && v > 0);
}

function percent(used, total) {
  if (!total) return "-";
  return `${Math.round((Number(used || 0) / Number(total)) * 100)}%`;
}

function formatNumber(value) {
  return Number(value || 0).toFixed(1);
}

function formatDate(value) {
  if (!value || value.startsWith("0001-")) return "-";
  return new Date(value).toLocaleString();
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"'`]/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
    "`": "&#96;",
  })[ch]);
}

$("login-form").addEventListener("submit", login);
$("refresh").addEventListener("click", refresh);
$("logout").addEventListener("click", logout);
$("enroll-form").addEventListener("submit", enroll);
$("task-form").addEventListener("submit", queueTask);
$("kv-form").addEventListener("submit", saveKV);
$("worker-form").addEventListener("submit", deployWorker);
$("nft-form").addEventListener("submit", createNFTPlan);
$("audit-filter-form").addEventListener("submit", filterAudit);
$("audit-prev").addEventListener("click", () => pageAudit(-1));
$("audit-next").addEventListener("click", () => pageAudit(1));

api("/api/me")
  .then((me) => {
    state.csrf = me.csrf_token || "";
    showConsole(true);
    return refresh();
  })
  .catch(() => showConsole(false));

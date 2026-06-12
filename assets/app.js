import { apiErrorMessage } from "./api-error.js";
import {
  DEFAULT_AUDIT_LIMIT,
  auditCorrelationFilters,
  auditDetailRows,
  auditPath,
  nextAuditOffset,
  normalizeAuditResponse,
} from "./audit.js";
import {
  ssoErrorMessage,
  hasAuthRedirectParams,
  readAuthRedirect,
  strippedAuthSearch,
  oidcStartURL,
  oidcProviderPayload,
  confirmOIDCDelete,
} from "./sso.js";
import {
  confirmPluginLifecycleTransition,
  pluginLifecycleActions,
  pluginLifecycleAvailability,
  pluginLifecycleCapabilities,
  pluginLifecycleDigestShort,
  pluginLifecycleRuntimeLabel,
  pluginLifecycleStatusLabel,
  pluginLifecycleTransitionPayload,
} from "./plugin-lifecycle.js";

const state = {
  csrf: "",
  totpChallengeId: "",
  totpEnabled: false,
  nodes: [],
  tasks: [],
  results: [],
  approvals: [],
  kv: [],
  workers: [],
  pluginInstallations: [],
  oidcProviders: [],
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
    if (data.totp_required) {
      state.totpChallengeId = data.challenge_id || "";
      showLoginStep("totp");
      return;
    }
    state.csrf = data.csrf_token;
    showConsole(true);
    await refresh();
  } catch (error) {
    $("login-error").textContent = error.message;
  }
}

function showLoginStep(step) {
  $("login-form").classList.toggle("hidden", step === "totp");
  $("totp-form").classList.toggle("hidden", step !== "totp");
  if (step === "totp") {
    $("totp-error").textContent = "";
    const input = $("totp-form").elements["code"];
    if (input) input.focus();
  }
}

async function submitTotp(event) {
  event.preventDefault();
  $("totp-error").textContent = "";
  const form = new FormData(event.currentTarget);
  try {
    const data = await api("/api/login/totp", {
      method: "POST",
      body: JSON.stringify({
        challenge_id: state.totpChallengeId,
        code: String(form.get("code") || "").trim(),
        recovery_code: String(form.get("recovery_code") || "").trim(),
      }),
    });
    state.totpChallengeId = "";
    state.csrf = data.csrf_token;
    event.currentTarget.reset();
    showConsole(true);
    await refresh();
  } catch (error) {
    $("totp-error").textContent = error.message;
  }
}

function render2FA() {
  const enabled = state.totpEnabled;
  $("twofa-status").innerHTML = `Two-factor: <strong>${enabled ? "enabled" : "disabled"}</strong>`;
  $("twofa-disabled").classList.toggle("hidden", enabled);
  $("twofa-enabled").classList.toggle("hidden", !enabled);
  if (enabled) {
    $("twofa-enroll-box").classList.add("hidden");
  }
}

async function enroll2FA() {
  $("twofa-enroll-error").textContent = "";
  try {
    const data = await api("/api/2fa/totp/enroll", { method: "POST", body: "{}" });
    $("twofa-secret").textContent = data.secret || "";
    $("twofa-uri").textContent = data.otpauth_uri || "";
    const codes = Array.isArray(data.recovery_codes) ? data.recovery_codes : [];
    $("twofa-recovery").innerHTML =
      `<p class="muted">Save these recovery codes — shown once:</p>` +
      `<ul class="recovery-codes">${codes.map((c) => `<li>${escapeHtml(c)}</li>`).join("")}</ul>`;
    $("twofa-enroll-box").classList.remove("hidden");
    $("twofa-disabled").classList.add("hidden");
  } catch (error) {
    $("twofa-enroll-error").textContent = error.message;
  }
}

async function activate2FA(event) {
  event.preventDefault();
  $("twofa-enroll-error").textContent = "";
  const form = new FormData(event.currentTarget);
  try {
    await api("/api/2fa/totp/activate", {
      method: "POST",
      body: JSON.stringify({ code: String(form.get("code") || "").trim() }),
    });
    event.currentTarget.reset();
    state.totpEnabled = true;
    render2FA();
  } catch (error) {
    $("twofa-enroll-error").textContent = error.message;
  }
}

async function disable2FA(event) {
  event.preventDefault();
  $("twofa-disable-error").textContent = "";
  const form = new FormData(event.currentTarget);
  try {
    await api("/api/2fa/totp/disable", {
      method: "POST",
      body: JSON.stringify({ code: String(form.get("code") || "").trim() }),
    });
    event.currentTarget.reset();
    state.totpEnabled = false;
    render2FA();
  } catch (error) {
    $("twofa-disable-error").textContent = error.message;
  }
}

// --- SSO / OIDC ----------------------------------------------------------

// loadSSOProviders fetches the public list of enabled providers and renders a
// sign-in button for each on the login page.
async function loadSSOProviders() {
  try {
    const data = await api("/api/auth/oidc");
    const providers = Array.isArray(data.providers) ? data.providers : [];
    const block = $("sso-block");
    const list = $("sso-providers");
    if (!providers.length) {
      block.classList.add("hidden");
      list.innerHTML = "";
      return;
    }
    list.innerHTML = providers
      .map(
        (p) =>
          `<button type="button" class="sso-button" data-sso-provider="${escapeHtml(p.id)}">Sign in with ${escapeHtml(p.display_name || p.id)}</button>`,
      )
      .join("");
    list.querySelectorAll("[data-sso-provider]").forEach((button) => {
      button.addEventListener("click", () => {
        window.location.assign(oidcStartURL(button.dataset.ssoProvider, "/"));
      });
    });
    block.classList.remove("hidden");
  } catch {
    $("sso-block").classList.add("hidden");
  }
}

// loadOIDCAdmin loads the admin provider list. It is intentionally separate from
// refresh()'s Promise.all: a non-admin receives 403, which simply hides the
// panel instead of breaking the console.
async function loadOIDCAdmin() {
  try {
    const data = await api("/api/auth/oidc/providers");
    state.oidcProviders = Array.isArray(data.providers) ? data.providers : [];
    $("oidc-panel").classList.remove("hidden");
    renderOIDCProviders();
  } catch {
    state.oidcProviders = [];
    $("oidc-panel").classList.add("hidden");
  }
}

function renderOIDCProviders() {
  $("oidc-list").innerHTML = state.oidcProviders
    .map((p) => {
      const badges =
        `<span class="pill">${p.enabled ? "enabled" : "disabled"}</span>` +
        (p.has_secret === true ? `<span class="pill">secret set</span>` : `<span class="danger">no secret</span>`);
      const domains = Array.isArray(p.allowed_domains) && p.allowed_domains.length
        ? `<br><small class="mono">${escapeHtml(p.allowed_domains.join(", "))}</small>`
        : "";
      return `<article class="kv-item oidc-provider">
        <div class="oidc-provider-head">
          <strong>${escapeHtml(p.display_name || p.id)}</strong>
          <span class="oidc-actions">
            <button type="button" class="secondary" data-oidc-edit="${escapeHtml(p.id)}">Edit</button>
            <button type="button" class="secondary" data-oidc-delete="${escapeHtml(p.id)}">Delete</button>
          </span>
        </div>
        <small class="mono">${escapeHtml(p.issuer)}</small>
        <div class="oidc-badges">${badges}</div>
        ${domains}
      </article>`;
    })
    .join("");
  $("oidc-list").querySelectorAll("[data-oidc-edit]").forEach((b) => {
    b.addEventListener("click", () => editOIDCProvider(b.dataset.oidcEdit));
  });
  $("oidc-list").querySelectorAll("[data-oidc-delete]").forEach((b) => {
    b.addEventListener("click", () => deleteOIDCProvider(b.dataset.oidcDelete));
  });
}

function editOIDCProvider(id) {
  const p = state.oidcProviders.find((x) => x.id === id);
  if (!p) return;
  const form = $("oidc-form");
  form.elements["id"].value = p.id;
  form.elements["display_name"].value = p.display_name || "";
  form.elements["issuer"].value = p.issuer || "";
  form.elements["client_id"].value = p.client_id || "";
  form.elements["client_secret"].value = ""; // write-only; blank keeps current
  form.elements["allowed_domains"].value = (p.allowed_domains || []).join(", ");
  form.elements["scopes"].value = (p.scopes || []).join(" ");
  form.elements["enabled"].checked = !!p.enabled;
  $("oidc-error").textContent = "";
}

function resetOIDCForm() {
  $("oidc-form").reset();
  $("oidc-form").elements["id"].value = "";
  $("oidc-error").textContent = "";
}

async function submitOIDCProvider(event) {
  event.preventDefault();
  $("oidc-error").textContent = "";
  const submitButton = event.currentTarget.querySelector('button[type="submit"]');
  if (submitButton?.disabled) return;
  if (submitButton) submitButton.disabled = true;
  const form = new FormData(event.currentTarget);
  const payload = oidcProviderPayload({
    id: form.get("id"),
    display_name: form.get("display_name"),
    issuer: form.get("issuer"),
    client_id: form.get("client_id"),
    client_secret: form.get("client_secret"),
    allowed_domains: form.get("allowed_domains"),
    scopes: form.get("scopes"),
    enabled: $("oidc-form").elements["enabled"].checked,
  });
  try {
    await api("/api/auth/oidc/providers", { method: "POST", body: JSON.stringify(payload) });
    resetOIDCForm();
    await loadOIDCAdmin();
  } catch (error) {
    $("oidc-error").textContent = error.message;
  } finally {
    if (submitButton) submitButton.disabled = false;
  }
}

async function deleteOIDCProvider(id) {
  $("oidc-error").textContent = "";
  const provider = state.oidcProviders.find((p) => p.id === id) || { id };
  if (!confirmOIDCDelete(provider, window.confirm.bind(window))) return;
  try {
    await api("/api/auth/oidc/providers/delete", { method: "POST", body: JSON.stringify({ id }) });
    await loadOIDCAdmin();
  } catch (error) {
    $("oidc-error").textContent = error.message;
  }
}

// --- Plugin lifecycle -----------------------------------------------------

async function loadPluginLifecycleAdmin() {
  try {
    const data = await api("/api/plugins/lifecycle");
    state.pluginInstallations = Array.isArray(data) ? data : Array.isArray(data.plugins) ? data.plugins : [];
    $("plugins-panel").classList.remove("hidden");
    $("plugins-error").textContent = "";
    renderPluginLifecycle();
  } catch {
    state.pluginInstallations = [];
    $("plugins-panel").classList.add("hidden");
  }
}

function renderPluginLifecycle() {
  const list = $("plugins-list");
  if (!state.pluginInstallations.length) {
    list.innerHTML = `<article class="kv-item"><span class="muted">No verified plugins registered.</span></article>`;
    return;
  }
  list.innerHTML = state.pluginInstallations.map(renderPluginLifecycleCard).join("");
  list.querySelectorAll("[data-plugin-id][data-plugin-status]").forEach((button) => {
    button.addEventListener("click", () => transitionPluginLifecycle(button.dataset.pluginId, button.dataset.pluginStatus));
  });
}

function renderPluginLifecycleCard(plugin) {
  const status = pluginLifecycleStatusLabel(plugin.status);
  const availability = pluginLifecycleAvailability(plugin);
  const runtime = pluginLifecycleRuntimeLabel(plugin);
  const caps = pluginLifecycleCapabilities(plugin);
  const digest = pluginLifecycleDigestShort(plugin.artifact_sha256);
  const actions = pluginLifecycleActions(plugin);
  const actionHTML = actions.length
    ? actions
        .map(
          (action) =>
            `<button type="button" class="secondary" data-plugin-id="${escapeHtml(plugin.id)}" data-plugin-status="${escapeHtml(action.status)}">${escapeHtml(action.label)}</button>`,
        )
        .join("")
    : `<span class="muted">No safe transition</span>`;
  const capHTML = caps.length
    ? `<div class="plugin-caps">${caps.map((cap) => `<span class="pill">${escapeHtml(cap)}</span>`).join("")}</div>`
    : `<small class="muted">No declared capabilities</small>`;
  return `<article class="kv-item plugin-card">
    <div class="plugin-card-head">
      <div>
        <strong>${escapeHtml(plugin.name || plugin.id)}</strong>
        <small class="mono">${escapeHtml(plugin.id || "")}</small>
      </div>
      <span class="plugin-actions">${actionHTML}</span>
    </div>
    <div class="plugin-badges">
      <span class="pill">${escapeHtml(status)}</span>
      <span class="${plugin.available === true ? "pill" : "danger"}">${escapeHtml(availability)}</span>
      ${runtime ? `<span class="pill">${escapeHtml(runtime)}</span>` : ""}
      ${plugin.type ? `<span class="pill">${escapeHtml(plugin.type)}</span>` : ""}
      ${plugin.version ? `<span class="pill">${escapeHtml(plugin.version)}</span>` : ""}
    </div>
    ${capHTML}
    ${digest ? `<small class="mono">sha256 ${escapeHtml(digest)}</small>` : ""}
    ${plugin.updated_at ? `<small class="muted">Updated ${escapeHtml(formatDate(plugin.updated_at))}</small>` : ""}
  </article>`;
}

async function transitionPluginLifecycle(id, status) {
  $("plugins-error").textContent = "";
  const plugin = state.pluginInstallations.find((p) => p.id === id) || { id };
  if (!confirmPluginLifecycleTransition(plugin, status, window.confirm.bind(window))) return;
  try {
    await api("/api/plugins/lifecycle", {
      method: "POST",
      body: JSON.stringify(pluginLifecycleTransitionPayload(id, status)),
    });
    await loadPluginLifecycleAdmin();
  } catch (error) {
    $("plugins-error").textContent = error.message;
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
  state.totpEnabled = !!me.totp_enabled;
  state.nodes = nodes;
  state.tasks = tasks;
  state.results = results;
  state.approvals = approvals;
  state.kv = kv;
  state.workers = workers;
  state.audit = audit.events;
  state.auditPage = { total: audit.total, limit: audit.limit, offset: audit.offset };
  render();
  // Self-contained admin panels hide themselves for non-admins (403) without
  // breaking the main console refresh.
  await Promise.all([loadOIDCAdmin(), loadPluginLifecycleAdmin()]);
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
  render2FA();
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
  state.totpChallengeId = "";
  showConsole(false);
  showLoginStep("login");
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
$("totp-form").addEventListener("submit", submitTotp);
$("totp-cancel").addEventListener("click", () => { state.totpChallengeId = ""; showLoginStep("login"); });
$("twofa-enroll").addEventListener("click", enroll2FA);
$("twofa-activate-form").addEventListener("submit", activate2FA);
$("twofa-disable-form").addEventListener("submit", disable2FA);
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
$("oidc-form").addEventListener("submit", submitOIDCProvider);
$("oidc-reset").addEventListener("click", resetOIDCForm);
$("plugins-refresh").addEventListener("click", loadPluginLifecycleAdmin);

function bootstrap() {
  const redirect = readAuthRedirect(window.location.search);
  if (redirect.ssoError) {
    $("login-error").textContent = ssoErrorMessage(redirect.ssoError);
  }
  // Strip the one-time SSO landing params from the address bar.
  if (hasAuthRedirectParams(window.location.search)) {
    window.history.replaceState({}, "", window.location.pathname + strippedAuthSearch(window.location.search));
  }
  loadSSOProviders();
  if (redirect.totpChallenge) {
    // SSO authenticated the IdP identity but the account also requires a local
    // second factor: resume the existing TOTP step with the issued challenge.
    state.totpChallengeId = redirect.totpChallenge;
    showConsole(false);
    showLoginStep("totp");
    return;
  }
  api("/api/me")
    .then((me) => {
      state.csrf = me.csrf_token || "";
      showConsole(true);
      return refresh();
    })
    .catch(() => showConsole(false));
}

bootstrap();

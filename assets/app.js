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
import { dateInputValue, formatMoney, machinePayload, renewalState } from "./machines.js";
import { describeNetRule, netPolicyPayload } from "./netpolicy.js";
import { formatPorts, nftInputsPayload } from "./nft.js";
import {
  GEO_MAP_HEIGHT,
  GEO_MAP_WIDTH,
  geoClearPayload,
  geoLabel,
  geoPayload,
  nodesWithGeo,
  projectGeoPoint,
} from "./geomap.js";

const state = {
  csrf: "",
  totpChallengeId: "",
  totpEnabled: false,
  nodes: [],
  tasks: [],
  results: [],
  approvals: [],
  nftInputs: [],
  geoNodes: [],
  netPolicies: [],
  netPolicyGraph: { nodes: [], edges: [], externals: [] },
  machines: [],
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

// --- Machine inventory ----------------------------------------------------

async function loadMachines() {
  try {
    const data = await api("/api/machines");
    state.machines = Array.isArray(data) ? data : [];
    $("machines-panel").classList.remove("hidden");
    renderMachines();
  } catch {
    state.machines = [];
    $("machines-panel").classList.add("hidden");
  }
}

function renderMachines() {
  $("machines-table").innerHTML = state.machines
    .map((machine) => {
      const hasProfile = !!machine.id;
      const renewal = machine.next_renewal && !String(machine.next_renewal).startsWith("0001-");
      const renewState = renewalState(machine.days_until_renewal, renewal);
      const renewalText = renewal
        ? `${dateInputValue(machine.next_renewal)} (${Number(machine.days_until_renewal || 0)}d)`
        : "-";
      const linkBadges = [
        machine.has_console_url ? `<span class="pill">console</span>` : "",
        machine.has_detail_url ? `<span class="pill">detail</span>` : "",
      ].filter(Boolean).join(" ") || `<span class="muted">-</span>`;
      return `<tr>
        <td><strong>${escapeHtml(machine.node_name || machine.label || machine.node_id)}</strong><br><small>${escapeHtml(machine.node_id)}</small></td>
        <td>${machineHostSummary(machine)}</td>
        <td>${escapeHtml([machine.vendor, machine.region].filter(Boolean).join(" / ") || "-")}</td>
        <td>${escapeHtml(formatMoney(machine.price_cents, machine.currency) || "-")}</td>
        <td><span class="${renewState === "overdue" ? "danger" : renewState === "soon" ? "warn" : "muted"}">${escapeHtml(renewalText)}</span></td>
        <td>${linkBadges}</td>
        <td class="row-actions">
          <button type="button" class="secondary" data-machine-edit="${escapeHtml(machine.node_id)}">${hasProfile ? "Edit" : "Add"}</button>
          ${hasProfile ? `<button type="button" class="secondary" data-machine-renew="${escapeHtml(machine.id)}">Renewed</button>` : ""}
        </td>
      </tr>`;
    })
    .join("");
  $("machines-table").querySelectorAll("[data-machine-edit]").forEach((button) => {
    button.addEventListener("click", () => editMachine(button.dataset.machineEdit));
  });
  $("machines-table").querySelectorAll("[data-machine-renew]").forEach((button) => {
    button.addEventListener("click", () => renewMachine(button.dataset.machineRenew));
  });
}

function machineHostSummary(machine) {
  const facts = machine.host_facts || {};
  const line1 = [facts.arch, facts.os, facts.platform].filter(Boolean).join(" / ") || "-";
  const line2 = [
    facts.cpu_cores ? `${Number(facts.cpu_cores)} cores` : "",
    formatBytes(facts.memory_total),
    facts.virtualization && facts.virtualization !== "unknown" ? facts.virtualization : "",
  ].filter(Boolean).join(" · ");
  return `<span>${escapeHtml(line1)}</span>${line2 ? `<br><small>${escapeHtml(line2)}</small>` : ""}`;
}

function editMachine(nodeID) {
  const machine = state.machines.find((m) => m.node_id === nodeID) || { node_id: nodeID };
  const form = $("machine-form");
  form.elements["id"].value = machine.id || "";
  form.elements["node_id"].value = machine.node_id || "";
  form.elements["label"].value = machine.label || "";
  form.elements["vendor"].value = machine.vendor || "";
  form.elements["region"].value = machine.region || "";
  form.elements["price_cents"].value = machine.price_cents || "";
  form.elements["currency"].value = machine.currency || "";
  form.elements["renewal_cycle"].value = machine.renewal_cycle || "";
  form.elements["cycle_days"].value = machine.cycle_days || "";
  form.elements["next_renewal"].value = dateInputValue(machine.next_renewal);
  form.elements["remind_days_before"].value = (machine.remind_days_before || []).join(",");
  form.elements["console_url"].value = "";
  form.elements["detail_url"].value = "";
  form.elements["notes"].value = machine.notes || "";
  form.elements["auto_roll"].checked = !!machine.auto_roll;
  form.elements["reminders_enabled"].checked = !!machine.reminders_enabled;
  form.elements["clear_console_url"].checked = false;
  form.elements["clear_detail_url"].checked = false;
  $("machine-error").textContent = "";
}

function resetMachineForm() {
  $("machine-form").reset();
  $("machine-form").elements["id"].value = "";
  $("machine-error").textContent = "";
}

async function submitMachine(event) {
  event.preventDefault();
  $("machine-error").textContent = "";
  const form = new FormData(event.currentTarget);
  const payload = machinePayload({
    id: form.get("id"),
    node_id: form.get("node_id"),
    label: form.get("label"),
    vendor: form.get("vendor"),
    region: form.get("region"),
    notes: form.get("notes"),
    price_cents: form.get("price_cents"),
    currency: form.get("currency"),
    renewal_cycle: form.get("renewal_cycle"),
    cycle_days: form.get("cycle_days"),
    next_renewal: form.get("next_renewal"),
    remind_days_before: form.get("remind_days_before"),
    console_url: form.get("console_url"),
    detail_url: form.get("detail_url"),
    auto_roll: $("machine-form").elements["auto_roll"].checked,
    reminders_enabled: $("machine-form").elements["reminders_enabled"].checked,
    clear_console_url: $("machine-form").elements["clear_console_url"].checked,
    clear_detail_url: $("machine-form").elements["clear_detail_url"].checked,
  });
  try {
    const path = payload.id ? "/api/machines/update" : "/api/machines";
    await api(path, { method: "POST", body: JSON.stringify(payload) });
    resetMachineForm();
    await loadMachines();
  } catch (error) {
    $("machine-error").textContent = error.message;
  }
}

async function renewMachine(id) {
  $("machine-error").textContent = "";
  try {
    await api("/api/machines/renew", { method: "POST", body: JSON.stringify({ id }) });
    await loadMachines();
  } catch (error) {
    $("machine-error").textContent = error.message;
  }
}

async function runMachineReminders() {
  $("machine-error").textContent = "";
  try {
    const data = await api("/api/machines/reminders/run", { method: "POST", body: "{}" });
    const count = Array.isArray(data.fired) ? data.fired.length : 0;
    $("machine-error").textContent = count ? `Fired ${count} reminder(s).` : "No reminders due.";
    await loadMachines();
  } catch (error) {
    $("machine-error").textContent = error.message;
  }
}

async function refresh() {
  const [me, nodes, geoNodes, tasks, results, approvals, kv, workers, auditPayload] = await Promise.all([
    api("/api/me"),
    api("/api/nodes"),
    api("/api/nodes/geo"),
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
  state.nodes = Array.isArray(nodes) ? nodes : [];
  state.geoNodes = Array.isArray(geoNodes) ? geoNodes : [];
  state.tasks = Array.isArray(tasks) ? tasks : [];
  state.results = Array.isArray(results) ? results : [];
  state.approvals = Array.isArray(approvals) ? approvals : [];
  state.kv = Array.isArray(kv) ? kv : [];
  state.workers = Array.isArray(workers) ? workers : [];
  state.audit = audit.events;
  state.auditPage = { total: audit.total, limit: audit.limit, offset: audit.offset };
  render();
  // Self-contained admin panels hide themselves for non-admins (403) without
  // breaking the main console refresh.
  await Promise.all([loadMachines(), loadNFTInputs(), loadNetPolicies(), loadOIDCAdmin(), loadPluginLifecycleAdmin()]);
}

function render() {
  $("node-count").textContent = state.nodes.length;
  $("online-count").textContent = state.nodes.filter((n) => n.online).length;
  $("queued-count").textContent = state.tasks.filter((t) => t.status === "queued").length;
  $("approval-count").textContent = state.approvals.filter((a) => a.status === "pending").length;
  renderNodes();
  renderGeoMap();
  renderResults();
  renderApprovals();
  renderNFTInputs();
  renderNetPolicies();
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
      const host = hostSummary(node);
      return `<tr>
        <td><span class="status ${node.online ? "online" : ""}">${escapeHtml(node.name || node.id)}</span><br><small>${escapeHtml(node.id)}</small></td>
        <td>${escapeHtml(node.role || "node")}</td>
        <td>${host}</td>
        <td>${formatNumber(node.metrics?.cpu_percent)}%</td>
        <td>${mem}</td>
        <td>${disk}</td>
        <td>${escapeHtml(node.agent_version || "-")}</td>
        <td>${formatDate(node.last_seen)}</td>
      </tr>`;
    })
    .join("");
}

function renderGeoMap() {
  const map = $("geo-map");
  const list = $("geo-list");
  if (!map || !list) return;
  const visible = Array.isArray(state.geoNodes) ? state.geoNodes : [];
  const located = nodesWithGeo(visible);
  const pins = located
    .map((node) => {
      const point = projectGeoPoint(node.geo.lat, node.geo.lon);
      const label = geoLabel(node);
      const stateClass = node.online ? "online" : "offline";
      return `<g class="geo-pin ${stateClass}" transform="translate(${point.x.toFixed(1)} ${point.y.toFixed(1)})" data-geo-pin="${escapeHtml(node.id)}">
        <title>${escapeHtml(label)}</title>
        <circle r="7"></circle>
        <circle r="2.5" class="geo-pin-core"></circle>
      </g>`;
    })
    .join("");
  const emptyText = located.length
    ? ""
    : `<text x="${GEO_MAP_WIDTH / 2}" y="${GEO_MAP_HEIGHT / 2}" text-anchor="middle" class="geo-empty">No node locations configured</text>`;
  map.innerHTML = `<svg viewBox="0 0 ${GEO_MAP_WIDTH} ${GEO_MAP_HEIGHT}" role="img" aria-label="Lattice fleet map">
    <rect class="geo-ocean" x="0" y="0" width="${GEO_MAP_WIDTH}" height="${GEO_MAP_HEIGHT}" rx="10"></rect>
    <path class="geo-grid" d="M167 0V460M333 0V460M500 0V460M667 0V460M833 0V460M0 115H1000M0 230H1000M0 345H1000"></path>
    <path class="geo-land" d="M138 125l52-35 86 18 45 48-24 55 42 48-44 61-94 23-76-35-27-80 18-69zM347 114l92-39 92 24 35 72-31 64 47 55-50 61-96 14-76-43-9-75-47-39zM587 118l118-32 120 39 74 78-25 92-99 44-98-18-54-77-67 7-35-50zM674 306l84 24 36 59-41 44-91-12-38-56zM452 269l48 29 12 70-41 58-52-39-6-73z"></path>
    ${emptyText}
    ${pins}
  </svg>`;
  map.querySelectorAll("[data-geo-pin]").forEach((pin) => {
    pin.addEventListener("click", () => fillGeoForm(pin.dataset.geoPin));
  });

  if (!visible.length) {
    list.innerHTML = `<article class="kv-item"><span class="muted">No visible nodes.</span></article>`;
    return;
  }
  list.innerHTML = visible
    .map((node) => {
      const geo = node.geo || {};
      const place = [geo.city, geo.country].filter(Boolean).join(", ") || "not set";
      const coords = geo.lat !== undefined && geo.lon !== undefined
        ? `${Number(geo.lat).toFixed(4)}, ${Number(geo.lon).toFixed(4)}`
        : "-";
      return `<article class="kv-item geo-node">
        <div class="oidc-provider-head">
          <div>
            <strong>${escapeHtml(node.name || node.id)}</strong>
            <small class="mono">${escapeHtml(node.id)}</small>
          </div>
          <span class="oidc-actions">
            <button type="button" class="secondary" data-geo-fill="${escapeHtml(node.id)}">${node.geo ? "Edit" : "Add"}</button>
          </span>
        </div>
        <div class="geo-node-meta">
          <span class="${node.online ? "pill" : "danger"}">${node.online ? "online" : "offline"}</span>
          <span class="muted">${escapeHtml(place)}</span>
          <span class="mono">${escapeHtml(coords)}</span>
          ${geo.asn ? `<span class="pill">AS${escapeHtml(geo.asn)}</span>` : ""}
          ${geo.provider ? `<span class="pill">${escapeHtml(geo.provider)}</span>` : ""}
        </div>
      </article>`;
    })
    .join("");
  list.querySelectorAll("[data-geo-fill]").forEach((button) => {
    button.addEventListener("click", () => fillGeoForm(button.dataset.geoFill));
  });
}

function findGeoNode(nodeID) {
  return state.geoNodes.find((node) => node.id === nodeID) || state.nodes.find((node) => node.id === nodeID);
}

function fillGeoForm(nodeID) {
  const node = findGeoNode(nodeID);
  if (!node) return;
  const geo = node.geo || {};
  const form = $("geo-form");
  form.elements["node_id"].value = node.id || "";
  form.elements["country"].value = geo.country || "";
  form.elements["city"].value = geo.city || "";
  form.elements["lat"].value = geo.lat ?? "";
  form.elements["lon"].value = geo.lon ?? "";
  form.elements["asn"].value = geo.asn || "";
  form.elements["as_org"].value = geo.as_org || "";
  form.elements["provider"].value = geo.provider || "";
  $("geo-error").textContent = "";
}

function resetGeoForm() {
  $("geo-form").reset();
  $("geo-error").textContent = "";
}

async function submitGeo(event) {
  event.preventDefault();
  $("geo-error").textContent = "";
  const form = new FormData(event.currentTarget);
  let payload;
  try {
    payload = geoPayload({
      node_id: form.get("node_id"),
      country: form.get("country"),
      city: form.get("city"),
      lat: form.get("lat"),
      lon: form.get("lon"),
      asn: form.get("asn"),
      as_org: form.get("as_org"),
      provider: form.get("provider"),
    });
  } catch (error) {
    $("geo-error").textContent = error.message;
    return;
  }
  try {
    await api("/api/nodes/geo", { method: "POST", body: JSON.stringify(payload) });
    resetGeoForm();
    await refresh();
  } catch (error) {
    $("geo-error").textContent = error.message;
  }
}

async function clearGeo() {
  $("geo-error").textContent = "";
  let payload;
  try {
    payload = geoClearPayload($("geo-form").elements["node_id"].value);
  } catch (error) {
    $("geo-error").textContent = error.message;
    return;
  }
  try {
    await api("/api/nodes/geo", { method: "POST", body: JSON.stringify(payload) });
    resetGeoForm();
    await refresh();
  } catch (error) {
    $("geo-error").textContent = error.message;
  }
}

function renderResults() {
  $("task-results").innerHTML = state.results
    .slice(0, 12)
    .map((result) => `<article class="result">
      <strong>${escapeHtml(result.node_id)}</strong>
      <span class="pill">exit ${escapeHtml(result.exit_code)}</span>
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

async function loadNFTInputs() {
  try {
    const data = await api("/api/network/nft/inputs");
    state.nftInputs = Array.isArray(data.inputs) ? data.inputs : [];
    renderNFTInputs();
  } catch {
    state.nftInputs = [];
    renderNFTInputs();
  }
}

function renderNFTInputs() {
  const container = $("nft-inputs");
  if (!container) return;
  container.innerHTML = state.nftInputs
    .map((entry) => `<article class="kv-item">
      <div class="oidc-provider-head">
        <strong>${escapeHtml(entry.node_name || entry.node_id)}</strong>
        <span class="oidc-actions">
          <button type="button" class="secondary" data-nft-edit="${escapeHtml(entry.node_id)}">Edit</button>
          <button type="button" class="secondary" data-nft-delete="${escapeHtml(entry.node_id)}">Delete</button>
        </span>
      </div>
      <small class="mono">${escapeHtml(entry.interface_name || "eth0")} · ${escapeHtml(entry.wireguard_cidr || "10.66.0.0/24")}</small>
      <div class="muted">public tcp ${escapeHtml(formatPorts(entry.public_tcp) || "-")} · public udp ${escapeHtml(formatPorts(entry.public_udp) || "-")}</div>
      <div class="muted">wg tcp ${escapeHtml(formatPorts(entry.wireguard_tcp) || "-")} · wg udp ${escapeHtml(formatPorts(entry.wireguard_udp) || "-")}</div>
    </article>`)
    .join("");
  container.querySelectorAll("[data-nft-edit]").forEach((button) => {
    button.addEventListener("click", () => editNFTInputs(button.dataset.nftEdit));
  });
  container.querySelectorAll("[data-nft-delete]").forEach((button) => {
    button.addEventListener("click", () => deleteNFTInputs(button.dataset.nftDelete));
  });
}

function editNFTInputs(nodeID) {
  const entry = state.nftInputs.find((x) => x.node_id === nodeID);
  if (!entry) return;
  const form = $("nft-form");
  form.elements["node_id"].value = entry.node_id || "";
  form.elements["interface_name"].value = entry.interface_name || "";
  form.elements["wireguard_cidr"].value = entry.wireguard_cidr || "";
  form.elements["public_tcp"].value = formatPorts(entry.public_tcp);
  form.elements["public_udp"].value = formatPorts(entry.public_udp);
  form.elements["wg_tcp"].value = formatPorts(entry.wireguard_tcp);
  form.elements["wg_udp"].value = formatPorts(entry.wireguard_udp);
  $("nft-error").textContent = "";
}

function resetNFTForm() {
  $("nft-form").reset();
  $("nft-error").textContent = "";
}

async function deleteNFTInputs(nodeID) {
  $("nft-error").textContent = "";
  try {
    await api("/api/network/nft/inputs/delete", { method: "POST", body: JSON.stringify({ node_id: nodeID }) });
    await loadNFTInputs();
  } catch (error) {
    $("nft-error").textContent = error.message;
  }
}

async function loadNetPolicies() {
  const panel = $("netpolicy-panel");
  if (!panel) return;
  try {
    const [policies, graph] = await Promise.all([
      api("/api/netpolicy"),
      api("/api/netpolicy/graph"),
    ]);
    state.netPolicies = Array.isArray(policies.policies) ? policies.policies : [];
    state.netPolicyGraph = graph && typeof graph === "object"
      ? {
          nodes: Array.isArray(graph.nodes) ? graph.nodes : [],
          edges: Array.isArray(graph.edges) ? graph.edges : [],
          externals: Array.isArray(graph.externals) ? graph.externals : [],
        }
      : { nodes: [], edges: [], externals: [] };
    panel.classList.remove("hidden");
    $("netpolicy-error").textContent = "";
    renderNetPolicies();
  } catch {
    state.netPolicies = [];
    state.netPolicyGraph = { nodes: [], edges: [], externals: [] };
    panel.classList.add("hidden");
  }
}

function renderNetPolicies() {
  renderNetPolicyList();
  renderNetPolicyGraph();
}

function renderNetPolicyList() {
  const container = $("netpolicy-list");
  if (!container) return;
  if (!state.netPolicies.length) {
    container.innerHTML = `<article class="kv-item"><span class="muted">No policy intents saved.</span></article>`;
    return;
  }
  container.innerHTML = state.netPolicies.map((policy) => {
    const rules = Array.isArray(policy.rules) ? policy.rules : [];
    const rulesHTML = rules.length
      ? `<ol class="netpolicy-rules">${rules.map((rule) => `<li>${escapeHtml(describeNetRule(rule))}${rule.comment ? `<br><small class="muted">${escapeHtml(rule.comment)}</small>` : ""}</li>`).join("")}</ol>`
      : `<small class="muted">No rules.</small>`;
    return `<article class="kv-item netpolicy-card">
      <div class="oidc-provider-head">
        <div>
          <strong>${escapeHtml(policy.target_node_name || policy.target_node_id)}</strong>
          <small class="mono">${escapeHtml(policy.target_node_id)}</small>
        </div>
        <span class="oidc-actions">
          <button type="button" class="secondary" data-netpolicy-fill="${escapeHtml(policy.target_node_id)}">Add Rule</button>
          <button type="button" class="secondary" data-netpolicy-plan="${escapeHtml(policy.target_node_id)}">Plan Apply</button>
          <button type="button" class="secondary" data-netpolicy-delete="${escapeHtml(policy.target_node_id)}">Delete</button>
        </span>
      </div>
      <span class="${policy.enabled ? "pill" : "danger"}">${policy.enabled ? "enabled" : "disabled"}</span>
      ${rulesHTML}
    </article>`;
  }).join("");
  container.querySelectorAll("[data-netpolicy-fill]").forEach((button) => {
    button.addEventListener("click", () => fillNetPolicyTarget(button.dataset.netpolicyFill));
  });
  container.querySelectorAll("[data-netpolicy-plan]").forEach((button) => {
    button.addEventListener("click", () => planNetPolicy(button.dataset.netpolicyPlan));
  });
  container.querySelectorAll("[data-netpolicy-delete]").forEach((button) => {
    button.addEventListener("click", () => deleteNetPolicy(button.dataset.netpolicyDelete));
  });
}

function renderNetPolicyGraph() {
  const container = $("netpolicy-graph");
  if (!container) return;
  const graph = state.netPolicyGraph || { nodes: [], edges: [], externals: [] };
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph.edges) ? graph.edges : [];
  const externals = Array.isArray(graph.externals) ? graph.externals : [];
  const nodeHTML = nodes.length
    ? `<div class="netpolicy-node-row">${nodes.map((node) => `<span class="pill">${escapeHtml(node.name || node.id)}</span>`).join("")}</div>`
    : `<small class="muted">No visible nodes.</small>`;
  const edgeHTML = edges.length
    ? edges.map((edge) => `<li><span class="${edge.action === "deny" ? "danger" : "pill"}">${escapeHtml(edge.action)}</span> <span class="muted">${escapeHtml(edge.direction || "")}</span> ${escapeHtml(edge.from)} -&gt; ${escapeHtml(edge.to)} <span class="mono">${escapeHtml(edge.protocol || "any")}${edge.ports?.length ? ":" + escapeHtml(edge.ports.join(",")) : ""}</span></li>`).join("")
    : `<li><span class="muted">No node-to-node edges.</span></li>`;
  const externalHTML = externals.length
    ? externals.map((edge) => `<li><span class="${edge.action === "deny" ? "danger" : "pill"}">${escapeHtml(edge.action)}</span> <span class="muted">${escapeHtml(edge.direction || "")}</span> ${escapeHtml(edge.target_node_id)} &lt;-&gt; ${escapeHtml(edge.remote)} <span class="mono">${escapeHtml(edge.protocol || "any")}${edge.ports?.length ? ":" + escapeHtml(edge.ports.join(",")) : ""}</span></li>`).join("")
    : `<li><span class="muted">No external refs.</span></li>`;
  container.innerHTML = `<article class="kv-item netpolicy-graph-card">
    <strong>Policy graph</strong>
    ${nodeHTML}
    <div class="netpolicy-graph-grid">
      <div><small class="muted">Node rules</small><ul>${edgeHTML}</ul></div>
      <div><small class="muted">External rules</small><ul>${externalHTML}</ul></div>
    </div>
  </article>`;
}

function fillNetPolicyTarget(nodeID) {
  const form = $("netpolicy-form");
  if (!form) return;
  form.elements["target_node_id"].value = nodeID || "";
  $("netpolicy-error").textContent = "";
}

function resetNetPolicyForm() {
  const form = $("netpolicy-form");
  if (!form) return;
  form.reset();
  $("netpolicy-error").textContent = "";
}

async function submitNetPolicy(event) {
  event.preventDefault();
  $("netpolicy-error").textContent = "";
  const form = new FormData(event.currentTarget);
  const target = String(form.get("target_node_id") || "").trim();
  const existing = state.netPolicies.find((policy) => policy.target_node_id === target);
  let payload;
  try {
    payload = netPolicyPayload(existing, {
      target_node_id: form.get("target_node_id"),
      action: form.get("action"),
      direction: form.get("direction"),
      protocol: form.get("protocol"),
      ports: form.get("ports"),
      remote_kind: form.get("remote_kind"),
      remote_node_id: form.get("remote_node_id"),
      remote_cidr: form.get("remote_cidr"),
      comment: form.get("comment"),
      enabled: $("netpolicy-form").elements["enabled"].checked,
    });
  } catch (error) {
    $("netpolicy-error").textContent = error.message;
    return;
  }
  try {
    await api("/api/netpolicy", { method: "POST", body: JSON.stringify(payload) });
    resetNetPolicyForm();
    await loadNetPolicies();
  } catch (error) {
    $("netpolicy-error").textContent = error.message;
  }
}

async function deleteNetPolicy(targetNodeID) {
  $("netpolicy-error").textContent = "";
  try {
    await api("/api/netpolicy/delete", { method: "POST", body: JSON.stringify({ target_node_id: targetNodeID }) });
    await loadNetPolicies();
  } catch (error) {
    $("netpolicy-error").textContent = error.message;
  }
}

async function planNetPolicy(targetNodeID) {
  $("netpolicy-error").textContent = "";
  try {
    await api("/api/netpolicy/plan", { method: "POST", body: JSON.stringify({ node_id: targetNodeID }) });
    await refresh();
  } catch (error) {
    $("netpolicy-error").textContent = error.message;
  }
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
  $("nft-error").textContent = "";
  const form = new FormData(event.currentTarget);
  const payload = nftInputsPayload({
    node_id: form.get("node_id"),
    interface_name: form.get("interface_name"),
    wireguard_cidr: form.get("wireguard_cidr"),
    public_tcp: form.get("public_tcp"),
    public_udp: form.get("public_udp"),
    wireguard_tcp: form.get("wg_tcp"),
    wireguard_udp: form.get("wg_udp"),
  });
  try {
    await api("/api/network/nft/inputs", { method: "POST", body: JSON.stringify(payload) });
    if (event.submitter?.value !== "save") {
      await api("/api/network/nft/plan", {
        method: "POST",
        body: JSON.stringify({ node_id: payload.node_id }),
      });
    }
    await refresh();
  } catch (error) {
    $("nft-error").textContent = error.message;
  }
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

function percent(used, total) {
  if (!total) return "-";
  return `${Math.round((Number(used || 0) / Number(total)) * 100)}%`;
}

function hostSummary(node) {
  const facts = node.host_facts || {};
  const platform = [facts.os, facts.platform].filter(Boolean).join("/");
  const line1 = [facts.arch, platform].filter(Boolean).join(" · ") || "-";
  const line2 = [
    facts.cpu_cores ? `${Number(facts.cpu_cores)} cores` : "",
    formatBytes(facts.memory_total || node.metrics?.memory_total),
    formatDuration(node.metrics?.uptime_seconds),
  ].filter(Boolean).join(" · ");
  return `<span>${escapeHtml(line1)}</span>${line2 ? `<br><small>${escapeHtml(line2)}</small>` : ""}`;
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!bytes) return "";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatDuration(seconds) {
  const s = Number(seconds || 0);
  if (!s) return "";
  const days = Math.floor(s / 86400);
  if (days > 0) return `${days}d`;
  const hours = Math.floor(s / 3600);
  if (hours > 0) return `${hours}h`;
  const minutes = Math.floor(s / 60);
  return `${minutes}m`;
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
$("machine-form").addEventListener("submit", submitMachine);
$("machine-reset").addEventListener("click", resetMachineForm);
$("machines-reminders-run").addEventListener("click", runMachineReminders);
$("geo-form").addEventListener("submit", submitGeo);
$("geo-clear").addEventListener("click", clearGeo);
$("geo-reset").addEventListener("click", resetGeoForm);
$("task-form").addEventListener("submit", queueTask);
$("kv-form").addEventListener("submit", saveKV);
$("worker-form").addEventListener("submit", deployWorker);
$("nft-form").addEventListener("submit", createNFTPlan);
$("nft-reset").addEventListener("click", resetNFTForm);
$("netpolicy-form").addEventListener("submit", submitNetPolicy);
$("netpolicy-reset").addEventListener("click", resetNetPolicyForm);
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

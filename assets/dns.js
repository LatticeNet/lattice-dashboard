function splitList(value) {
  const seen = new Set();
  for (const part of String(value || "").split(/[,\s]+/)) {
    const v = part.trim();
    if (v) seen.add(v);
  }
  return [...seen];
}

function numberOrZero(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

export function dnsDeploymentPayload(fields) {
  const mode = String(fields.zone_mode || "forward").trim() || "forward";
  const zone = {
    suffix: String(fields.zone_suffix || ".").trim() || ".",
    mode,
  };
  if (mode === "forward") {
    zone.upstreams = splitList(fields.upstreams);
  } else if (mode === "static") {
    zone.records = [{
      name: String(fields.record_name || "").trim(),
      type: String(fields.record_type || "A").trim() || "A",
      value: String(fields.record_value || "").trim(),
    }];
    const ttl = numberOrZero(fields.record_ttl);
    if (ttl) zone.records[0].ttl = ttl;
  }

  const body = {
    name: String(fields.name || "").trim(),
    node_id: String(fields.node_id || "").trim(),
    engine: String(fields.engine || "coredns").trim() || "coredns",
    listen_port: numberOrZero(fields.listen_port),
    enable_udp: fields.enable_udp !== false,
    enable_tcp: fields.enable_tcp !== false,
    exposure: String(fields.exposure || "mesh").trim() || "mesh",
    zones: [zone],
    hostname: String(fields.hostname || "").trim(),
    ddns_profile_id: String(fields.ddns_profile_id || "").trim(),
    publish_ipv4: fields.publish_ipv4 !== false,
    publish_ipv6: fields.publish_ipv6 === true,
    record_ttl: numberOrZero(fields.record_ttl) || 60,
    disabled: fields.disabled === true,
  };
  const id = String(fields.id || "").trim();
  if (id) body.id = id;
  const token = String(fields.cf_api_token || "");
  if (token) body.cf_api_token = token;
  return body;
}

export function dnsZoneSummary(zones) {
  if (!Array.isArray(zones) || !zones.length) return "-";
  return zones.map((zone) => {
    const suffix = zone.suffix || ".";
    const mode = zone.mode || "forward";
    if (mode === "forward") return `${suffix} forward ${Array.isArray(zone.upstreams) ? zone.upstreams.join(",") : ""}`.trim();
    if (mode === "static") return `${suffix} static ${Array.isArray(zone.records) ? zone.records.length : 0} record(s)`;
    return `${suffix} ${mode}`;
  }).join(" · ");
}

export function dnsProtocols(dep) {
  const out = [];
  if (dep?.enable_udp) out.push("udp");
  if (dep?.enable_tcp) out.push("tcp");
  return out.join(",") || "-";
}

export function dnsPublishSummary(dep) {
  const ips = [];
  if (dep?.last_ipv4) ips.push(dep.last_ipv4);
  if (dep?.last_ipv6) ips.push(dep.last_ipv6);
  return ips.length ? `published ${ips.join(" / ")}` : "";
}

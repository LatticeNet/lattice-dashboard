export const GEO_MAP_WIDTH = 1000;
export const GEO_MAP_HEIGHT = 460;

function parseRequiredNumber(value, name) {
  const raw = String(value ?? "").trim();
  if (!raw) throw new Error(`${name} is required`);
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return n;
}

export function projectGeoPoint(lat, lon, width = GEO_MAP_WIDTH, height = GEO_MAP_HEIGHT) {
  const yLat = Number(lat);
  const xLon = Number(lon);
  if (!Number.isFinite(yLat) || yLat < -90 || yLat > 90) {
    throw new Error("lat must be between -90 and 90");
  }
  if (!Number.isFinite(xLon) || xLon < -180 || xLon > 180) {
    throw new Error("lon must be between -180 and 180");
  }
  return {
    x: ((xLon + 180) / 360) * width,
    y: ((90 - yLat) / 180) * height,
  };
}

export function geoPayload(fields) {
  const nodeID = String(fields.node_id || "").trim();
  if (!nodeID) throw new Error("node id is required");
  const lat = parseRequiredNumber(fields.lat, "lat");
  const lon = parseRequiredNumber(fields.lon, "lon");
  projectGeoPoint(lat, lon);
  const country = String(fields.country || "").trim().toUpperCase();
  if (country && !/^[A-Z]{2}$/.test(country)) {
    throw new Error("country must be a 2-letter code");
  }
  const geo = {
    country,
    city: String(fields.city || "").trim(),
    lat,
    lon,
    as_org: String(fields.as_org || "").trim(),
    provider: String(fields.provider || "").trim(),
  };
  const asnRaw = String(fields.asn ?? "").trim();
  if (asnRaw) {
    if (!/^\d+$/.test(asnRaw)) throw new Error("asn must be non-negative");
    geo.asn = Number(asnRaw);
  }
  return { node_id: nodeID, geo };
}

export function geoClearPayload(nodeID) {
  const id = String(nodeID || "").trim();
  if (!id) throw new Error("node id is required");
  return { node_id: id, clear: true };
}

export function nodesWithGeo(nodes) {
  return (Array.isArray(nodes) ? nodes : []).filter((node) => {
    const geo = node?.geo;
    if (!geo) return false;
    const lat = Number(geo.lat);
    const lon = Number(geo.lon);
    return Number.isFinite(lat) && lat >= -90 && lat <= 90 &&
      Number.isFinite(lon) && lon >= -180 && lon <= 180;
  });
}

export function geoLabel(node) {
  const geo = node?.geo || {};
  const parts = [node?.name || node?.id || "node"];
  const place = [geo.city, geo.country].filter(Boolean).join(", ");
  if (place) parts.push(place);
  if (geo.asn) parts.push(`AS${geo.asn}`);
  if (geo.as_org) parts.push(geo.as_org);
  if (geo.provider) parts.push(geo.provider);
  return parts.join(" · ");
}

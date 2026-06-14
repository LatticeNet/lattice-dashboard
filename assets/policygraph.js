export const POLICY_GRAPH_WIDTH = 920;
export const POLICY_GRAPH_HEIGHT = 340;

function cleanID(value) {
  return String(value || "").trim();
}

function knownAction(action) {
  return action === "allow" || action === "deny" ? action : "deny";
}

function portText(ports) {
  return Array.isArray(ports) && ports.length ? ":" + ports.join(",") : "";
}

export function compactPolicyNodeLabel(value, max = 18) {
  const label = String(value || "").trim() || "node";
  if (label.length <= max) return label;
  return label.slice(0, Math.max(1, max - 3)) + "...";
}

export function policyEdgeLabel(edge) {
  const proto = edge?.protocol || "any";
  return `${edge?.action || ""} ${edge?.direction || ""} ${edge?.from || ""} -> ${edge?.to || ""} ${proto}${portText(edge?.ports)}`.trim();
}

export function policyExternalLabel(edge) {
  const proto = edge?.protocol || "any";
  return `${edge?.action || ""} ${edge?.direction || ""} ${edge?.target_node_id || ""} <-> ${edge?.remote || ""} ${proto}${portText(edge?.ports)}`.trim();
}

export function normalizePolicyGraph(graph) {
  const rawNodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const seen = new Set();
  const nodes = [];
  for (const node of rawNodes) {
    const id = cleanID(node?.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    nodes.push({
      id,
      name: cleanID(node?.name) || id,
      online: node?.online === true,
    });
  }
  const nodeIDs = new Set(nodes.map((node) => node.id));
  const edges = (Array.isArray(graph?.edges) ? graph.edges : [])
    .map((edge) => ({
      from: cleanID(edge?.from),
      to: cleanID(edge?.to),
      action: knownAction(edge?.action),
      protocol: cleanID(edge?.protocol) || "any",
      direction: cleanID(edge?.direction),
      ports: Array.isArray(edge?.ports) ? edge.ports.filter((p) => Number.isInteger(Number(p))).map(Number) : [],
      rule_id: cleanID(edge?.rule_id),
    }))
    .filter((edge) => edge.from && edge.to && edge.from !== edge.to && nodeIDs.has(edge.from) && nodeIDs.has(edge.to));
  const externals = (Array.isArray(graph?.externals) ? graph.externals : [])
    .map((edge) => ({
      target_node_id: cleanID(edge?.target_node_id),
      action: knownAction(edge?.action),
      remote: cleanID(edge?.remote),
      protocol: cleanID(edge?.protocol) || "any",
      direction: cleanID(edge?.direction),
      ports: Array.isArray(edge?.ports) ? edge.ports.filter((p) => Number.isInteger(Number(p))).map(Number) : [],
      rule_id: cleanID(edge?.rule_id),
    }))
    .filter((edge) => edge.target_node_id && edge.remote && nodeIDs.has(edge.target_node_id));
  return { nodes, edges, externals };
}

export function policyExternalGroups(graph) {
  const normalized = normalizePolicyGraph(graph);
  const byTarget = new Map();
  for (const edge of normalized.externals) {
    if (!byTarget.has(edge.target_node_id)) byTarget.set(edge.target_node_id, []);
    byTarget.get(edge.target_node_id).push(edge);
  }
  return [...byTarget.entries()].map(([targetNodeID, edges]) => ({ targetNodeID, edges }));
}

function nodePoint(index, count, width, height) {
  if (count === 1) {
    return { x: width / 2, y: height / 2 };
  }
  const radius = Math.max(80, Math.min(width, height) * 0.34);
  const angle = (-Math.PI / 2) + (2 * Math.PI * index / count);
  return {
    x: width / 2 + Math.cos(angle) * radius,
    y: height / 2 + Math.sin(angle) * radius,
  };
}

function edgePath(from, to, index) {
  const midX = (from.x + to.x) / 2;
  const midY = (from.y + to.y) / 2;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.max(Math.hypot(dx, dy), 1);
  const offset = ((index % 3) - 1) * 18;
  const cx = midX + (-dy / length) * offset;
  const cy = midY + (dx / length) * offset;
  return `M${from.x.toFixed(1)} ${from.y.toFixed(1)} Q${cx.toFixed(1)} ${cy.toFixed(1)} ${to.x.toFixed(1)} ${to.y.toFixed(1)}`;
}

function arrowPoints(from, to) {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const tip = { x: to.x, y: to.y };
  const size = 9;
  const spread = Math.PI / 7;
  const left = {
    x: tip.x - Math.cos(angle - spread) * size,
    y: tip.y - Math.sin(angle - spread) * size,
  };
  const right = {
    x: tip.x - Math.cos(angle + spread) * size,
    y: tip.y - Math.sin(angle + spread) * size,
  };
  return [tip, left, right].map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
}

export function policyGraphView(graph, width = POLICY_GRAPH_WIDTH, height = POLICY_GRAPH_HEIGHT) {
  const normalized = normalizePolicyGraph(graph);
  const points = new Map();
  const nodes = normalized.nodes.map((node, index) => {
    const point = nodePoint(index, normalized.nodes.length, width, height);
    const title = node.name || node.id;
    const view = { ...node, ...point, label: compactPolicyNodeLabel(title), title };
    points.set(node.id, point);
    return view;
  });
  const edges = normalized.edges.map((edge, index) => {
    const from = points.get(edge.from);
    const to = points.get(edge.to);
    return {
      ...edge,
      className: edge.action,
      label: policyEdgeLabel(edge),
      path: edgePath(from, to, index),
      arrow: arrowPoints(from, to),
    };
  });
  return {
    width,
    height,
    nodes,
    edges,
    externalGroups: policyExternalGroups(normalized),
  };
}

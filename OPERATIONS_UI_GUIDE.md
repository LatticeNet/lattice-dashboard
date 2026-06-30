# Lattice Operations UI Guide

This document records the operator-facing interaction contracts for the fleet,
network, approval, and official vpn-core plugin surfaces. It is intentionally
practical: if a page can mutate infrastructure state, this guide describes what
is authoritative, what is display-only, and where the operator should go to make
the change deliberately.

## Dashboard home

The Overview KPI cards are drill-through summaries, not miniature reports.

- `Online` links to `/nodes?status=online`.
- The secondary status, for example `4 offline`, is displayed inline beside the
  primary count so all KPI cards keep the same visual height.
- Counts are derived from the normal node list API and inherit the caller's
  scopes and server allowlist.

## Nodes page

The Nodes page is the main fleet workbench. It is optimized for scan-many
operations first, with enrollment hidden behind a deliberate action.

### Enroll node

Enrollment is opened from the header `Enroll` button rather than shown as a
large default card at the top of the page. This keeps the node list, filters,
duplicate warnings, and live fleet stats above the fold for normal operation.

The enrollment panel still supports the full prior flow:

- operator-owned identity: name, optional node id, role, tags, comment
- optional WireGuard IP
- optional group membership at enrollment
- generated one-time enroll token and copyable Linux/manual command
- startup flags persisted into the installed service

The `comment` field is control-plane-only metadata. It is not sent to the
node-agent and must not be used as an authz, policy, or config source.

### Advanced startup config

Startup flags are behind `Agent launch profile` advanced config. Use this before
copying the enroll command when the installed service should start with
non-default capabilities:

- task execution: required for Tasks and read-only sing-box probes
- root execution: required only when root-owned host config must be mutated
- no-exec kill switch: forces task and terminal execution off
- browser terminal
- terminal transport
- ssh login alerts
- sing-box discovery
- sing-box binary path
- proxy usage file/URL/Xray API hints

The saved profile is desired startup state. It is useful for generating enroll
and reconfigure commands, but the control plane should not treat it as proof of
the currently running process flags until the agent reports matching runtime
state.

### Tags

Tags are normalized for stable display. The server trims, deduplicates, and sorts
tags when node metadata is updated; the dashboard also sorts before rendering so
older records remain stable.

## Node detail page

Node detail is the safest place to inspect one host. It separates display-only
facts from deliberate mutation forms.

### Identity and comment

The identity card edits name, role, tags, and comment. The comment is rendered
near the node header for all readers and is edited only by operators with
`node:admin`.

Recommended comment content:

- renewal or billing notes
- provider quirks
- rack/region/operator ownership
- migration context
- "do not delete" or rollback hints

Do not put secrets in comments.

### Network & IP

`Public IP` and `Public IPv6` are the routable addresses observed or configured
for the node. These are used for map lookup and operator display.

`Internal IP` and `Internal IPv6` are low-trust telemetry reported by the agent's
host introspection. On some VPS providers the primary interface address is the
same as the public address. When the internal value equals the public value, the
dashboard now displays `same as public / not separately reported` instead of
presenting it as a distinct LAN address.

This distinction matters:

- public IP is routability / GeoIP-oriented
- internal IP is informational host telemetry
- neither should be used as a sole node identity
- policy code should use stable node ids, WireGuard ids, or explicit policy
  endpoints rather than trusting host-reported internal addresses

### Host facts

Host facts are reported by the node-agent and sanitized server-side. They remain
advisory telemetry.

The kernel field is read from `kernel_version`; older dashboard code used
`kernel`, which made Linux kernels appear missing even when the agent had
reported them. The dashboard keeps `kernel` as a backward-compatible fallback.

Swap is displayed from `swap_total`. A zero value means the agent reported no
swap or the host has no swap configured; it is not an error by itself.

### Groups

The node detail Groups card is read-only. Clicking a group chip deep-links to
the Groups page with that group selected.

Membership changes are intentionally made from the Groups page only. This avoids
accidental one-click group membership changes from a node detail sidebar and
keeps the canonical group membership workflow in one place.

## Groups page

Groups are operator-owned organization and policy inputs.

There are two membership concepts:

- explicit members: canonical, policy-relevant membership
- smart selector: display/preview helper based on tags, roles, country, or
  continent

The former `Generate from tags` action created many groups in one click and made
review awkward. That action is no longer shown in the header.

Instead, the group editor provides `Quick select by tag` in the explicit members
section. Select a tag and click `Select matching nodes`; matching nodes are added
to the current form only. The operator still reviews the form and clicks Save
before the group is persisted.

## Fleet Map

The map behaves like a small operations canvas, not a static image:

- pinch/`ctrl` wheel zooms around the cursor position
- two-finger scroll pans the current viewport
- click-drag pans the current viewport
- `+`, `-`, and `reset` remain available for mouse-only operators

Region Rollup and Unlocated lists are constrained to internal scroll containers
so a long region list does not stretch the main map card and leave a large empty
column under the map. Marker hover cards use the transformed viewport
coordinates, so tooltips stay attached to nodes while panning and zooming.

## Node agent updates

The old Platform -> Agent Updates table is no longer a primary navigation item.
Agent update state is shown where operators make node decisions:

- Nodes table/card: compact update mode (`auto-update`, `manual update`, or no
  policy)
- Node detail: current agent version, target/latest release, last planned and
  applied versions, last error, auto-update toggle, and `Plan official update`

The simplified UI intentionally does not expose binary URL, SHA-256, install
path, or service name fields. Leaving `binary_url` and `sha256` empty asks the
server to resolve the official `LatticeNet/lattice-node-agent` GitHub release:
it resolves `latest` to the release tag, picks the node's OS/arch artifact, reads
`SHA256SUMS`, and pins the generated update task to that exact URL and digest.

The safety boundary is unchanged: planning creates an Approval, approval binds
the plan hash, and the node must run an exec/root-exec enabled agent before the
task can replace the binary and restart the service.

This gives the convenience of tag-based bulk selection without converting every
fleet tag into a persistent group automatically.

## Fleet Map

The Fleet Map is a geographic visibility tool. It is not a policy topology
compiler.

### Layout

The map card and right-hand rollups are independent in height. The region and
unlocated cards no longer stretch the map card, so the map does not accumulate a
large blank area beneath the SVG.

Top stat cards are intentionally compact:

- coverage
- online/offline
- regions/countries
- auto/manual location source split

### Marker hover and zoom

Map markers support hover and keyboard focus details:

- node name/id
- location label
- online/offline
- lookup IP
- location source
- coordinates

The built-in zoom control performs center zoom on the local SVG map. The map
still uses bundled geometry and no external map tiles, so this is a lightweight
operator zoom rather than a full slippy-map implementation.

### Authoritative data

`NodeGeo` is operator-owned display metadata. Auto lookup can fill it, and manual
edits can override it. It must not be used as identity, authorization input, or
firewall compilation input.

## Network Guard inputs dialog

`New guard inputs` creates or updates per-node baseline inputs for the Network
Guard nftables renderer.

Fields:

- `Node`: the node these inputs belong to
- `Interface name`: the public/network interface to guard, for example `eth0`
- `WireGuard CIDR`: the mesh CIDR used for peer allow/deny composition
- `Public TCP ports`: TCP ports intentionally reachable on the public interface
- `Public UDP ports`: UDP ports intentionally reachable on the public interface
- `WireGuard TCP ports`: TCP ports reachable only from WireGuard peers
- `WireGuard UDP ports`: UDP ports reachable only from WireGuard peers

Ports are comma-separated. The server normalizes, deduplicates, validates
`1..65535`, and sorts before storing.

These inputs are not the same as vpn-core sing-box lines. They describe the
baseline firewall shape for a node. Network policy and DNS/self-hosting flows can
compose into this same guard model, but mutation still goes through plan,
approval, and apply rather than direct dashboard writes.

## Network policy page

`/network/policy` is the operator intent layer for network reachability rules.

The topology view is region-oriented because it answers "where will traffic
flow?" and "which geographic clusters are affected?" from the current node geo
metadata and policy endpoints. It is not meant to mirror the Groups page exactly.

Groups still matter in network policy:

- a policy endpoint can target a group
- group membership resolves to nodes when the graph/plan is built
- group edits happen in Groups

Region topology is a visualization lens over the resolved graph. It helps spot
cross-region exposure, hub/spoke drift, and unexpected WAN paths. If an operator
expects business groups, use the rule endpoint details and Groups page; if an
operator expects traffic geography, use the policy topology.

## Approvals page

Approvals are the review gate for high-impact operations. A pending approval
captures a reviewed plan before an agent-side or host-risk mutation is queued.

Typical approval-backed operations:

- nft/network guard apply
- netpolicy apply
- DNS/CoreDNS deploy
- proxy/sing-box apply
- other host-risk plugin or system operations as they are added

The page is responsible for:

- showing pending plans and their target node/action
- accepting or rejecting the plan
- preserving audit context
- preventing "button clicked means host mutated" ambiguity

Approvals are deliberately separate from Tasks. A Task is execution. An Approval
is authorization of a reviewed mutation plan before execution is allowed.

## vpn-core plugin pages

The official `latticenet.vpn-core` plugin contributes VPN Manage pages:

- Lines
- Users
- Node Profiles
- Subscriptions
- Usage

The dashboard treats these as built-in views registered by plugin contribution
keys. The plugin manifest supplies navigation and interface declarations; the
dashboard/server builtin registries resolve those keys to trusted first-party
views.

Important operational boundary:

- sing-box node config remains the source of truth on the node
- vpn-core is a control-plane tool entrypoint and backup/management surface
- writes to node sing-box config should preserve lattice metadata comments where
  applicable, for example `lattice_comment_<field>` style annotations, so future
  reads can map operator intent back to concrete sing-box config
- discovered-only lines should be treated as observed runtime/config facts until
  explicitly adopted or managed

For plugin-specific capability details, see `../lattice-plugin-vpn-core/README.md`.

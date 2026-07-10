# Extension Workspaces Sidebar Design

**Date:** 2026-07-10  
**Status:** Approved for implementation (Option A)  
**Scope:** Lattice dashboard navigation, reversible native-page plugin enhancement, and production activation of NetGuard/WireGuard

## 1. Problem

The current sidebar mixes first-party console destinations and plugin-contributed destinations in one long accordion. It repeats plugin ownership at three levels (extension band, plugin package, destination), auto-inserts recent routes as pseudo-shortcuts, opens every section by default, and makes active plugins look like permanently bundled product features. This creates visual noise and weakens the most important plugin invariant:

> Installing a plugin may enhance Lattice; disabling or uninstalling it must restore the exact base-console experience without broken routes, errors, network calls, or visual residue.

NetGuard and WireGuard are additionally only in the `verified` lifecycle state, so their valid signed bundles are not yet exposed through active contribution discovery.

## 2. Goals

1. Separate first-party and plugin navigation into two explicit workspaces: **Console** and **Extensions**.
2. Flatten extension navigation around user tasks, not implementation package IDs.
3. Hide the Extensions workspace completely when no authorized active plugin contributes navigation.
4. Keep authorization fail-closed at both server and dashboard boundaries.
5. Make native-page augmentation strictly reversible. An inactive or absent plugin produces no plugin control, filter, data request, error, or stale visual state.
6. Preserve desktop, collapsed-rail, and mobile-drawer usability and keyboard/accessibility semantics.
7. Use existing mature primitives (`reka-ui` through the project Tabs/Tooltip/Button components) and add no dependency.
8. Deploy the result through the alpha image train, then promote NetGuard and WireGuard through valid lifecycle transitions.

## 3. Non-goals for this slice

- Executing a NetGuard nftables plan or applying a WireGuard configuration to any node.
- Allowing plugins to ship arbitrary JavaScript/Vue code into native pages.
- Implementing the complete generic native-slot augmentation manifest and server protocol. Its contract is specified below, but this slice only hardens the existing VPN Map enhancement so it obeys that contract behaviorally.
- Changing the node-agent, SDK contract, or stable release channel.

## 4. Information architecture

### 4.1 Workspace switch

A controlled two-value Tabs control sits directly below Search:

- **Console** — static `NAV` destinations filtered by operator scopes.
- **Extensions** — active, allow-listed, scope-authorized plugin navigation contributions.

Rules:

- A native route selects Console automatically.
- A `/plugins/:pluginId/:route` route selects Extensions automatically.
- Manual switching changes only the visible navigation workspace; it does not navigate unexpectedly.
- When there are zero authorized active extension destinations, the Extensions tab is not rendered. Console becomes the only visible workspace and gains no empty plugin chrome.
- On a direct plugin URL, Extensions remains visible even if the contribution disappeared so the existing unavailable-state page can explain the condition and the user can return to Console.

### 4.2 Console workspace

- Contains only first-party `NAV` sections and items.
- Plugin items are never appended to Networking, Platform, or any other native section.
- The one-item Overview section renders as a direct destination rather than a redundant `Overview → Overview` accordion.
- Multi-item sections use compact single-open accordion behavior. The section owning the current route is always open; opening another section closes the previous one.
- Only explicitly pinned destinations appear in the sidebar. Automatically tracked recents remain a command-palette concern and are removed from sidebar rendering.
- The lifecycle management destination (`Platform → Plugins`) remains native because it manages the extension platform rather than being an extension feature.

### 4.3 Extensions workspace

Contributions are grouped by the manifest's safe `section` and `section_title`, then flattened across plugin packages:

```text
Extensions
  VPN Manage
    Lines
    Users
    Node Profiles
    Subscriptions
    Usage
    Sub-Store

  Network Plugins
    NetGuard
    WireGuard
```

The sidebar does **not** render package names such as `vpn-core (sing-box)` or `Sub-Store companion`, package-level accordions, per-item “Plugin” pills, or duplicate item counts. A single Extensions workspace identity is sufficient. Plugin identity and version remain available on the lifecycle page and destination page where they are operationally relevant.

Extension section ordering is deterministic by first contribution order; item ordering follows signed manifest order. This avoids locale-dependent resorting that could rearrange intentional workflows.

### 4.4 Collapsed desktop rail

- Console and Extensions are represented by icon buttons with zero-delay tooltips.
- The active workspace has a clear selected state.
- Only destinations from the selected workspace render as icons.
- Section headings are omitted, but tooltip labels include the destination and owning section for context.

### 4.5 Mobile drawer

- Uses the same workspace model and permissions as desktop.
- Route navigation closes the drawer.
- The active route selects the correct workspace before the drawer is shown.
- Touch targets stay at least 36px high and the existing scrim/focus behavior remains intact.

## 5. Navigation data model

Pure helpers shape data before Vue renders it:

- `buildExtensionSections(entries)` validates the already-filtered contribution list into user-facing section groups without plugin-package nesting.
- `workspaceForRoute(path)` maps plugin paths to Extensions and all other paths to Console.
- `extensionWorkspaceVisible(entryCount, routePath)` hides empty plugin chrome while preserving direct-route recovery.
- `availableMapCapabilities(baseCaps, pluginState)` excludes plugin-only capabilities unless the owning plugin is active.

These helpers are covered with Node's built-in test runner and TypeScript stripping, avoiding a new test dependency.

## 6. Permission and trust boundaries

1. **Server authoritative gate:** `/api/plugin-contributions` returns only active plugins and server-accepted declarative contributions.
2. **Dashboard defensive gate:** `usePluginContributions` retains section/icon/route allow-lists and requires `auth.canAll(entry.scopes)`.
3. **No arbitrary code:** manifests contribute data; the dashboard owns every render primitive and native augmentation adapter.
4. **Direct-route safety:** the plugin view resolver rechecks active plugin/view presence. A stale bookmark cannot resurrect an inactive plugin.
5. **Lifecycle safety:** promotion is `verified → installed → active`; activation does not apply host firewall or WireGuard state.
6. **Host-risk safety:** signed publisher verification remains mandatory. The production unsigned-host-risk bypass stays disabled.

## 7. Reversible native-page augmentation

### 7.1 Immediate Map contract

The existing VPN Lines enhancement on the native Map is retained only behind an active `latticenet.vpn-core` contribution:

- The VPN layer toggle is absent when the plugin is inactive/uninstalled.
- The `vpn-lines` quick filter is absent when the plugin is inactive/uninstalled.
- VPN expression tokens never trigger plugin RPC when the plugin is inactive/uninstalled.
- If the plugin becomes unavailable while the Map is open, plugin layer/filter state is cleared and the base map continues normally.
- No error toast is emitted merely because an optional plugin disappeared.

This is the reference behavior for future augmentation slots.

### 7.2 Future generic augmentation protocol

The eventual manifest contract should be declarative, allow-listed, signed, and slot-based, for example:

```json
{
  "ui": {
    "augmentations": [
      {
        "slot": "fleet.map.layers",
        "adapter": "vpn-lines-overlay",
        "scopes": ["node:read"],
        "config": { "service": "latticenet.vpn-core/lines", "method": "list" }
      }
    ]
  }
}
```

Required constraints before implementation:

- Server allow-list of slot IDs and adapter IDs.
- Ownership map tying each built-in adapter to the permitted plugin ID/publisher.
- Scope intersection and active-lifecycle filtering before delivery.
- Fixed dashboard adapter registry; no remote component URLs, `eval`, runtime templates, or plugin-supplied script.
- Every slot renders its native fallback first and treats contribution absence/failure as a no-op.
- Uninstall/disable invalidates cached contributions and disposes requests, watchers, overlays, commands, and persisted plugin-specific UI state.
- Contract tests prove install, active render, deactivation, uninstall, stale route, and insufficient-scope behavior.

The generic protocol is intentionally deferred from this release because adding the schema requires coordinated server, dashboard, SDK, plugin-manifest, signing, and compatibility work. No native page may gain another hard-coded plugin enhancement without satisfying the reversible behavior above.

## 8. Failure behavior

| Condition | Required behavior |
| --- | --- |
| Contribution request fails before first load | Console works normally; Extensions stays hidden unless current route is plugin-owned. |
| Registry refresh fails after a good load | Preserve last-good contribution model; do not destroy an active operator workflow. |
| Plugin becomes inactive | Its sidebar routes disappear; any native augmentation disposes itself; base UI remains. |
| User lacks all scopes for a plugin section | Section and workspace count exclude those entries; no unauthorized route is advertised. |
| User opens stale plugin URL | Existing unavailable state renders; no native section is polluted. |
| Plugin RPC fails while active | Plugin surface reports the error locally; base native surface remains usable. |

## 9. Visual direction

- Use neutral sidebar tokens for both workspaces; distinguish Extensions structurally, not with repeated badges or loud card chrome.
- The Tabs switch is the single high-salience boundary.
- Section labels are quiet uppercase metadata; active destinations carry the existing primary accent bar.
- Keep one level of hierarchy visible at a time and avoid nested borders within borders.
- Preserve the existing Lattice brand lockup, search trigger, and collapse action.

## 10. Acceptance criteria

1. No sidebar path renders plugin contributions inside Console.
2. Extensions contains flat `VPN Manage` and `Network Plugins` task groups with no package layer or per-row Plugin badge.
3. With zero active authorized plugin contributions, the base sidebar has no Extensions switch or plugin styling.
4. Recents no longer duplicate canonical sidebar destinations; only explicit pins render.
5. Native sections are not all expanded and the current route is never hidden.
6. VPN Map plugin controls, filters, requests, and stale state disappear when vpn-core is inactive.
7. Type-check, production build, navigation unit tests, and browser smoke tests pass.
8. Production reports matching server/dashboard `alpha-0.2.1a29` provenance.
9. NetGuard and WireGuard report `active` and contribute their routes after valid lifecycle transitions.
10. Real Chrome verification confirms desktop, collapsed, mobile, direct plugin route, console return path, and no console errors.


# Extension Workspaces Sidebar Implementation Plan

> **For Codex:** Execute task-by-task with test-first changes and verification after each dependent slice.

**Goal:** Replace the mixed, deeply nested sidebar with a reversible Console/Extensions workspace model, harden the Map's optional VPN enhancement, deploy server/dashboard alpha a29, and activate NetGuard/WireGuard safely.

**Architecture:** Keep the server's active-only declarative contribution endpoint as the source of truth. Add small pure dashboard navigation helpers, render them through existing Reka Tabs and sidebar primitives, and keep native-page plugin integration behind active-plugin gates. Do not add dependencies or generic remote UI execution.

**Tech stack:** Vue 3, TypeScript, Pinia, Vue Router, Tailwind tokens, Reka UI, Node built-in test runner, Playwright/real Chrome for E2E.

---

## Task 1: Lock navigation shaping behavior

**Files:**
- Create: `src/layout/navigationModel.test.ts`
- Create: `src/layout/navigationModel.ts`
- Modify: `package.json`

- [ ] Write failing tests for route-to-workspace selection, hidden empty Extensions, direct plugin-route recovery, section flattening across multiple plugin IDs, deterministic ordering, and plugin-only Map capability gating.
- [ ] Run `node --experimental-strip-types --test src/layout/navigationModel.test.ts` and capture the expected module/test failure.
- [ ] Implement only the pure types/helpers required by those tests.
- [ ] Add a `test:navigation` package script and rerun to green.

## Task 2: Replace mixed sidebar rendering

**Files:**
- Modify: `src/layout/components/AppSidebar.vue`
- Modify: `src/layout/components/SidebarItem.vue`
- Modify: `src/layout/components/SidebarShortcut.vue` only if copy/semantics require it
- Modify: `src/stores/navShortcuts.ts`
- Modify: `src/i18n/locales/en/frame.ts`
- Modify: `src/i18n/locales/zh-CN/frame.ts`

- [ ] Remove plugin package grouping, dynamic insertion into native sections, repeated Plugin badges, and sidebar auto-recents.
- [ ] Build permission-filtered native sections and flattened extension sections through `navigationModel.ts`.
- [ ] Add the controlled Console/Extensions switch using existing `Tabs`, `TabsList`, and `TabsTrigger` components.
- [ ] Auto-select workspace from the current route; keep direct stale-plugin routes recoverable.
- [ ] Render Overview directly and use one-open accordion semantics for remaining sections.
- [ ] Render explicitly pinned entries only, scoped to destinations still present and authorized.
- [ ] Implement collapsed-rail icons/tooltips and preserve mobile close-on-navigation behavior.
- [ ] Add English and Simplified Chinese labels for workspaces, pinned navigation, empty/recovery copy, and accessible controls.

## Task 3: Make native Map enhancement strictly reversible

**Files:**
- Modify: `src/views/fleet/MapView.vue`
- Extend: `src/layout/navigationModel.test.ts`
- Extend: `src/layout/navigationModel.ts`

- [ ] Exclude `vpn-lines` from available filters unless vpn-core is active.
- [ ] Prevent VPN-token expressions from triggering plugin RPC unless vpn-core is active.
- [ ] Watch plugin availability and clear VPN layer/quick-filter state on deactivation without errors.
- [ ] Ensure base node filtering and map rendering continue when the optional plugin is absent.
- [ ] Rerun navigation/model tests.

## Task 4: Static and component verification

**Files:**
- Review all modified dashboard files

- [ ] Run `pnpm test:navigation`.
- [ ] Run `pnpm type-check`.
- [ ] Run `pnpm build`.
- [ ] Search for obsolete plugin-band/package-group rendering and unused recents/collapse code.
- [ ] Review keyboard focus, `aria-selected`/Tabs semantics, tooltip labels, and 36px touch targets.

## Task 5: Local browser and visual QA

**Files:**
- Update or create local smoke harness under the existing ignored `.omc/` test area if needed
- Write verdict: `.omx/state/sidebar/ralph-progress.json`

- [ ] Launch the production build/fixture with active VPN, Sub-Store, NetGuard, and WireGuard contributions.
- [ ] Capture expanded Console, expanded Extensions, collapsed rail, and mobile drawer screenshots.
- [ ] Verify route/workspace synchronization, flattening, pins-only behavior, active section visibility, direct routes, and no browser console errors.
- [ ] Run visual-verdict against the prior crowded production baseline and the approved design criteria; iterate until the verdict is at least 90/100 with no blocker.
- [ ] Run a zero-plugin fixture and verify the Extensions switch and all plugin residues disappear.

## Task 6: Commit and publish dashboard

**Files:**
- Commit all reviewed dashboard changes on `main`

- [ ] Confirm only intended files changed.
- [ ] Commit with Lore trailers including tests, scope risk, and the reversible-plugin directive.
- [ ] Push dashboard `main` and record the immutable commit SHA.

## Task 7: Build and deploy server alpha a29

**Files (expected after repository inspection):**
- Modify: `../lattice-server/dashboard.ref`
- Modify alpha version/provenance files used by the a28 release

- [ ] Pin `dashboard.ref` to the new dashboard commit.
- [ ] Increment only the alpha train suffix from `alpha-0.2.1a28` to `alpha-0.2.1a29`.
- [ ] Run server Go tests/build and image verification using repository-native commands.
- [ ] Commit/push server changes with Lore trailers.
- [ ] Build/publish/deploy a29 through the existing production procedure.
- [ ] Verify health and version endpoints report the expected server commit, dashboard ref, and alpha tag.

## Task 8: Activate and verify NetGuard/WireGuard

**Production actions:**
- Signed NetGuard `v0.1.0-alpha.5`
- Signed WireGuard `v0.1.0-alpha.5`

- [ ] Confirm both bundles are still verified and their digest/signature metadata matches the deployed artifacts.
- [ ] Promote each through `verified → installed → active`; do not invoke host apply/call.
- [ ] Confirm `/api/plugins/lifecycle` reports both active.
- [ ] Confirm `/api/plugin-contributions` includes NetGuard and WireGuard only for authorized operators.
- [ ] Confirm loader logs have zero rejects and unsigned host-risk remains disabled.

## Task 9: Real Chrome production acceptance

- [ ] Use the user's local authenticated Chrome session at `https://lattice.roobli.org`.
- [ ] Verify Console has no plugin destinations and Extensions is visually distinct and flat.
- [ ] Open NetGuard and WireGuard routes and verify their first-class configuration surfaces render.
- [ ] Verify VPN Manage remains flat across vpn-core and Sub-Store packages.
- [ ] Verify collapsed desktop and mobile navigation.
- [ ] Verify no console errors or failed contribution requests.
- [ ] Capture final screenshots and production evidence.
- [ ] Report tag, server commit, dashboard ref, SDK pin status, node-agent channel status, plugin versions/lifecycle, verification commands, changed files, simplifications, and residual risks.


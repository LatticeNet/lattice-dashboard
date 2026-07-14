# Extension Plugin Groups Design

**Date:** 2026-07-13  
**Status:** Approved by the user's explicit grouping request  
**Scope:** Extensions workspace navigation only

## Problem

The Extensions workspace currently groups destinations by a manifest task section. Because several plugins intentionally use the same section, their tabs are flattened into one list. That makes workflows compact, but it hides package ownership and makes it difficult to tell which installed plugin provides a capability.

This requirement supersedes section 4.3 of the 2026-07-10 extension workspace design.

## Design

1. The first visible grouping boundary under Extensions is the active plugin identity, keyed by `pluginId`.
2. Each group header shows the plugin's display name and stable plugin ID. A small count communicates how many authorized destinations that plugin contributes.
3. A group's destinations retain their signed manifest order. Manifest task sections do not merge destinations across plugins.
4. Groups expand independently. The group owning the current route remains open, while operators may keep sibling plugins open.
5. The collapsed rail omits group headers but includes the plugin name in each destination tooltip.
6. Explicitly pinned destinations remain a separate operator-owned shortcut area; each shortcut's context is the plugin name. Canonical destinations remain grouped below it.
7. Grouping is generic. The dashboard contains no IDs, names, versions, or layout branches for VPN Core, Sub-Store, NetGuard, WireGuard, or any future plugin.

## Lifecycle And Permission Behavior

- Only active plugins with at least one scope-authorized navigation contribution produce a group.
- Disabling or uninstalling a plugin removes its group and any unresolved pinned shortcut without leaving a placeholder.
- A stale direct plugin route retains the existing unavailable-state behavior and does not synthesize a fake group.
- A contribution refresh failure retains the existing last-good cache behavior.

## Visual Direction

- Use a compact disclosure row, not a card, for each plugin.
- Use the existing sidebar tokens and one quiet package icon; avoid repeated `Plugin` pills.
- Indent contributed destinations under a subtle vertical rule so ownership remains legible while scanning.
- Keep touch targets at least 36px on mobile and compact them to the existing 28px desktop density.

## Acceptance Criteria

1. VPN Core, Sub-Store, NetGuard, and WireGuard render as distinct plugin groups even when their manifest sections match.
2. Every contributed destination appears under exactly one owning plugin.
3. Item and plugin order follow first-seen contribution order.
4. Independent expansion, active-route ownership, pins, collapsed rail, and mobile drawer continue to work.
5. Removing all plugin contributions removes the Extensions workspace without affecting Console.
6. Navigation tests, type-check, production build, browser smoke, desktop/mobile screenshots, and visual verdict pass.

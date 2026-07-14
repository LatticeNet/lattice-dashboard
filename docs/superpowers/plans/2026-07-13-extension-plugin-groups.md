# Extension Plugin Groups Implementation Plan

**Goal:** Make plugin ownership the canonical grouping boundary in the Extensions sidebar.

## 1. Lock The Navigation Model

- Replace section-group expectations with plugin-group expectations.
- Cover same-section/different-plugin isolation, same-plugin/multiple-section aggregation, fallback labels, ordering, and uninstall reconciliation.

## 2. Render Plugin Groups

- Include `pluginName` in extension sidebar entries.
- Build groups by `pluginId`.
- Render compact plugin identity disclosure rows with name, ID, destination count, and indented destinations.
- Keep route-owner and independent expansion behavior.
- Keep generic collapsed and mobile behavior.

## 3. Verify

- Run navigation tests, type-check, and production build.
- Extend the browser smoke fixture to include Sub-Store and assert four distinct groups.
- Capture desktop/mobile screenshots and run the visual verdict loop.
- Verify the zero-plugin state has no Extensions residue.

## 4. Publish

- Commit and tag the dashboard with the next alpha patch.
- Pin the dashboard commit in the next server alpha image.
- Build, deploy, and verify production provenance and plugin navigation.

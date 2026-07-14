import assert from "node:assert/strict";
import test from "node:test";

import {
  SIDEBAR_COLLAPSED_WIDTH,
  SIDEBAR_DESKTOP_DEFAULT_WIDTH,
  SIDEBAR_DESKTOP_MAX_WIDTH,
  SIDEBAR_DESKTOP_MIN_WIDTH,
  SIDEBAR_KEYBOARD_STEP,
  SIDEBAR_MOBILE_WIDTH,
  clampSidebarDesktopWidth,
  nudgeSidebarDesktopWidth,
  pluginGroupAriaLabel,
  resizeSidebarDesktopWidth,
} from "../sidebarModel.ts";

test("sidebar width constants preserve the fixed collapsed and mobile rails", () => {
  assert.equal(SIDEBAR_COLLAPSED_WIDTH, 64);
  assert.equal(SIDEBAR_MOBILE_WIDTH, 240);
  assert.equal(SIDEBAR_DESKTOP_DEFAULT_WIDTH, 240);
  assert.equal(SIDEBAR_DESKTOP_MIN_WIDTH, 224);
  assert.equal(SIDEBAR_DESKTOP_MAX_WIDTH, 360);
});

test("desktop sidebar widths clamp to the supported range", () => {
  assert.equal(clampSidebarDesktopWidth(0), SIDEBAR_DESKTOP_MIN_WIDTH);
  assert.equal(clampSidebarDesktopWidth(223.2), SIDEBAR_DESKTOP_MIN_WIDTH);
  assert.equal(clampSidebarDesktopWidth(240), 240);
  assert.equal(clampSidebarDesktopWidth(999), SIDEBAR_DESKTOP_MAX_WIDTH);
  assert.equal(clampSidebarDesktopWidth(Number.NaN), SIDEBAR_DESKTOP_DEFAULT_WIDTH);
});

test("desktop sidebar drag and keyboard resizing honor clamps and reset targets", () => {
  assert.equal(resizeSidebarDesktopWidth(240, 44), 284);
  assert.equal(resizeSidebarDesktopWidth(240, -99), SIDEBAR_DESKTOP_MIN_WIDTH);
  assert.equal(resizeSidebarDesktopWidth(340, 40), SIDEBAR_DESKTOP_MAX_WIDTH);

  assert.equal(
    nudgeSidebarDesktopWidth(240, "ArrowLeft"),
    240 - SIDEBAR_KEYBOARD_STEP,
  );
  assert.equal(
    nudgeSidebarDesktopWidth(240, "ArrowRight"),
    240 + SIDEBAR_KEYBOARD_STEP,
  );
  assert.equal(
    nudgeSidebarDesktopWidth(240, "Home"),
    SIDEBAR_DESKTOP_MIN_WIDTH,
  );
  assert.equal(
    nudgeSidebarDesktopWidth(240, "End"),
    SIDEBAR_DESKTOP_MAX_WIDTH,
  );
  assert.equal(nudgeSidebarDesktopWidth(240, "PageDown"), 240);
});

test("plugin group aria labels include the full display name and plugin id", () => {
  assert.equal(
    pluginGroupAriaLabel("NetGuard Firewall Controls", "latticenet.netguard"),
    "NetGuard Firewall Controls (latticenet.netguard)",
  );
});

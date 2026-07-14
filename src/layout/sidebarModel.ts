export const SIDEBAR_COLLAPSED_WIDTH = 64;
export const SIDEBAR_MOBILE_WIDTH = 240;
export const SIDEBAR_DESKTOP_MIN_WIDTH = 224;
export const SIDEBAR_DESKTOP_DEFAULT_WIDTH = 240;
export const SIDEBAR_DESKTOP_MAX_WIDTH = 360;
export const SIDEBAR_KEYBOARD_STEP = 16;

export function clampSidebarDesktopWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_DESKTOP_DEFAULT_WIDTH;
  return Math.min(
    SIDEBAR_DESKTOP_MAX_WIDTH,
    Math.max(SIDEBAR_DESKTOP_MIN_WIDTH, Math.round(width)),
  );
}

export function resizeSidebarDesktopWidth(startWidth: number, deltaX: number): number {
  return clampSidebarDesktopWidth(startWidth + deltaX);
}

export function nudgeSidebarDesktopWidth(currentWidth: number, key: string): number {
  switch (key) {
    case "ArrowLeft":
      return clampSidebarDesktopWidth(currentWidth - SIDEBAR_KEYBOARD_STEP);
    case "ArrowRight":
      return clampSidebarDesktopWidth(currentWidth + SIDEBAR_KEYBOARD_STEP);
    case "Home":
      return SIDEBAR_DESKTOP_MIN_WIDTH;
    case "End":
      return SIDEBAR_DESKTOP_MAX_WIDTH;
    default:
      return clampSidebarDesktopWidth(currentWidth);
  }
}

export function pluginGroupAriaLabel(displayName: string, pluginId: string): string {
  const normalizedId = pluginId.trim();
  const normalizedName = displayName.trim() || normalizedId;
  if (!normalizedId || normalizedName === normalizedId) return normalizedName;
  return `${normalizedName} (${normalizedId})`;
}

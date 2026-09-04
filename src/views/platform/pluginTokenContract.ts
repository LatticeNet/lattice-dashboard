/**
 * Token contract v2: the custom properties the console publishes to every
 * plugin frame.
 *
 * Until now the frame received eleven colours and nothing else, so each plugin
 * re-derived its own radius scale, spacing scale, type sizes, status colours,
 * shadows and motion. Four plugins ended up with four namespaces and three
 * radius systems, none of them the console's, which is why the Sub-Store lens
 * reads harder-edged than vpn-core and NetGuard beside it. The fix is to send
 * the whole chassis rather than its palette.
 *
 * The names are the host's own, not a namespaced copy. `applyTheme` in
 * `@latticenet/plugin-bridge` writes them as inline custom properties on the
 * plugin's `<html>`, and an inline property beats the plugin's own `:root`
 * declaration. So a plugin declares the same names locally as fallbacks (for
 * its dev harness and for an older host) and the console's values win the
 * moment the plugin ships on a bridge that carries them.
 *
 * Widening the list widens nothing else: the bridge allowlists by name and
 * writes values through `style.setProperty`, which cannot execute or load
 * anything.
 *
 * Every name here must be declared in a plain `:root` or `.dark` rule of
 * `src/style/app.css`. A name declared only inside `@theme inline` is baked
 * into the utilities Tailwind generates and may never reach the compiled
 * `:root`, in which case `getComputedStyle` reads it as an empty string and
 * the plugin silently falls back. `__tests__/pluginTokenContract.test.ts` is
 * the guard.
 */
export const PLUGIN_TOKEN_NAMES = [
  // Surfaces and ink.
  "--background",
  "--foreground",
  "--card",
  "--card-foreground",
  "--muted",
  "--muted-foreground",
  "--accent",
  "--accent-foreground",
  "--border",
  "--primary",
  "--primary-foreground",
  "--destructive",
  "--destructive-foreground",
  "--ring",

  // Status semantics. A control plane is status-heavy and these carry meaning;
  // without them plugins hardcode a green and an amber that are right in one
  // theme only.
  "--success",
  "--success-foreground",
  "--warning",
  "--warning-foreground",
  "--info",
  "--info-foreground",

  // The same three as ink. The fills are pair colours: something sits on them.
  // Written as text on the page instead, the light-scheme amber measures
  // 2.5:1 and the green 3.4:1, so a frame that used --warning for a status
  // label shipped an unreadable label. These carry the readable step, and in
  // dark they are the fill, so a plugin rule written once works in both.
  "--success-text",
  "--warning-text",
  "--info-text",

  // Corner radius. Four steps and the shadcn alias; the step decides whether a
  // dense grid reads as an operator tool.
  "--radius-sm",
  "--radius-md",
  "--radius-lg",
  "--radius-xl",
  "--radius",

  // Row rhythm, one number per density.
  "--row-h",
  "--row-h-compact",

  // Spacing scale. Published so every plugin lays out on the same steps.
  "--space-1",
  "--space-2",
  "--space-3",
  "--space-4",
  "--space-5",
  "--space-6",
  "--space-7",

  // Type. The sans stack is inherited through the cascade; mono and the two
  // sizes are not, so they are sent.
  "--font-mono",
  "--text-body",
  "--text-mono",

  // Elevation: the two surfaces that genuinely float.
  "--shadow-overlay",
  "--shadow-raised",

  // Motion: two durations and one curve for the whole product.
  "--duration-fast",
  "--duration-base",
  "--ease-out",
] as const;

export type PluginTokenName = (typeof PLUGIN_TOKEN_NAMES)[number];

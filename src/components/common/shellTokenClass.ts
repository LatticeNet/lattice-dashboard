import type { ShellTokenKind } from "@/lib/shellTokens";

/**
 * One colour per token kind for ScriptView and ShellText, every one an
 * existing token: the accent for reserved words, the -text steps (measured
 * for 12px text on both themes, app.css) for builtins, strings and
 * expansions, the muted ink for comments and operators. Numbers mix the
 * danger hue toward the ink so they read as a value, not an alarm.
 */
export const SHELL_TOKEN_CLASS: Record<ShellTokenKind, string | undefined> = {
  plain: undefined,
  comment: "text-muted-foreground italic",
  string: "text-success-text",
  heredoc: "text-success-text",
  variable: "text-warning-text",
  keyword: "text-primary font-semibold",
  builtin: "text-info-text",
  operator: "text-muted-foreground",
  number: "text-[color-mix(in_oklab,var(--destructive)_72%,var(--foreground))]",
};

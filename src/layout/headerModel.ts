export interface PluginBreadcrumbInput {
  pluginId: string;
  pluginDisplayName?: string | null | undefined;
  viewTitle?: string | null | undefined;
  viewRoute?: string | null | undefined;
}

function normalizedLabel(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function resolvePluginBreadcrumb(input: PluginBreadcrumbInput) {
  const sectionLabel = normalizedLabel(input.pluginDisplayName) ?? input.pluginId;
  return {
    sectionLabel,
    title: normalizedLabel(input.viewTitle) ?? normalizedLabel(input.viewRoute) ?? sectionLabel,
  };
}

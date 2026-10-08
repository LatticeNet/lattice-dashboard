/**
 * Groups' query fields (src/lib/query) over the group list. The rows are
 * groups, so the nodes are a field: `node:` matches the names of a group's
 * members, the ones a selector resolves included.
 *
 *   node:hetzner offline>0 sort:-members
 *
 * Pure, like the sibling models: no Vue, no i18n.
 */
import type { GroupView } from "@/lib/api/types";
import type { QueryField, QuerySchema } from "@/lib/query/engine";

/** Queries the help offers on this page; each key names the sentence that says what it finds. */
export const GROUPS_QUERY_EXAMPLES = [
  { key: "down", query: "offline>0 sort:-offline" },
  { key: "node", query: "node:hetzner" },
  { key: "dynamic", query: "is:dynamic sort:-members" },
  { key: "empty", query: "members:0" },
] as const;

const hint = (key: string) => `fleet.groups.query.fields.${key}`;

export interface GroupsQueryOptions {
  nodeName: (id: string) => string;
}

function health(group: GroupView): number | undefined {
  const { total, online } = group.rollup;
  return total ? Math.round((online / total) * 100) : undefined;
}

export function groupsQuerySchema(options: GroupsQueryOptions): QuerySchema<GroupView> {
  const members = (g: GroupView) => g.resolved_members.map((id) => options.nodeName(id));
  const fields: QueryField<GroupView>[] = [
    { key: "name", type: "string", hint: hint("name"), get: (g) => g.name, suggest: (rows) => rows.map((g) => g.name), sort: (g) => g.name.toLowerCase() },
    { key: "slug", type: "string", hint: hint("slug"), get: (g) => g.slug },
    { key: "description", aliases: ["desc"], type: "string", hint: hint("description"), get: (g) => g.description },
    { key: "node", aliases: ["nodes", "member"], type: "list", hint: hint("node"), get: members, suggest: (rows) => rows.flatMap(members), sort: false },
    { key: "members", type: "number", hint: hint("members"), get: (g) => g.rollup.total },
    { key: "online", type: "number", hint: hint("online"), get: (g) => g.rollup.online },
    { key: "offline", type: "number", hint: hint("offline"), get: (g) => g.rollup.offline },
    { key: "disabled", type: "number", hint: hint("disabled"), get: (g) => g.rollup.disabled },
    { key: "health", type: "number", unit: "percent", hint: hint("health"), get: health },
    { key: "leader", type: "string", hint: hint("leader"), get: (g) => (g.leader_id ? options.nodeName(g.leader_id) : undefined) },
    {
      key: "tag",
      aliases: ["tags"],
      type: "list",
      hint: hint("tag"),
      get: (g) => [...(g.selector?.match_tags_any ?? []), ...(g.selector?.match_roles ?? [])],
      sort: false,
    },
    {
      key: "dynamic",
      aliases: ["selector"],
      type: "bool",
      flag: true,
      hint: hint("dynamic"),
      get: (g) => !!g.selector && Object.values(g.selector).some((list) => Array.isArray(list) && list.length > 0),
      sort: false,
    },
    { key: "system", type: "bool", flag: true, hint: hint("system"), get: (g) => !!g.system, sort: false },
    { key: "down", type: "bool", flag: true, hint: hint("down"), get: (g) => g.rollup.offline > 0, sort: false },
  ];
  return { fields, text: (g) => [g.name, g.slug, g.description] };
}

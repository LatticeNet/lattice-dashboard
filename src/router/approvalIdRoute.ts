import type { RouteRecordRaw } from "vue-router";

import { approvalDeepLinkId } from "@/views/operations/approvalsListModel";

/**
 * /approvals/:id is a Bark click URL. NAV cannot express params, so this sits
 * with the other manual child routes and rewrites onto ?selected=, which is
 * how the Approvals page already opens a row.
 */
export const approvalIdRoute: RouteRecordRaw = {
  path: "approvals/:id",
  redirect: (to) => {
    const selected = approvalDeepLinkId(to.query.selected, to.params.id);
    return selected
      ? { path: "/approvals", query: { ...to.query, selected } }
      : { path: "/approvals", query: to.query };
  },
};

/**
 * The one sentence that names an agent.mirrors plan, shared by the pending
 * rows on Agent updates, the plan dialog there and the approval review, so
 * every place calls a change the same thing: "Disable mirror sg-backup
 * (Singapore backup)", "Change mirror r2 (Cloudflare R2): Priority".
 */
import type { AgentMirrorPlan } from "@/lib/api/types";

import { planHeadline } from "./agentMirrorsModel";

type Translate = (key: string, named: Record<string, unknown>) => string;

const K = "platform.agentUpdatesPage.mirrors";

export function mirrorPlanSentence(t: Translate, plan: AgentMirrorPlan): string {
  const name = plan.mirror.name || plan.previous?.name;
  const subject = name ? t(`${K}.plan.subjectNamed`, { id: plan.mirror.id, name }) : t(`${K}.plan.subject`, { id: plan.mirror.id });
  const headline = planHeadline(plan);
  if (headline.kind !== "change") return t(`${K}.plan.headline.${headline.kind}`, { subject });
  const fields = headline.fields.map((field) => t(`${K}.fields.${field}`, {})).join(t(`${K}.plan.fieldSeparator`, {}));
  return t(`${K}.plan.headline.change`, { subject, fields });
}

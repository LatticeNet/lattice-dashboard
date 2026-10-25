/**
 * The client networks a CoreDNS deployment answers (design 32 S5b).
 *
 * The server renders them as the acl plugin in every server block, one allow
 * per network and then a block, so a client outside them gets REFUSED. That
 * is what lets a public deployment with a forward zone exist without being an
 * open resolver. It limits who gets answers, not who reaches the port: the
 * firewall still decides that.
 *
 * The server is the one judge of a network (CIDR notation, no host bits, not
 * every address, at most 64) and names the entry it refuses, so the editor
 * only turns the text into a list and says whether the draft would be the
 * open resolver the server refuses.
 */

/** The networks as typed: one per line, or separated by commas or spaces. */
export function parseAllowedClients(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** The text the field opens with: one network per line. */
export function allowedClientsText(clients: readonly string[] | undefined): string {
  return (clients ?? []).join("\n");
}

export interface ResolverDraft {
  exposure: string;
  zoneModes: readonly string[];
  allowedClients: readonly string[];
}

/**
 * Whether the draft would recurse for anyone who reaches it: public exposure,
 * a forward zone, and no allowed clients. The server refuses it on save and
 * plan, so the form says so before submit.
 */
export function isOpenResolverDraft(draft: ResolverDraft): boolean {
  return draft.exposure === "public" && draft.zoneModes.includes("forward") && draft.allowedClients.length === 0;
}

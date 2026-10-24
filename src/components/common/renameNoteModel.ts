/**
 * The note a renamed page shows on its first visit after the rename (design
 * 32 D3, Risks: "renaming pages moves the operator's habits"). It names the
 * old page next to the new one, once per viewer: the first render marks it
 * seen, and dismissing it hides it at once. Seen is remembered per signed-in
 * operator in this browser, the way the plane guides remember theirs.
 *
 * Pure TS, so `node --test` covers it directly.
 */

/** The pages design 32 renamed, by note id. The text lives in `renames.<id>`. */
export const RENAMED_PAGES = ["outboundPolicy", "nodeGroups", "inboundFirewall", "wireguardMesh"] as const;
export type RenamedPage = (typeof RENAMED_PAGES)[number];

/** The note for an official plugin page the console renamed, by `<plugin id>/<route>`. */
export const RENAMED_PLUGIN_PAGES: Readonly<Record<string, RenamedPage>> = {
  "latticenet.netguard/firewall": "inboundFirewall",
  "latticenet.wireguard/networks": "wireguardMesh",
};

export interface NoteStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function renameNoteKey(owner: string | undefined, id: RenamedPage): string {
  return `lattice.ui.renamed.${owner?.trim() || "anonymous"}.${id}`;
}

/**
 * Whether to show the note now, marking it seen so the next visit does not
 * show it again. Storage that throws (a private window, blocked site data)
 * shows nothing rather than nagging on every visit.
 */
export function takeRenameNote(storage: NoteStorage | null, owner: string | undefined, id: RenamedPage): boolean {
  if (!storage) return false;
  const key = renameNoteKey(owner, id);
  try {
    if (storage.getItem(key)) return false;
    storage.setItem(key, "seen");
    return true;
  } catch {
    return false;
  }
}

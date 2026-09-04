import type { StorageBucketInventoryEntry, StorageTokenView } from "@/lib/api";

/**
 * Who writes into a bucket, and what the console may do with it.
 *
 * Everything the store holds on production today was written by machines:
 * Sub-Store keeps its whole database under plugin:<id>, the server keeps its
 * line identity maps under vpnmeta/, and agent release binaries land in
 * agent-releases. Listing those beside an operator's own bucket with nothing
 * saying who wrote them is what made the page read as "some keys, origin
 * unknown".
 *
 * The rules below mirror the ones the server pins writers with, so the console
 * cannot claim a bucket for an owner the server would not: plugin_host.go pins
 * every plugin write to plugin:<id>, linemeta.go writes vpnmeta/lineuuid and
 * vpnmeta/lineuuid-owner, and server_agent_artifacts.go writes agent-releases.
 * The inventory carries no owner field, so this is a derivation and is named
 * as one.
 */
export type StorageBucketOwner = "operator" | "plugin" | "server" | "agent";

/** The static bucket the agent release upload owns. */
export const AGENT_RELEASES_BUCKET = "agent-releases";

/** The KV prefix the server writes line identity under. */
export const LINE_META_PREFIX = "vpnmeta/";

/** The KV prefix the plugin host pins every plugin write to. */
export const PLUGIN_BUCKET_PREFIX = "plugin:";

type BucketFacts = Pick<StorageBucketInventoryEntry, "name" | "kind"> &
  Partial<Pick<StorageBucketInventoryEntry, "reserved">>;

export function bucketOwner(entry: BucketFacts): StorageBucketOwner {
  // Reserved is the server saying the bucket is its own, and it outranks every
  // name rule below. reservedLineSecretKVBucket() marks vpn-core's KV bucket,
  // managedline/def, vpn_users, vpn_user_secrets and managed_line_secrets, and
  // not one of those carries a plugin: or vpnmeta/ name, so reading the name
  // alone badged the bucket holding VPN user secrets as the operator's own.
  if (entry.reserved) return "server";
  if (entry.name.startsWith(PLUGIN_BUCKET_PREFIX)) return "plugin";
  if (entry.kind === "kv" && entry.name.startsWith(LINE_META_PREFIX)) return "server";
  if (entry.kind === "static" && entry.name === AGENT_RELEASES_BUCKET) return "agent";
  return "operator";
}

/** What the console can read of a storage token, for the writer question. */
export type StorageTokenFacts = Pick<StorageTokenView, "name" | "kind" | "access"> &
  Partial<Pick<StorageTokenView, "buckets" | "revoked_at">>;

/**
 * Whether this token can write this bucket from outside the console.
 *
 * The rule is the server's, from storageTokenAllows(): an admin token passes
 * every access check, a write token passes a write, an empty bucket list means
 * every bucket, and "*" means the same thing spelled out. A revoked token
 * passes nothing.
 */
export function tokenWritesBucket(token: StorageTokenFacts, entry: BucketFacts): boolean {
  if (token.revoked_at) return false;
  if (token.kind !== entry.kind) return false;
  if (token.access !== "write" && token.access !== "admin") return false;
  const scoped = token.buckets ?? [];
  if (scoped.length === 0) return true;
  return scoped.some((bucket) => bucket === "*" || bucket === entry.name);
}

/** Whether any live token can write this bucket from outside the console. */
export function bucketHasTokenWriter(
  entry: BucketFacts,
  tokens: readonly StorageTokenFacts[],
): boolean {
  return tokens.some((token) => tokenWritesBucket(token, entry));
}

/**
 * The names of those tokens, for the note to quote.
 *
 * A token the operator never named still counts as a writer, so the note is
 * decided by bucketHasTokenWriter() and this only decides what it can quote:
 * an unnamed token is left out of the list rather than printed as an empty
 * string, and the sentence stays true with a shorter list.
 */
export function bucketTokenWriterNames(
  entry: BucketFacts,
  tokens: readonly StorageTokenFacts[],
): string[] {
  const names = tokens
    .filter((token) => tokenWritesBucket(token, entry))
    .map((token) => token.name.trim())
    .filter(Boolean);
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

/**
 * Which owner note the card should print, or "" for no note at all.
 *
 * A reserved bucket gets none. The card already states the reserved fact in
 * full (typed private state the server owns, refused to every scope), and the
 * server note underneath it names the line identity map, which is not what
 * vpn_user_secrets holds. One bucket saying two different things about itself
 * is how this page started contradicting itself, so the reserved copy stands
 * alone and the derivation stays quiet.
 *
 * The operator note is the fallback branch, so it is the one asserted about
 * every bucket this console does not recognise rather than about buckets it
 * has evidence for. "Nothing writes here except this console" was therefore a
 * claim it could not make: a KV bucket published through a binding is written
 * by any caller holding a write-scoped storage token (server_storage.go
 * accepts POST and PUT under StorageAccessWrite), and that bucket landed on
 * this same branch. The token list settles it, and the three answers are
 * different sentences:
 *
 * - "operatorToken": a live token can write this bucket, so a machine may.
 * - "operatorConsoleOnly": no live token can, so the console really is the
 *   only writer left once the plugin, server and agent rules have not matched.
 * - "operatorUnknown": the token list needs kv:admin or static:admin and this
 *   operator does not hold it, so the console says it cannot tell.
 *
 * Passing no token list means the console has not read one, which is the
 * unknown case rather than a licence to claim exclusivity.
 */
export type StoreOwnerNote =
  | ""
  | "plugin"
  | "server"
  | "agent"
  | "operatorToken"
  | "operatorConsoleOnly"
  | "operatorUnknown";

export function bucketOwnerNote(
  entry: BucketFacts,
  tokens?: readonly StorageTokenFacts[],
): StoreOwnerNote {
  if (entry.reserved) return "";
  const owner = bucketOwner(entry);
  if (owner !== "operator") return owner;
  if (!tokens) return "operatorUnknown";
  return bucketHasTokenWriter(entry, tokens) ? "operatorToken" : "operatorConsoleOnly";
}

/** The plugin id a plugin-owned bucket belongs to, or "" for every other bucket. */
export function bucketPluginId(entry: BucketFacts): string {
  if (bucketOwner(entry) !== "plugin") return "";
  return entry.name.slice(PLUGIN_BUCKET_PREFIX.length);
}

/**
 * Whether this console may write into the bucket at all.
 *
 * Two of the refusals are the server's and have to be visible here as a
 * disabled control rather than as a 403 toast after the operator typed a
 * value: a reserved bucket is refused outright, and the agent release bucket
 * is refused for writes because deleting or replacing a release is an
 * agent-update decision, not a store edit.
 *
 * The third is this console's own, and it is the one this page was missing.
 * The server will accept a hand write into vpnmeta/*, but that bucket is the
 * line identity map the line chain reads back on every node, the console keeps
 * no history to revert an edit from, and this page now states that the server
 * owns it. Naming the owner and leaving the pencil live is the worst of the
 * two answers, so the machine-owned buckets are read here and changed through
 * the pages that own them.
 *
 * A plugin's bucket stays writable. It is state a plugin keeps for itself, the
 * console is where an operator repairs it, and nothing resolves an identity
 * out of it.
 */
export function bucketWritable(entry: BucketFacts): boolean {
  if (entry.reserved) return false;
  const owner = bucketOwner(entry);
  return owner !== "agent" && owner !== "server";
}

/**
 * Whether the listing carries the objects' bytes.
 *
 * The agent release bucket lists what it holds (path, type, size, time) and
 * strips the content: nodes install those bytes as root and fetch them under a
 * task lease, so the console gets the inventory and not the payload. A preview
 * button over stripped content would show an empty box and read as data loss.
 */
export function bucketContentAvailable(entry: BucketFacts): boolean {
  return bucketOwner(entry) !== "agent";
}

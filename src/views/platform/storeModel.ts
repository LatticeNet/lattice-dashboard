import type { StorageBucketInventoryEntry } from "@/lib/api";

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

/**
 * Which owner note the card should print, or "" for no note at all.
 *
 * A reserved bucket gets none. The card already states the reserved fact in
 * full (typed private state the server owns, refused to every scope), and the
 * server note underneath it names the line identity map, which is not what
 * vpn_user_secrets holds. One bucket saying two different things about itself
 * is how this page started contradicting itself, so the reserved copy stands
 * alone and the derivation stays quiet.
 */
export function bucketOwnerNote(entry: BucketFacts): StorageBucketOwner | "" {
  if (entry.reserved) return "";
  return bucketOwner(entry);
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

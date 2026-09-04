import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AGENT_RELEASES_BUCKET,
  bucketContentAvailable,
  bucketOwner,
  bucketOwnerNote,
  bucketPluginId,
  bucketWritable,
} from "../storeModel.ts";

function bucket(overrides: Record<string, unknown> = {}) {
  return {
    name: "default",
    kind: "kv",
    entries: 0,
    registered: false,
    reserved: false,
    ...overrides,
  } as never;
}

test("who wrote a bucket is derived by the same rules the server pins writers with", () => {
  // plugin_host.go pins every plugin write to plugin:<id>, linemeta.go writes
  // vpnmeta/*, server_agent_artifacts.go writes agent-releases. Anything else
  // is the operator's own, which is what the console can author here.
  assert.equal(bucketOwner(bucket({ name: "plugin:latticenet.sub-store" })), "plugin");
  assert.equal(bucketOwner(bucket({ name: "vpnmeta/lineuuid" })), "server");
  assert.equal(bucketOwner(bucket({ name: "vpnmeta/lineuuid-owner" })), "server");
  assert.equal(bucketOwner(bucket({ kind: "static", name: AGENT_RELEASES_BUCKET })), "agent");
  assert.equal(bucketOwner(bucket({ name: "default" })), "operator");
});

test("the kind is part of the rule, so a name alone cannot claim an owner", () => {
  // vpnmeta/ is a KV prefix and agent-releases is a static bucket. A static
  // bucket that happens to be called vpnmeta/x was written by whoever created
  // it, and claiming the server wrote it would be a wrong answer about who
  // owns the data.
  assert.equal(bucketOwner(bucket({ kind: "static", name: "vpnmeta/lineuuid" })), "operator");
  assert.equal(bucketOwner(bucket({ kind: "kv", name: AGENT_RELEASES_BUCKET })), "operator");
});

test("a plugin bucket names its plugin and nothing else does", () => {
  assert.equal(bucketPluginId(bucket({ name: "plugin:latticenet.sub-store" })), "latticenet.sub-store");
  assert.equal(bucketPluginId(bucket({ name: "default" })), "");
  assert.equal(bucketPluginId(bucket({ kind: "static", name: AGENT_RELEASES_BUCKET })), "");
});

test("a bucket the console does not author is not editable by hand", () => {
  // A reserved bucket is refused outright; the agent release bucket is refused
  // because adding or removing a release is an agent-update decision. Both
  // used to be discovered only after the operator had typed a value and
  // pressed save.
  assert.equal(bucketWritable(bucket({ reserved: true })), false);
  assert.equal(bucketWritable(bucket({ kind: "static", name: AGENT_RELEASES_BUCKET })), false);

  // The line identity map is the third. The card says the server writes it and
  // that editing it changes what nodes resolve a line to, and then offered an
  // enabled New entry button and an enabled row pencil over 313 entries with
  // no confirmation and no history to revert from. Saying who owns a bucket
  // and leaving its controls live is the worst of the two answers.
  assert.equal(bucketWritable(bucket({ name: "vpnmeta/lineuuid" })), false);
  assert.equal(bucketWritable(bucket({ name: "vpnmeta/lineuuid-owner" })), false);

  // A plugin's bucket stays writable: it is ordinary state a plugin keeps, the
  // console is where an operator repairs it, and no chain reads it back as an
  // identity.
  assert.equal(bucketWritable(bucket({ name: "plugin:latticenet.sub-store" })), true);
  assert.equal(bucketWritable(bucket()), true);
  // The kind carries the rule here too: a static bucket named vpnmeta/x was
  // made by whoever created it and is the operator's to edit.
  assert.equal(bucketWritable(bucket({ kind: "static", name: "vpnmeta/lineuuid" })), true);
});

test("the agent release listing carries no bytes, so it offers no preview", () => {
  // The server lists that bucket with the content stripped: nodes fetch and
  // install those bytes as root under a task lease. A Preview button over a
  // stripped object would show an empty box and read as data loss.
  assert.equal(bucketContentAvailable(bucket({ kind: "static", name: AGENT_RELEASES_BUCKET })), false);
  assert.equal(bucketContentAvailable(bucket({ kind: "static", name: "site" })), true);
  assert.equal(bucketContentAvailable(bucket({ name: "plugin:latticenet.sub-store" })), true);
});

test("a reserved bucket is the server's, and it is not the operator's own work", () => {
  // reservedLineSecretKVBucket() marks vpn-core's KV bucket, managedline/def,
  // vpn_users, vpn_user_secrets and managed_line_secrets reserved. None of
  // them carries a plugin: or vpnmeta/ name, so the name rules alone dropped
  // all five into the operator fallback: the sidebar badged the bucket holding
  // VPN user secrets "operator", and the card said nothing writes there except
  // this console, directly above the page's own line saying the server owns
  // the contents. Reserved is the server's own statement of ownership and it
  // outranks every name rule.
  assert.equal(bucketOwner(bucket({ name: "vpn_user_secrets", reserved: true })), "server");
  assert.equal(bucketOwner(bucket({ name: "vpn_users", reserved: true })), "server");
  assert.equal(bucketOwner(bucket({ name: "managed_line_secrets", reserved: true })), "server");
  assert.equal(bucketOwner(bucket({ name: "managedline/def", reserved: true })), "server");
  assert.equal(bucketOwner(bucket({ kind: "static", name: "anything", reserved: true })), "server");
});

test("a reserved bucket says it is reserved once, not twice in two voices", () => {
  // The card already renders the reserved copy: typed private state the server
  // owns, refused to every scope. The owner note is the derivation, and the
  // server-owned note names the line identity map, which is not what
  // vpn_user_secrets holds. So a reserved bucket carries no owner note and the
  // reserved copy stands alone.
  assert.equal(bucketOwnerNote(bucket({ name: "vpn_user_secrets", reserved: true })), "");
  assert.equal(bucketOwnerNote(bucket({ name: "vpnmeta/lineuuid", reserved: true })), "");

  // Every unreserved bucket still explains its owner.
  assert.equal(bucketOwnerNote(bucket({ name: "vpnmeta/lineuuid" })), "server");
  assert.equal(bucketOwnerNote(bucket({ name: "plugin:latticenet.sub-store" })), "plugin");
  assert.equal(bucketOwnerNote(bucket({ kind: "static", name: AGENT_RELEASES_BUCKET })), "agent");
  assert.equal(bucketOwnerNote(bucket()), "operator");
});

import assert from "node:assert/strict";
import test from "node:test";

import { geoRoutingPayload, splitIDList } from "./georouting.js";

test("splitIDList dedups and drops blanks", () => {
  assert.deepEqual(splitIDList(" eu1, as1  eu1 \n na1 "), ["eu1", "as1", "na1"]);
  assert.deepEqual(splitIDList(""), []);
});

test("geoRoutingPayload trims, lowercases host, defaults strategy, omits empties", () => {
  assert.deepEqual(geoRoutingPayload({
    name: " roobli ",
    hostname: " DNS.Roobli.Org ",
    node_ids: "eu1, as1",
    dns_node_ids: "eu1",
    ttl: "",
    geoip_db_path: "",
  }), {
    name: "roobli",
    hostname: "dns.roobli.org",
    strategy: "geoip",
    node_ids: ["eu1", "as1"],
    dns_node_ids: ["eu1"],
  });
});

test("geoRoutingPayload includes id, positive ttl, db path, explicit strategy", () => {
  assert.deepEqual(geoRoutingPayload({
    id: " gr1 ",
    name: "x",
    hostname: "dns.roobli.org",
    strategy: "all-healthy",
    node_ids: "eu1",
    dns_node_ids: "eu1",
    ttl: "120",
    geoip_db_path: "/etc/coredns/GeoLite2-City.mmdb",
  }), {
    id: "gr1",
    name: "x",
    hostname: "dns.roobli.org",
    strategy: "all-healthy",
    node_ids: ["eu1"],
    dns_node_ids: ["eu1"],
    ttl: 120,
    geoip_db_path: "/etc/coredns/GeoLite2-City.mmdb",
  });
});

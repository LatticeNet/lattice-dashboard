import assert from "node:assert/strict";
import test from "node:test";

import { formatPorts, nftInputsPayload, parsePorts } from "./nft.js";

test("parsePorts keeps positive integers sorted and unique", () => {
  assert.deepEqual(parsePorts("443, 80 443 nope -1 70000"), [80, 443, 70000]);
});

test("nftInputsPayload trims fields and includes public UDP", () => {
  assert.deepEqual(nftInputsPayload({
    node_id: " node-a ",
    interface_name: " ens3 ",
    wireguard_cidr: " 10.66.0.0/24 ",
    public_tcp: "80,443",
    public_udp: "53",
    wireguard_tcp: "22,9100",
    wireguard_udp: "51820",
  }), {
    node_id: "node-a",
    interface_name: "ens3",
    wireguard_cidr: "10.66.0.0/24",
    public_tcp: [80, 443],
    public_udp: [53],
    wireguard_tcp: [22, 9100],
    wireguard_udp: [51820],
  });
});

test("formatPorts returns compact comma list", () => {
  assert.equal(formatPorts([80, 443]), "80,443");
  assert.equal(formatPorts([]), "");
  assert.equal(formatPorts(null), "");
});

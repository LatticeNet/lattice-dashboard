/**
 * Where the Tunnels page says why it has no demo.
 *
 * The sentence is the one thing that page needs to land: a tunnel profile
 * saved without its credentials file on the node plans cleanly and then fails
 * at ingress validate, leaving a stray config behind. It was rendered as a
 * centred paragraph appended after the "New tunnel" button, which is the
 * position that gets read after the click it was meant to prevent, in the
 * typography that makes eleven ragged lines of it on a phone.
 *
 * Position and wiring are a template fact, so they are asserted against the
 * template. The alternative is finding out again from a screenshot.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import enNetworking from "../../../i18n/locales/en/networking.ts";
import zhNetworking from "../../../i18n/locales/zh-CN/networking.ts";

const emptyState = readFileSync(
  new URL("../../../components/common/EmptyState.vue", import.meta.url),
  "utf8",
);
const tunnels = readFileSync(new URL("../TunnelsView.vue", import.meta.url), "utf8");

test("EmptyState carries a notice, and renders it above the steps", () => {
  const notice = emptyState.indexOf('<slot name="notice" />');
  const steps = emptyState.indexOf('<ol v-if="steps?.length"');
  const actions = emptyState.indexOf('v-if="slots.default"');
  assert.ok(notice > 0, "EmptyState has no notice slot");
  assert.ok(steps > 0 && actions > 0, "EmptyState no longer renders steps and actions");
  assert.ok(notice < steps, "the notice renders below the steps");
  assert.ok(notice < actions, "the notice renders below the call to action");
  assert.match(emptyState.slice(notice - 200, notice), /text-left/, "the notice is not left-aligned");
});

test("the Tunnels no-demo sentence is a notice on the empty state, not a paragraph after the button", () => {
  const block = tunnels.slice(tunnels.indexOf("<EmptyState"), tunnels.indexOf("</EmptyState>"));
  assert.ok(block.length > 0, "TunnelsView no longer renders an EmptyState");
  assert.match(block, /<template #notice>/);
  assert.match(block, /keypath="networking\.tunnels\.noDemo"/);
  assert.doesNotMatch(
    tunnels,
    /text-center[^>]*>\s*\{\{ \$t\('networking\.tunnels\.noDemo'\) \}\}/,
    "the centred paragraph after the button is back",
  );
  // The button still exists, and now reads after the caveat rather than before it.
  assert.ok(block.indexOf("#notice") < block.indexOf("networking.tunnels.newTunnel"));
});

test("the credentials path is set as a path, in one place, in both locales", () => {
  assert.match(tunnels, /const CREDENTIALS_PATH = "\/etc\/cloudflared\/<tunnel id>\.json";/);
  assert.match(tunnels, /<code class="whitespace-nowrap font-mono[^"]*">\{\{ CREDENTIALS_PATH \}\}<\/code>/);
  for (const [locale, messages] of [["en", enNetworking], ["zh-CN", zhNetworking]] as const) {
    const copy = (messages as { networking: { tunnels: { noDemo: string } } }).networking.tunnels.noDemo;
    assert.match(copy, /\{path\}/, `${locale} noDemo lost its path slot`);
    assert.doesNotMatch(copy, /\/etc\/cloudflared/, `${locale} noDemo still hard-codes the path in prose`);
  }
});

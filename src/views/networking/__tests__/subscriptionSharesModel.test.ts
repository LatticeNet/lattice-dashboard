import assert from "node:assert/strict";
import test from "node:test";

import {
  SHARE_SLUG_MAX_LENGTH,
  SHARE_SLUG_RE,
  slugifyShareName,
  suggestShareSlug,
} from "../subscriptionSharesModel.ts";

test("a clean record name slugifies to itself", () => {
  assert.equal(slugifyShareName("openjobs-host"), "openjobs-host");
  assert.equal(suggestShareSlug("openjobs-host", []), "openjobs-host");
  assert.equal(suggestShareSlug("openjobs-host", ["other-share"]), "openjobs-host");
});

test("case, spaces, and punctuation fold into dashes", () => {
  assert.equal(slugifyShareName("OpenJobs Host"), "openjobs-host");
  assert.equal(slugifyShareName("sub_store.prod!"), "sub-store-prod");
  assert.equal(slugifyShareName("  padded  name  "), "padded-name");
  assert.equal(slugifyShareName("a--b___c"), "a-b-c");
});

test("leading and trailing dashes are trimmed so the slug starts with a letter or digit", () => {
  assert.equal(slugifyShareName("-lead"), "lead");
  assert.equal(slugifyShareName("trail-"), "trail");
  assert.equal(slugifyShareName("--both--"), "both");
});

test("a name with nothing slug-safe yields no suggestion", () => {
  assert.equal(slugifyShareName("订阅"), "");
  assert.equal(slugifyShareName("!!!"), "");
  assert.equal(slugifyShareName("   "), "");
  assert.equal(suggestShareSlug("订阅", []), "");
});

test("every suggestion satisfies the server slug rule", () => {
  const names = ["openjobs-host", "9-lives", "x", "A" + "b".repeat(100), "a-b"];
  for (const name of names) {
    const slug = slugifyShareName(name);
    assert.ok(SHARE_SLUG_RE.test(slug), `${name} → ${slug}`);
  }
});

test("the slug is capped at the server length without a trailing dash", () => {
  const slug = slugifyShareName(`a${"-b".repeat(40)}`); // 81 chars before the cap
  assert.ok(slug.length <= SHARE_SLUG_MAX_LENGTH);
  assert.ok(!slug.endsWith("-"));
  assert.ok(SHARE_SLUG_RE.test(slug));
});

test("a collision with an existing share leaves the slug empty for the user", () => {
  assert.equal(suggestShareSlug("openjobs-host", ["openjobs-host"]), "");
  assert.equal(suggestShareSlug("openjobs-host", ["openjobs-host-2"]), "openjobs-host");
});

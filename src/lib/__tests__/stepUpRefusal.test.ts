import assert from "node:assert/strict";
import { test } from "node:test";

import { ApiError } from "../api/client.ts";
import { isRejectedPasscode } from "../stepUpRefusal.ts";

test("a refused passcode is recognised by the server's words, so the console can say it in its own", () => {
  // lattice-server's step-up, and the dev harness's.
  assert.equal(isRejectedPasscode(new ApiError(401, "unauthorized", "invalid second factor")), true);
  assert.equal(isRejectedPasscode(new ApiError(401, "invalid_code", "invalid or expired passcode")), true);
  // Any other refusal keeps the server's reason: 2FA not enabled, a session that ended.
  assert.equal(isRejectedPasscode(new ApiError(403, "forbidden", "an authenticator passcode must be enabled before passcode step-up")), false);
  assert.equal(isRejectedPasscode(new ApiError(401, "unauthorized", "unauthorized")), false);
  assert.equal(isRejectedPasscode(new Error("invalid second factor")), false);
});

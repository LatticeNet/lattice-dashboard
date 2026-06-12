import assert from "node:assert/strict";
import test from "node:test";

import { apiErrorMessage } from "./api-error.js";

test("apiErrorMessage reads structured Lattice API errors", () => {
  assert.equal(
    apiErrorMessage({
      error: {
        code: "unauthorized",
        message: "invalid credentials",
        request_id: "req_test",
      },
    }, "fallback"),
    "invalid credentials",
  );
});

test("apiErrorMessage maps security codes to operator actions", () => {
  const cases = [
    {
      code: "capability_denied",
      serverMessage: "missing kv:write",
      expected: "Permission denied: the current token lacks the required capability. Request ID: req_cap",
    },
    {
      code: "invalid_node_token",
      serverMessage: "invalid node token",
      expected: "Node authentication failed. Rotate or re-enroll the node token. Request ID: req_node",
    },
    {
      code: "invalid_task_lease",
      serverMessage: "invalid task lease",
      expected: "Task lease expired or does not match this node. Fetch a fresh task lease before retrying. Request ID: req_lease",
    },
    {
      code: "task_output_limit_exceeded",
      serverMessage: "stdout exceeds task output limit",
      expected: "Task output exceeded its configured limit. Increase the task output cap or reduce command output. Request ID: req_limit",
    },
  ];

  for (const tc of cases) {
    assert.equal(
      apiErrorMessage({
        error: {
          code: tc.code,
          message: tc.serverMessage,
          request_id: tc.expected.match(/req_[a-z]+$/)[0],
        },
      }, "fallback"),
      tc.expected,
    );
  }
});

test("apiErrorMessage remains compatible with legacy string errors", () => {
  assert.equal(apiErrorMessage({ error: "forbidden" }, "fallback"), "forbidden");
});

test("apiErrorMessage falls back when response has no error payload", () => {
  assert.equal(apiErrorMessage({}, "Service Unavailable"), "Service Unavailable");
});

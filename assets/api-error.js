const securityErrorMessages = {
  capability_denied: "Permission denied: the current token lacks the required capability.",
  invalid_node_token: "Node authentication failed. Rotate or re-enroll the node token.",
  invalid_task_lease: "Task lease expired or does not match this node. Fetch a fresh task lease before retrying.",
  task_output_limit_exceeded: "Task output exceeded its configured limit. Increase the task output cap or reduce command output.",
};

export function apiErrorMessage(data, fallback) {
  if (data && typeof data.error === "object" && typeof data.error.message === "string") {
    const mappedMessage = securityErrorMessages[data.error.code];
    if (mappedMessage && data.error.request_id) {
      return `${mappedMessage} Request ID: ${data.error.request_id}`;
    }
    if (mappedMessage) {
      return mappedMessage;
    }
    return data.error.message;
  }
  if (data && typeof data.error === "string") {
    return data.error;
  }
  return fallback;
}

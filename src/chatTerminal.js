/**
 * Terminal SSE event rules.
 *
 * Exactly one done or error event may be written per response. Only a genuine
 * generation failure may use an error event. Artifact or conversation
 * persistence failures after a complete generation are reported as done with
 * a structured saveWarning so the answer is never presented as a failure.
 */

export const SAVE_WARNING_MESSAGE =
  "The answer was generated, but it could not be saved to your history. Copy or download it now.";

const TERMINAL_EVENT = Symbol("vupsTerminalEvent");

export function isTerminalEventType(type) {
  return type === "done" || type === "error";
}

export function saveWarningFor(error) {
  const code = typeof error?.code === "string" && error.code ? error.code : "persist_failed";
  return { code, message: SAVE_WARNING_MESSAGE };
}

export function resolveTerminalEvent({
  failure = null,
  artifactError = null,
  persistFailure = null,
  clientAborted = false
} = {}) {
  if (clientAborted) return { type: "none", saveWarning: null };
  if (failure) return { type: "error", saveWarning: null };
  const saveError = artifactError || persistFailure;
  if (saveError) return { type: "done", saveWarning: saveWarningFor(saveError) };
  return { type: "done", saveWarning: null };
}

/** Writes one SSE data event, refusing anything after a terminal event. */
export function writeSseEvent(res, payload) {
  if (!res || res.writableEnded) return false;
  if (res[TERMINAL_EVENT]) return false;
  const type = payload?.type;
  if (isTerminalEventType(type)) res[TERMINAL_EVENT] = type;
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
  return true;
}

export function hasTerminalEvent(res) {
  return Boolean(res?.[TERMINAL_EVENT]);
}

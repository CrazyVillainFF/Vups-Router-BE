import { isQuotaExhaustedError } from "./providerClient.js";

// Failover and same-model retry are different decisions. providerClient calls
// quota exhaustion permanent because asking the same exhausted account again
// cannot help; a different configured model on a different account can still
// answer, so quota belongs in the failover set even though the retry verdict
// excludes it. The sets below are keyed on the structured category the provider
// client attaches, never on provider wording.
const FAILOVER_CATEGORIES = new Set([
  "rate_limit_requests",
  "rate_limit_tokens",
  "ambiguous_rate_limit",
  "concurrency_limit",
  "quota_exhausted",
  "overloaded",
  "upstream_unavailable",
  "network_error",
  "timeout",
  "session_busy",
  "empty_response"
]);

const PERMANENT_CATEGORIES = new Set([
  "context_limit",
  "invalid_credentials",
  "forbidden",
  "invalid_model",
  "invalid_request",
  "request_too_large",
  "output_limit"
]);

// Errors raised before any HTTP exchange (provider resolution, transport) carry
// a code but no category.
const FAILOVER_CODES = new Set([
  "timeout",
  "network_error",
  "dns_error",
  "connection_refused",
  "stream_error",
  "provider_unavailable",
  "upstream_unavailable",
  "overloaded",
  "session_busy",
  "empty_response",
  "rate_limited",
  "rate_limit_requests",
  "rate_limit_tokens",
  "ambiguous_rate_limit",
  "concurrency_limit",
  "free_quota_exhausted",
  "quota_exhausted",
  "insufficient_credits"
]);

const PERMANENT_CODES = new Set([
  "cancelled",
  "invalid_credentials",
  "invalid_api_key",
  "missing_api_key",
  "key_decryption_failed",
  "forbidden",
  "invalid_model",
  "model_unavailable",
  "context_limit",
  "invalid_request",
  "request_too_large",
  "output_limit",
  "provider_disabled",
  "config_not_found",
  "invalid_base_url",
  "invalid_source",
  "vups_not_configured",
  "vups_vision_unsupported",
  "shared_disabled",
  "shared_model_unavailable",
  "unsupported_qoder_mode"
]);

const FAILOVER_REASONS = {
  rate_limit_requests: "hit its request rate limit",
  rate_limit_tokens: "hit its token rate limit",
  ambiguous_rate_limit: "was rate limited",
  concurrency_limit: "hit the provider's concurrency limit",
  quota_exhausted: "exhausted its quota or credits",
  overloaded: "is temporarily overloaded",
  upstream_unavailable: "is temporarily unavailable",
  provider_unavailable: "is temporarily unavailable",
  network_error: "could not be reached",
  dns_error: "could not be reached",
  connection_refused: "refused the connection",
  stream_error: "dropped the response stream",
  timeout: "timed out",
  session_busy: "is still finishing another turn",
  empty_response: "returned no usable answer"
};

const PERMANENT_REASONS = {
  invalid_credentials: "rejected its API key",
  invalid_api_key: "rejected its API key",
  missing_api_key: "has no API key configured",
  key_decryption_failed: "has an API key that could not be read",
  forbidden: "was denied access by the provider",
  invalid_model: "is not offered by that provider",
  model_unavailable: "is not offered by that provider",
  context_limit: "cannot fit this conversation in its context window",
  invalid_request: "rejected the request payload",
  request_too_large: "rejected the request as too large",
  output_limit: "spent its whole output budget before answering",
  config_not_found: "is no longer configured",
  invalid_base_url: "has an invalid provider URL",
  provider_disabled: "is disabled",
  vups_not_configured: "is not configured on this server",
  vups_vision_unsupported: "does not support this request",
  shared_disabled: "is disabled",
  shared_model_unavailable: "is not available in the shared pool",
  unsupported_qoder_mode: "does not support this mode"
};

function normalizedCategory(error) {
  if (typeof error?.category === "string" && error.category) return error.category;
  const classification = error?.classification;
  if (classification && typeof classification === "object" && typeof classification.category === "string") {
    return classification.category;
  }
  return "";
}

function normalizedCode(error) {
  const code = String(error?.code || "");
  if (code === "rate_limited") return "ambiguous_rate_limit";
  if (code === "free_quota_exhausted" || code === "insufficient_credits") return "quota_exhausted";
  return code;
}

/**
 * The failover category for a failed attempt, or null when the failure must end
 * the run instead of moving to the next model. A null verdict covers credential,
 * authorization, payload, capability and configuration failures: switching models
 * cannot repair those, and silently trying the next one would hide the real
 * problem from the person who has to fix it.
 */
export function comboFailoverCategory(error) {
  if (!error || typeof error !== "object") return null;
  if (error.code === "cancelled" || error.name === "ComboCancelledError" || error.name === "AbortError") return null;
  if (isQuotaExhaustedError(error)) return "quota_exhausted";

  const category = normalizedCategory(error);
  if (FAILOVER_CATEGORIES.has(category)) return category;
  if (PERMANENT_CATEGORIES.has(category)) return null;

  const code = normalizedCode(error);
  if (PERMANENT_CODES.has(code)) return null;
  if (FAILOVER_CODES.has(code)) return code;

  const status = Number(error.status);
  if (status === 429) return "ambiguous_rate_limit";
  if (status === 408) return "timeout";
  if (status === 402) return "quota_exhausted";
  if (Number.isInteger(status) && status >= 500 && status <= 599) return "upstream_unavailable";
  return null;
}

// The phrase the interface shows. It is derived from the classification, so no
// raw provider message, status text or credential can reach the user through it.
export function comboFailureReason(error) {
  const category = comboFailoverCategory(error);
  if (category) return FAILOVER_REASONS[category] || "is temporarily unavailable";
  const permanent = normalizedCategory(error) || normalizedCode(error);
  return PERMANENT_REASONS[permanent] || "could not complete the request";
}
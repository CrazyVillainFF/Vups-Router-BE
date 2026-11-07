import ResetDelivery from "./resetDeliveryLog.js";

// Rolling "is the email provider actually accepting sends?" signal.
//
// Why this exists: /forgot-password used to answer HTTP 200 with "we sent a
// code" even when the provider rejected the send, because an honest failure
// answer for a *registered* address would reveal that the address exists. The
// failure state is therefore tracked for the provider as a whole and consulted
// before any account is looked up: while the window is open every request gets
// the same answer, whether or not the address has an account.
//
// Nothing is claimed that did not happen. While the window is open no code is
// generated and no send is attempted, so "no code was sent" is literally true
// for every address, and the per-email 24-hour quota is not spent on a request
// the server refused up front.

const PROVIDER = "brevo";

// Short on purpose: a transient provider hiccup should cost the next recovery
// attempt about a minute, not a ten-minute lockout, while still covering the
// burst of retries that follows a failed request.
export const RESET_DELIVERY_FAILING_WINDOW_MS = (() => {
  const value = Number(process.env.PASSWORD_RESET_DELIVERY_FAILING_WINDOW_MS);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 60 * 1000;
})();

// Only these codes are ever stored, so an unexpected error string from the
// provider cannot end up written to the database.
const KNOWN_CODES = new Set([
  "bad_request",
  "config_missing",
  "invalid_api_key",
  "network_error",
  "provider_unavailable",
  "rate_limited",
  "timeout"
]);

/**
 * Records the outcome of one delivery attempt. Bookkeeping must never be the
 * reason a reset request fails, so a storage problem is logged and swallowed.
 */
export async function recordResetDeliveryAttempt({ ok, code = null, messageId = null }) {
  const now = new Date();
  const receipt = typeof messageId === "string" ? messageId.slice(0, 120) : null;
  const update = ok
    ? { $set: { lastOutcome: "sent", lastSuccessAt: now, lastFailureCode: null, lastMessageId: receipt } }
    : { $set: { lastOutcome: "failed", lastFailureAt: now, lastFailureCode: KNOWN_CODES.has(code) ? code : "provider_unavailable" } };
  try {
    await ResetDelivery.updateOne({ provider: PROVIDER }, update, { upsert: true });
  } catch (error) {
    console.error("Reset delivery bookkeeping failed:", error?.name || "unknown error");
  }
}

/**
 * Returns { failing, lastFailureCode, retryAfterMs } for the current moment.
 * `failing` is true only while the newest recorded event is a failure and it is
 * still inside the window; a later success clears it immediately.
 */
export async function resetEmailDeliveryState() {
  try {
    const doc = await ResetDelivery.findOne({ provider: PROVIDER }).lean();
    const failureAt = doc?.lastFailureAt instanceof Date ? doc.lastFailureAt.getTime() : 0;
    const successAt = doc?.lastSuccessAt instanceof Date ? doc.lastSuccessAt.getTime() : 0;
    if (!failureAt || successAt >= failureAt) return { failing: false, lastFailureCode: null, retryAfterMs: 0 };
    const remaining = failureAt + RESET_DELIVERY_FAILING_WINDOW_MS - Date.now();
    if (remaining <= 0) return { failing: false, lastFailureCode: null, retryAfterMs: 0 };
    return { failing: true, lastFailureCode: doc.lastFailureCode || "provider_unavailable", retryAfterMs: remaining };
  } catch (error) {
    // Unknown health must not invent a failure: the request proceeds and the
    // real delivery outcome (recorded below) decides what the user is told.
    console.error("Reset delivery health read failed:", error?.name || "unknown error");
    return { failing: false, lastFailureCode: null, retryAfterMs: 0 };
  }
}

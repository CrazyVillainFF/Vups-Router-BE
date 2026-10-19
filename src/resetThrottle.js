import crypto from "node:crypto";
import ResetSendLog from "./resetSendLog.js";

// Rolling-window limit on password reset code sends (per email address).
//
// Default: 4 sends per 24 hours. The window is rolling, not calendar-based:
// a send is only forgotten once it is older than 24 hours.
//
// Enumeration safety: the counter is keyed by the email string itself, not by
// an existing account, so known and unknown addresses share identical
// behavior (same 200s, same counter, same 429s).
//
// Concurrency: the critical check-and-record step is a single conditional
// findOneAndUpdate (Mongo pipeline update with an $expr size check), so
// concurrent requests cannot both squeeze past the limit.

export const RESET_SEND_WINDOW_MS = 24 * 60 * 60 * 1000;

const envInt = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
};

export const RESET_SEND_LIMIT = envInt("PASSWORD_RESET_SEND_LIMIT_MAX", 4);

export function hashResetEmail(email) {
  return crypto.createHash("sha256").update(String(email)).digest("hex");
}

function toMillis(value) {
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

function inWindow(sends, windowStartMs) {
  return (Array.isArray(sends) ? sends : [])
    .map(toMillis)
    .filter(time => time > windowStartMs)
    .sort((a, b) => a - b);
}

/**
 * Atomically checks the rolling window and records one send attempt.
 *
 * Returns { allowed: true, remaining } after recording, or
 * { allowed: false, remaining: 0, retryAfterMs } without recording.
 * A failed email delivery still counts (the send is recorded before any
 * delivery attempt), so failures can never reset or extend the window.
 */
export async function recordResetSend(email, now = new Date()) {
  const emailHash = hashResetEmail(email);
  const nowMs = now.getTime();
  const windowStart = new Date(nowMs - RESET_SEND_WINDOW_MS);

  const underLimit = {
    $expr: {
      $lt: [
        {
          $size: {
            $filter: {
              input: { $ifNull: ["$sends", []] },
              as: "ts",
              cond: { $gt: ["$$ts", windowStart] }
            }
          }
        },
        RESET_SEND_LIMIT
      ]
    }
  };
  const pruneAndPush = [
    {
      $set: {
        sends: {
          $filter: {
            input: { $ifNull: ["$sends", []] },
            as: "ts",
            cond: { $gt: ["$$ts", windowStart] }
          }
        }
      }
    },
    { $set: { sends: { $concatArrays: ["$sends", [now]] } } }
  ];

  // Make sure the document exists first (idempotent upsert); the conditional
  // update below then never takes the insert path, so a limit rejection is a
  // clean null instead of a duplicate-key race.
  try {
    await ResetSendLog.updateOne({ emailHash }, { $setOnInsert: { sends: [] } }, { upsert: true });
  } catch (error) {
    if (error?.code !== 11000) throw error;
  }

  const updated = await ResetSendLog.findOneAndUpdate(
    { emailHash, ...underLimit },
    pruneAndPush,
    { returnDocument: "after", projection: { sends: 1 }, updatePipeline: true }
  );
  if (updated) {
    const count = inWindow(updated.sends, nowMs - RESET_SEND_WINDOW_MS).length;
    return { allowed: true, remaining: Math.max(0, RESET_SEND_LIMIT - count) };
  }

  const existing = await ResetSendLog.findOne({ emailHash }).select("sends").lean();
  const times = inWindow(existing?.sends, nowMs - RESET_SEND_WINDOW_MS);
  const retryAfterMs = times.length > 0 ? Math.max(0, times[0] + RESET_SEND_WINDOW_MS - nowMs) : RESET_SEND_WINDOW_MS;
  return { allowed: false, remaining: 0, retryAfterMs };
}

import { validTaskId } from "./task.js";
import { recordDispatchAttempt } from "./taskStore.js";
import { dispatchConfigured, dispatchTimeoutMs, executorDispatchUrl, serviceRole, serviceToServiceSecret, SERVICE_ROLE_HEADER } from "./serviceRole.js";

/**
 * Main's hand-off to the runner (two-backend split, Phase 3/4).
 *
 * This is a *hint*, not a transfer. The task is already a durable row before anything here runs, so
 * a failed, slow, refused or never-sent notification costs nothing but the delay until the runner's
 * own poll: work is never carried by this request, and no code path may lose a task because a socket
 * did not open. That single property is why the split can be added without making durability worse.
 *
 * What it buys is latency. A Render free instance sleeps, and its queue loop polls once a second when
 * awake, so an unattended submission waits for a cold start nobody triggered. One request to the
 * runner's internal endpoint starts the instance and prompts an immediate claim pass.
 *
 * Nothing user-visible is sent: the body is a task id.
 */

const WAKE_PATH = "/api/internal/tasks/wake";
const CANCEL_PATH = "/api/internal/tasks/cancel";

export function dispatchEnabled(env = process.env) {
  return serviceRole(env.SERVER_ROLE) !== "executor" && dispatchConfigured(env);
}

async function post(path, payload, { fetchImpl = globalThis.fetch, secret = serviceToServiceSecret() } = {}) {
  const base = executorDispatchUrl();
  if (!base || !secret || !validTaskId(payload?.taskId)) {
    return { ok: false, status: 0, code: "dispatch_not_configured" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), dispatchTimeoutMs());
  timer.unref?.();
  try {
    const response = await fetchImpl(`${base}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [SERVICE_ROLE_HEADER]: secret
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    let code = response.ok ? "accepted" : "rejected";
    try {
      const text = await response.text();
      const parsed = text ? JSON.parse(text) : null;
      if (parsed?.code) code = String(parsed.code).slice(0, 60);
    } catch {
      // A non-JSON answer from something in front of the runner still has a status worth keeping.
    }
    return { ok: response.ok, status: response.status, code };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      code: error?.name === "AbortError" ? "dispatch_timeout" : "dispatch_unreachable"
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Tell the runner that `taskId` is claimable. Deliberately not awaited by its callers: a submission
 * must not spend the user's request waiting on a second service. The outcome is written to the task
 * so a report can say whether the hand-off was delivered, refused or never sent.
 */
export function notifyTaskQueued(taskId, options = {}) {
  return settle("wake", taskId, options);
}

/**
 * Interrupt a run this process is not holding. The record is already cancelled by the time this
 * happens, so this only shortens the wait — the runner's lease heartbeat reads the same record and
 * stops regardless of whether this call lands.
 */
export function notifyTaskCancelled(taskId, options = {}) {
  return settle("cancel", taskId, options);
}

async function settle(kind, taskId, options) {
  if (!dispatchEnabled()) {
    await recordHalfConfigured(kind, taskId);
    return { ok: false, status: 0, code: "dispatch_not_configured" };
  }
  const result = await post(kind === "wake" ? WAKE_PATH : CANCEL_PATH, { taskId }, options);
  if (kind === "wake") {
    await recordDispatchAttempt(taskId, result).catch(() => {});
  }
  return result;
}

/**
 * Name the one misconfiguration that is otherwise invisible: an address was given, so somebody meant
 * to split the deployment, but the key is missing or too weak and nothing will ever be sent.
 *
 * A deployment with neither is the ordinary single-service case and must not pay a database write
 * per task for the privilege of recording that nothing happened.
 */
async function recordHalfConfigured(kind, taskId) {
  if (kind !== "wake") return false;
  const hasUrl = Boolean(String(process.env.AI_EXECUTION_URL ?? "").trim());
  if (!hasUrl || serviceToServiceSecret()) return false;
  await recordDispatchAttempt(taskId, { ok: false, status: 0, code: "dispatch_not_configured" }).catch(() => {});
  return true;
}

import crypto from "node:crypto";

/**
 * Which half of the job this process is allowed to do (two-backend split, Phase 2).
 *
 * One deployment answers browsers and one drains the task queue, from the same image, so the only
 * difference between them has to be a role read at boot. `all` is the default because that is what
 * every existing single-service deployment is: a process with no `SERVER_ROLE` behaves exactly as it
 * did before this module existed.
 *
 * The role is a *capability* switch, not a label. `main` may not execute tasks, `executor` may not
 * serve a browser, and both facts are asked by the code that enforces them rather than by a log line.
 */

export const SERVICE_ROLES = Object.freeze(["all", "main", "executor"]);
export const SERVICE_ROLE_HEADER = "x-vups-service-key";

export function parseServiceRole(value = process.env.SERVER_ROLE) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return "all";
  if (!SERVICE_ROLES.includes(raw)) {
    throw new Error(
      `SERVER_ROLE must be one of ${SERVICE_ROLES.join(", ")} (got "${raw.slice(0, 40)}").`
    );
  }
  return raw;
}

/** The routes a browser uses. An executor serves none of them, so it cannot be used as an API. */
export function servesUserApi(role = serviceRole()) {
  return role !== "executor";
}

/** The task scheduler. Main creates work; only a role that can execute may run it. */
export function canRunTaskWorker(role = serviceRole()) {
  return role !== "main";
}

// Read once, at boot: a request that changed the role of a running process would change which
// routes it serves while those routes are already mounted.
let resolvedRole = null;

export function serviceRole() {
  if (resolvedRole === null) resolvedRole = parseServiceRole();
  return resolvedRole;
}

/** Only tests and the boot path call this; everything else reads `serviceRole()`. */
export function resetServiceRole(value) {
  resolvedRole = value === undefined ? null : parseServiceRole(value);
  return resolvedRole;
}

/**
 * The shared secret. Required to be as strong as the two secrets the boot already refuses to run
 * without, because it authorises work execution rather than one account.
 */
export function serviceToServiceSecret() {
  const secret = process.env.SERVICE_TO_SERVICE_SECRET;
  return typeof secret === "string" && secret.trim().length >= 32 ? secret.trim() : null;
}

export function serviceAuthConfigured() {
  return serviceToServiceSecret() !== null;
}

function digest(value) {
  // Hashing first keeps the comparison constant-time for inputs of different lengths, which
  // `timingSafeEqual` alone cannot do — it throws when the buffers differ.
  return crypto.createHash("sha256").update(String(value)).digest();
}

/**
 * The one gate on `/api/internal/*`. A caller has to present the shared secret; a user session never
 * counts, and a missing or wrong secret is the same answer either way, so the endpoint's existence is
 * not a probe target.
 */
export function isServiceRequest(req) {
  const secret = serviceToServiceSecret();
  if (!secret) return false;
  const header = req.get(SERVICE_ROLE_HEADER);
  const presented = typeof header === "string" ? header.trim() : "";
  if (!presented) return false;
  return crypto.timingSafeEqual(digest(presented), digest(secret));
}

/**
 * Where Main hands work to. `http:` is refused when the process believes it is in production, except
 * for loopback, without which a two-process local run could not exercise the real code path.
 */
export function executorDispatchUrl(env = process.env) {
  const raw = String(env.AI_EXECUTION_URL ?? "").trim().replace(/\/+$/, "");
  if (!raw) return null;
  let url = null;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const secure = url.protocol === "https:";
  const loopback = url.protocol === "http:" && /^(127\.0\.0\.1|localhost|\[::1\])$/.test(url.hostname);
  if (!secure && !loopback) return null;
  if (env.NODE_ENV === "production" && loopback) return null;
  return url.toString().replace(/\/+$/, "");
}

export function dispatchConfigured(env = process.env) {
  return executorDispatchUrl(env) !== null && Boolean(serviceToServiceSecret());
}

export function dispatchTimeoutMs(env = process.env) {
  const value = Number(env.AI_DISPATCH_TIMEOUT_MS);
  return Number.isFinite(value) && value >= 250 ? Math.floor(value) : 3000;
}

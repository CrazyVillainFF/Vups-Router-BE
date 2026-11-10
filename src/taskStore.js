import crypto from "node:crypto";
import Task, {
  MAX_EVENT_MESSAGE_CHARS,
  MAX_TASK_DESCRIPTION_CHARS,
  TASK_RETENTION_MS,
  newTaskId,
  validTaskId
} from "./task.js";
import { appendRunEvents, progressText } from "./taskEvents.js";
import {
  CLAIMABLE_STATES,
  EXECUTING_STATES,
  TERMINAL_STATES,
  TaskStateError,
  assertTransition,
  isTerminal
} from "./taskState.js";

/**
 * Every read and write of a task goes through this module, so the rules that
 * hold the record together — ownership, the state machine, "the worker owns the
 * state column", the lease that keeps two schedulers off the same task — exist
 * in exactly one place.
 *
 * Ownership is a query filter, never a check after the fact: a task is loaded by
 * `{ taskId, userId }`, so another account's task is simply not found and cannot
 * be read, listed, streamed or cancelled.
 */

// How many claimable rows one claim looks at. A claim is a compare-and-set on a
// row it has read, so a scheduler that loses the race moves on to the next
// candidate within the same pass instead of waiting for the next tick.
const CLAIM_SCAN = 8;

export class TaskNotFoundError extends Error {
  constructor(taskId) {
    super(`Task ${taskId} was not found.`);
    this.name = "TaskNotFoundError";
    this.code = "task_not_found";
    this.taskId = taskId;
  }
}

export class TaskStoppedError extends Error {
  constructor(taskId, state) {
    super(`Task ${taskId} is already ${state}.`);
    this.name = "TaskStoppedError";
    this.code = isTerminal(state) ? "task_terminal" : "state_conflict";
    this.taskId = taskId;
    this.state = state;
  }
}

export function workerInstanceLabel() {
  // One id per process, so a lease names the process that holds the task and a
  // dead process's lease is recognisably stale.
  return `task_worker_${process.pid}_${crypto.randomBytes(4).toString("hex")}`;
}

function descriptionText(value) {
  // The description is the instruction the task runs on, so its line breaks
  // stay; only the outer whitespace and anything past the bound go.
  return String(value ?? "").trim().slice(0, MAX_TASK_DESCRIPTION_CHARS);
}

/**
 * Fields a plain writer may change. `state` is deliberately absent, and so are `lease` and
 * `dispatch`: those are written by a named owner with its own guarded update, and carrying them here
 * would let a holder's copy — loaded before the other service wrote its row — stamp the older value
 * back over it. A hand-off receipt erased by the first transition of the task it describes is the
 * bug that rule prevents.
 */
function mutableFields(task) {
  return {
    conversationId: task.conversationId || "",
    description: task.description || "",
    stage: task.stage || "queued",
    plan: task.plan || [],
    events: task.events || [],
    activeOperation: task.activeOperation || {},
    modelRequests: task.modelRequests || [],
    toolOperations: task.toolOperations || [],
    clarifications: task.clarifications || [],
    retry: task.retry || {},
    error: task.error || {},
    recovery: task.recovery || {},
    request: task.request || {},
    result: task.result || {},
    steps: task.steps || 0,
    startedAt: task.startedAt || null,
    lastActivityAt: task.lastActivityAt || Date.now(),
    completedAt: task.completedAt || null,
    expiresAt: task.expiresAt || null
  };
}

async function writeTask(task, extra = {}) {
  // Only `transition` may end a task, and it carries its own state guard. These
  // writers have none, so a holder whose in-memory copy predates a cancellation
  // would otherwise write its own (empty) terminal fields back over the record —
  // losing completedAt and expiresAt on a task that has already ended. History
  // is not rewritable by whoever is still holding a stale copy.
  await Task.updateOne(
    { taskId: task.taskId, state: { $nin: TERMINAL_STATES } },
    { $set: { ...mutableFields(task), ...extra } }
  );
  return task;
}

async function touch(task) {
  task.lastActivityAt = Date.now();
  return writeTask(task);
}

export async function createTask({
  userId,
  description,
  conversationId = "",
  request = {},
  state = "queued",
  stage = "queued"
}) {
  const task = await Task.create({
    taskId: newTaskId(),
    userId,
    conversationId: conversationId || "",
    description: descriptionText(description),
    state,
    stage,
    request,
    lastActivityAt: Date.now()
  });
  return task.toObject();
}

export async function loadTask({ taskId, userId }) {
  if (!validTaskId(taskId)) return null;
  const filter = { taskId: String(taskId).trim() };
  if (userId) filter.userId = userId;
  const task = await Task.findOne(filter).lean();
  return task || null;
}

export async function requireTask({ taskId, userId }) {
  const task = await loadTask({ taskId, userId });
  if (!task) throw new TaskNotFoundError(taskId);
  return task;
}

export async function listTasks({ userId, states = [], limit = 50 } = {}) {
  const filter = { userId };
  const wanted = (Array.isArray(states) ? states : [states]).filter(Boolean);
  if (wanted.length > 0) filter.state = { $in: wanted };
  return Task.find(filter).sort({ lastActivityAt: -1 }).limit(Math.min(Math.max(Number(limit) || 50, 1), 200)).lean();
}

export function countPlanStep(task, status) {
  return (task.plan || []).filter(step => step.status === status).length;
}

/**
 * The one writer of `state`. The transition table is consulted first, then the
 * database decides: the update only applies while the task is still in the state
 * this caller last saw, so a cancellation that landed mid-flight cannot be
 * overwritten by a worker that still believes it is running.
 */
export async function transition(task, to, { stage, event, events, settle, error } = {}) {
  assertTransition(task.state, to);
  const from = task.state;
  const now = new Date();
  task.state = to;
  if (stage !== undefined) task.stage = progressText(stage, 60);
  task.lastActivityAt = Date.now();
  if (to === "running" && !task.startedAt) task.startedAt = now;
  if (error !== undefined) {
    task.error = error === null
      ? { code: "", message: "", kind: "", retryable: false, providerStatus: null, at: null }
      : {
        code: progressText(error.code, 60),
        message: progressText(error.message, 500),
        kind: progressText(error.kind, 40),
        retryable: error.retryable === true,
        providerStatus: Number.isFinite(error.providerStatus) ? error.providerStatus : null,
        at: error.at || now
      };
  }
  const rows = [
    ...(event ? [event] : []),
    ...(Array.isArray(events) ? events : [])
  ];
  if (rows.length > 0 || settle) {
    if (settle) closeTaskEvents(task, settle);
    appendRunEvents(task, rows);
  }
  if (isTerminal(to)) {
    task.completedAt = now;
    task.expiresAt = new Date(Date.now() + TASK_RETENTION_MS);
    task.activeOperation = { kind: "none" };
    task.lease = { owner: "", claimedAt: null, heartbeatAt: null, expiresAt: null };
  }
  const result = await Task.updateOne(
    { taskId: task.taskId, state: from },
    { $set: { ...mutableFields(task), state: to } }
  );
  if (result.matchedCount === 0) {
    const fresh = await loadTask({ taskId: task.taskId });
    if (fresh) Object.assign(task, fresh);
    throw new TaskStoppedError(task.taskId, fresh?.state || to);
  }
  return task;
}

function closeTaskEvents(task, statuses) {
  task.events = (task.events || []).map(event => {
    if (event.status !== "running") return event;
    const status = statuses[event.phase];
    if (!status) return event;
    return { ...event, status };
  });
}

export async function appendTaskEvents(task, events = []) {
  const added = appendRunEvents(task, events);
  if (added.length > 0) await touch(task);
  return added;
}

export async function saveTask(task, extra = {}) {
  task.lastActivityAt = Date.now();
  return writeTask(task, extra);
}

export async function setStage(task, stage, activeOperation = undefined) {
  task.stage = progressText(stage, 60);
  if (activeOperation !== undefined) task.activeOperation = activeOperation;
  return touch(task);
}

export async function setPlan(task, steps) {
  task.plan = steps.map(step => ({
    id: progressText(step.id, 40),
    title: progressText(step.title, 200),
    status: step.status || "pending",
    detail: progressText(step.detail, MAX_EVENT_MESSAGE_CHARS),
    startedAt: step.startedAt || null,
    completedAt: step.completedAt || null
  }));
  return touch(task);
}

export async function markPlanStep(task, id, status, detail = "") {
  const plan = task.plan || [];
  const index = plan.findIndex(step => step.id === id);
  if (index < 0) return plan;
  const step = {
    ...plan[index],
    status,
    detail: progressText(detail, MAX_EVENT_MESSAGE_CHARS)
  };
  if (status === "running" && !step.startedAt) step.startedAt = new Date();
  if (["completed", "failed", "skipped"].includes(status) && !step.completedAt) step.completedAt = new Date();
  task.plan = plan.map((entry, position) => (position === index ? step : entry));
  await touch(task);
  return step;
}

export async function recordModelRequest(task, entry) {
  const startedAt = entry.startedAt || new Date();
  const row = {
    requestId: progressText(entry.requestId, 80),
    attempt: Number.isFinite(entry.attempt) ? entry.attempt : 1,
    model: progressText(entry.model, 120),
    // The provider's name and host only. An API key is never copied here.
    provider: progressText(entry.provider, 60),
    host: progressText(entry.host, 120),
    status: entry.status || "running",
    code: progressText(entry.code, 60),
    finishReason: progressText(entry.finishReason, 40),
    startedAt,
    endedAt: entry.endedAt || null
  };
  const requests = task.modelRequests || [];
  const index = requests.findIndex(
    candidate => candidate.requestId === row.requestId && candidate.attempt === row.attempt
  );
  task.modelRequests = index >= 0
    ? requests.map((candidate, position) => (position === index ? { ...candidate, ...row } : candidate))
    : [...requests, row];
  await touch(task);
  return row;
}

export async function recordToolOperation(task, entry) {
  const operations = task.toolOperations || [];
  // The operation id is the durable identity that makes a retry safe: a second
  // report for an id already recorded updates that row instead of adding one.
  const index = operations.findIndex(candidate => candidate.operationId === entry.operationId);
  const row = {
    operationId: progressText(entry.operationId, 80),
    callId: progressText(entry.callId, 120),
    tool: progressText(entry.tool, 60),
    path: progressText(entry.path, 200),
    status: entry.status || "pending",
    attempts: Number.isFinite(entry.attempts) ? entry.attempts : (index >= 0 ? operations[index].attempts + 1 : 1),
    code: progressText(entry.code, 60),
    startedAt: entry.startedAt || (index >= 0 ? operations[index].startedAt : new Date()),
    completedAt: entry.completedAt || null
  };
  task.toolOperations = index >= 0
    ? operations.map((candidate, position) => (position === index ? { ...candidate, ...row } : candidate))
    : [...operations, row];
  await touch(task);
  return row;
}

/**
 * Take the next task this process may run. A task is claimable when it is queued
 * or waiting to be recovered and no process holds a live lease on it.
 *
 * The claimant's own name is deliberately not a way back in: a task this process
 * already holds must have a lapsed lease to be claimed again, or a fast tick
 * would hand one still-queued task to a second execution of itself and two runs
 * would write the same record.
 *
 * `perUserLimit` is the fairness rule. Without it a single account that submits
 * twenty tasks takes the whole worker pool and everyone else waits, which makes
 * the queue useless for every other user; with it the claim passes over an owner
 * that already has that many tasks held and picks the oldest task belonging to
 * somebody with room. Counting "held" as a live lease rather than an executing
 * state closes the gap between claiming a task and moving it out of `queued`,
 * which is otherwise a window in which one tick can overrun the cap.
 *
 * Claiming is a compare-and-set on the row that was seen, not a blind write: two
 * schedulers that both select the same oldest task leave one winner, and the
 * loser moves on to the next candidate instead of starting a second run of work
 * that is already being done.
 *
 * `excludeTaskIds` closes the case the compare-and-set cannot: a task this
 * process already holds can come back to a claimable state from outside — a
 * whole-document write from a copy taken before the claim, or a recovery pass
 * that blanks its lease while the run is still inside the model call. The row
 * then looks untouched, the compare-and-set succeeds, and one process runs the
 * same task twice. The caller names the tasks it is already working so they are
 * never candidates again, whatever the table says about them.
 */
export async function claimNextTask({ owner, leaseMs, now = new Date(), perUserLimit = 0, excludeTaskIds = [] }) {
  const claimable = {
    state: { $in: CLAIMABLE_STATES },
    $or: [
      { "lease.owner": "" },
      { "lease.expiresAt": { $exists: false } },
      { "lease.expiresAt": null },
      { "lease.expiresAt": { $lt: now } }
    ]
  };
  if (excludeTaskIds.length > 0) claimable.taskId = { $nin: excludeTaskIds };
  if (perUserLimit > 0) {
    const atCap = await Task.aggregate([
      {
        $match: {
          state: { $nin: [...TERMINAL_STATES] },
          "lease.expiresAt": { $gte: now }
        }
      },
      { $group: { _id: "$userId", held: { $sum: 1 } } },
      { $match: { held: { $gte: perUserLimit } } }
    ]);
    const owners = atCap.map(row => row._id).filter(id => id != null);
    if (owners.length > 0) claimable.userId = { $nin: owners };
  }
  const candidates = await Task.find(claimable).sort({ createdAt: 1 }).limit(CLAIM_SCAN).lean();
  for (const candidate of candidates) {
    const claimed = await Task.updateOne(
      {
        taskId: candidate.taskId,
        state: candidate.state,
        "lease.expiresAt": candidate.lease?.expiresAt ?? null
      },
      {
        $set: {
          lease: { owner, claimedAt: now, heartbeatAt: now, expiresAt: new Date(now.getTime() + leaseMs) },
          lastActivityAt: now.getTime()
        }
      }
    );
    if (claimed.modifiedCount !== 1) continue;
    return Task.findOne({ taskId: candidate.taskId }).lean();
  }
  return null;
}

/**
 * Extend the lease this process holds while it is really working.
 *
 * The answer matters: `false` means the write matched nothing, so the lease is
 * no longer this owner's — another process took the task over after a lapse, or
 * the record was cancelled and cleaned up. A renewal that reports nothing is how
 * a worker keeps running a task it no longer owns, and two workers on one task
 * is the one thing the lease exists to prevent.
 */
export async function heartbeatTask(task, { owner, leaseMs, now = new Date() }) {
  const renewed = await Task.updateOne(
    { taskId: task.taskId, "lease.owner": owner },
    { $set: { "lease.heartbeatAt": now, "lease.expiresAt": new Date(now.getTime() + leaseMs) } }
  );
  return renewed.matchedCount === 1;
}

/** True once the user has asked for this task to stop, read from the record. */
export async function cancelRequested(taskId) {
  const found = await Task.findOne({ taskId }).select("state cancelRequestedAt").lean();
  if (!found) return { cancelled: true, state: null };
  return {
    cancelled: Boolean(found.cancelRequestedAt) || isTerminal(found.state),
    state: found.state
  };
}

export async function releaseLease(task, { owner }) {
  await Task.updateOne(
    { taskId: task.taskId, "lease.owner": owner },
    { $set: { "lease.owner": "", "lease.expiresAt": null } }
  );
}

// A hand-off that did not land still has a reason, and the reason decides whether a report can say
// "the runner was told" or only "the runner found the work by itself".
const DISPATCH_STATUS_BY_CODE = Object.freeze({
  accepted: "accepted",
  dispatch_timeout: "timeout",
  dispatch_unreachable: "unreachable",
  dispatch_not_configured: "not_configured"
});

/**
 * Write down what the notification to the runner achieved.
 *
 * A terminal task is not written to: a hand-off that arrives after the work is over is late, not
 * interesting, and rewriting a finished record's history for it would be exactly the thing the other
 * guarded writers here exist to prevent.
 */
export async function recordDispatchAttempt(taskId, outcome = {}) {
  const status = outcome.ok
    ? "accepted"
    : DISPATCH_STATUS_BY_CODE[outcome.code] || "rejected";
  await Task.updateOne(
    { taskId, state: { $nin: TERMINAL_STATES } },
    {
      $inc: { "dispatch.attempts": 1 },
      $set: {
        "dispatch.status": status,
        "dispatch.code": progressText(outcome.code, 60),
        "dispatch.httpStatus": Number.isFinite(outcome.status) ? Math.trunc(outcome.status) : 0,
        "dispatch.lastAt": new Date()
      }
    }
  );
  return status;
}

/**
 * A user cancelling a task is the only thing that may stop it besides a real
 * terminal condition, so it is a recorded action with its own event — not a
 * socket closing, and not a navigation.
 *
 * The guarded write can still lose to the holder moving the task in the same
 * moment, so it re-reads and tries again: of the two writes that both look
 * legal, the one the user asked for is the one that has to land.
 */
export async function cancelTask({ taskId, userId, by = "user", attempts = 3 }) {
  const task = await requireTask({ taskId, userId });
  if (isTerminal(task.state)) return { task, already: true };
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await transition(task, "cancelled", {
        stage: "cancelled",
        settle: { task: "cancelled", provider: "cancelled", tool: "cancelled", answer: "cancelled", skill: "cancelled" },
        event: {
          phase: "task",
          status: "cancelled",
          key: "task",
          message: progressText("You cancelled this task.")
        }
      });
      break;
    } catch (error) {
      if (!(error instanceof TaskStoppedError)) throw error;
      if (isTerminal(task.state)) return { task, already: true };
      if (attempt === attempts - 1) throw error;
    }
  }
  await Task.updateOne(
    { taskId },
    { $set: { cancelRequestedAt: new Date(), cancelRequestedBy: progressText(by, 40) } }
  );
  return { task, already: false };
}

/**
 * The boot-and-periodic reconciliation a durable task system needs: a task left
 * in an executing state by a process that is gone is moved to `recovering` with
 * its interruption recorded, which is what makes it claimable again. Without
 * this, an interrupted task stays "running" in the database forever with nothing
 * running it.
 */
export async function reconcileInterruptedTasks({ now = new Date(), graceMs = 0 } = {}) {
  const cutoff = new Date(now.getTime() - graceMs);
  const stale = await Task.find({
    state: { $in: EXECUTING_STATES },
    $or: [{ "lease.expiresAt": { $exists: false } }, { "lease.expiresAt": null }, { "lease.expiresAt": { $lt: cutoff } }]
  }).lean();
  const recovered = [];
  for (const task of stale) {
    // A task whose user already asked it to stop must not come back.
    if (task.cancelRequestedAt) continue;
    const interruptedAt = task.lease?.heartbeatAt || task.lease?.expiresAt || task.lastActivityAt || null;
    task.recovery = {
      ...(task.recovery || {}),
      interruptedAt: interruptedAt ? new Date(interruptedAt) : now,
      reason: "worker_lost",
      stateBeforeInterruption: task.state,
      restarts: (task.recovery?.restarts || 0) + 1,
      reconciledAt: now
    };
    task.lease = { owner: "", claimedAt: null, heartbeatAt: null, expiresAt: null };
    await transition(task, "recovering", {
      stage: "recovering",
      settle: { provider: "cancelled", tool: "cancelled", answer: "cancelled" },
      event: {
        phase: "task",
        status: "running",
        key: "recovering",
        message: progressText(
          `The task was interrupted while ${task.recovery.stateBeforeInterruption}. Resuming it from its last safe point.`
        )
      }
    });
    recovered.push({ taskId: task.taskId, state: task.state, restarts: task.recovery.restarts });
  }
  return recovered;
}

export function taskSummary(task) {
  return {
    taskId: task.taskId,
    state: task.state,
    stage: task.stage || "",
    description: task.description || "",
    conversationId: task.conversationId || null,
    createdAt: task.createdAt || null,
    startedAt: task.startedAt || null,
    lastActivityAt: task.lastActivityAt || null,
    completedAt: task.completedAt || null,
    steps: task.steps || 0,
    plan: (task.plan || []).map(step => ({
      id: step.id,
      title: step.title,
      status: step.status,
      detail: step.detail || ""
    })),
    completedSteps: countPlanStep(task, "completed"),
    pendingSteps: countPlanStep(task, "pending") + countPlanStep(task, "blocked"),
    lastEvent: (task.events || []).slice(-1)[0] || null,
    eventCount: (task.events || []).length,
    retry: {
      attempts: task.retry?.attempts || 0,
      maxAttempts: task.retry?.maxAttempts || 0,
      nextAttemptAt: task.retry?.nextAttemptAt || null,
      lastCode: task.retry?.lastCode || "",
      lastCategory: task.retry?.lastCategory || "",
      lastErrorAt: task.retry?.lastErrorAt || null,
      // The wait the provider asked for, and the rule that is applying it: a
      // client showing "retrying" has to be able to say for how long and why.
      retryAfterMs: task.retry?.retryAfterMs || 0,
      policy: task.retry?.policy || ""
    },
    error: {
      code: task.error?.code || "",
      message: task.error?.message || "",
      // The taxonomy class, not just a string: "rate limited" and "the key is
      // wrong" reach the user as different actions.
      kind: task.error?.kind || "",
      retryable: task.error?.retryable === true,
      providerStatus: task.error?.providerStatus ?? null
    },
    waitingOn: waitingOn(task),
    // How the work reached a runner. Empty means nothing was ever sent, which is the ordinary
    // single-service case and not a fault.
    dispatch: {
      status: task.dispatch?.status || "",
      attempts: task.dispatch?.attempts || 0,
      lastAt: task.dispatch?.lastAt || null
    }
  };
}

export function taskDetail(task, { events = true, eventLimit = 200 } = {}) {
  const summary = taskSummary(task);
  const log = (task.events || []).slice(-eventLimit);
  return {
    ...summary,
    activeOperation: task.activeOperation || { kind: "none" },
    modelRequests: (task.modelRequests || []).map(row => ({
      requestId: row.requestId,
      attempt: row.attempt,
      model: row.model,
      provider: row.provider,
      host: row.host,
      status: row.status,
      code: row.code || "",
      finishReason: row.finishReason || "",
      startedAt: row.startedAt,
      endedAt: row.endedAt
    })),
    toolOperations: task.toolOperations || [],
    clarifications: task.clarifications || [],
    recovery: task.recovery || {},
    cancelRequestedAt: task.cancelRequestedAt || null,
    cancelRequestedBy: task.cancelRequestedBy || "",
    result: task.result || {},
    // A caller that only wants the status can read it without the log.
    ...(events ? { events: log, lastSeq: log.length > 0 ? log[log.length - 1].seq : 0 } : {})
  };
}

function waitingOn(task) {
  if (task.state === "waiting_for_user") return "user";
  if (task.state === "waiting_for_permission") return "permission";
  if (task.state === "paused") return "resume";
  if (task.state === "queued") return "capacity";
  if (task.state === "retrying") return "provider";
  return null;
}

export function taskEventsAfter(task, after = 0) {
  const since = Number.isFinite(Number(after)) ? Number(after) : 0;
  const log = (task.events || []).filter(event => Number(event.seq) > since);
  const last = (task.events || []).slice(-1)[0];
  return { events: log, lastSeq: last?.seq || 0 };
}

export { Task, TaskStateError };

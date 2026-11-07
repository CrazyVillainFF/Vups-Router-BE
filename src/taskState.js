/**
 * The task state machine (Phase 1.3).
 *
 * A task's state is the server's record of what it is doing, and the only way
 * that record changes is through a transition this table allows. Terminal states
 * have no exits on purpose: a completed, failed or cancelled task is history, and
 * starting the work again means creating a new task, so a stray retry can never
 * resurrect a run the user already ended.
 */

export const TASK_STATES = Object.freeze([
  "queued",
  "planning",
  "running",
  "executing_tool",
  "retrying",
  "waiting_for_user",
  "waiting_for_permission",
  "paused",
  "recovering",
  "verifying",
  "completed",
  "failed",
  "cancelled"
]);

export const TERMINAL_STATES = Object.freeze(["completed", "failed", "cancelled"]);

/** States a worker may pick up: a fresh submission, or a run left by a process that died. */
export const CLAIMABLE_STATES = Object.freeze(["queued", "recovering"]);

/**
 * Open states that mean "some process was holding this". A task in one of these
 * with an expired lease is what a backend restart leaves behind, and it is what
 * recovery looks for.
 */
export const EXECUTING_STATES = Object.freeze([
  "planning",
  "running",
  "executing_tool",
  "retrying",
  "verifying",
  "recovering"
]);

/** Open states that are not consuming a worker: waiting on a person or on the scheduler. */
export const PARKED_STATES = Object.freeze(["queued", "waiting_for_user", "waiting_for_permission", "paused"]);

const TRANSITIONS = Object.freeze({
  queued: Object.freeze(["planning", "running", "failed", "cancelled"]),
  planning: Object.freeze([
    "running", "retrying", "waiting_for_user", "waiting_for_permission", "paused", "recovering", "failed", "cancelled"
  ]),
  running: Object.freeze([
    "executing_tool", "retrying", "waiting_for_user", "waiting_for_permission",
    "verifying", "planning", "paused", "recovering", "failed", "cancelled"
  ]),
  executing_tool: Object.freeze([
    "running", "retrying", "waiting_for_permission", "waiting_for_user",
    "verifying", "paused", "recovering", "failed", "cancelled"
  ]),
  retrying: Object.freeze([
    "running", "executing_tool", "planning", "waiting_for_user", "waiting_for_permission",
    "paused", "recovering", "failed", "cancelled"
  ]),
  waiting_for_user: Object.freeze(["queued", "planning", "running", "executing_tool", "paused", "failed", "cancelled"]),
  waiting_for_permission: Object.freeze(["queued", "running", "executing_tool", "paused", "failed", "cancelled"]),
  paused: Object.freeze([
    "queued", "planning", "running", "executing_tool", "recovering",
    "waiting_for_user", "waiting_for_permission", "cancelled"
  ]),
  recovering: Object.freeze([
    "planning", "running", "executing_tool", "retrying", "verifying",
    "waiting_for_user", "waiting_for_permission", "paused", "failed", "cancelled"
  ]),
  verifying: Object.freeze(["completed", "running", "retrying", "recovering", "failed", "cancelled"]),
  completed: Object.freeze([]),
  failed: Object.freeze([]),
  cancelled: Object.freeze([])
});

export class TaskStateError extends Error {
  constructor(message, code, from, to) {
    super(message);
    this.name = "TaskStateError";
    this.code = code;
    this.from = from;
    this.to = to;
  }
}

export function isTaskState(value) {
  return TASK_STATES.includes(value);
}

export function isTerminal(value) {
  return TERMINAL_STATES.includes(value);
}

export function outgoingStates(from) {
  return TRANSITIONS[from] ?? [];
}

export function canTransition(from, to) {
  if (!isTaskState(from) || !isTaskState(to)) return false;
  return outgoingStates(from).includes(to);
}

/**
 * The guard every state write goes through. An unknown state is a bug in the
 * caller and says so; a known state reached from a state that cannot lead to it
 * is recorded as an illegal transition and rejected.
 */
export function assertTransition(from, to) {
  if (!isTaskState(to)) {
    throw new TaskStateError(`Unknown task state "${to}".`, "unknown_state", from, to);
  }
  if (!isTaskState(from)) {
    throw new TaskStateError(`Task is in unknown state "${from}"; cannot move to "${to}".`, "unknown_state", from, to);
  }
  if (isTerminal(from)) {
    throw new TaskStateError(
      `Task already ${from}; ${to} would restart a finished task.`,
      "task_terminal",
      from,
      to
    );
  }
  if (!outgoingStates(from).includes(to)) {
    throw new TaskStateError(`Illegal task transition ${from} -> ${to}.`, "illegal_transition", from, to);
  }
  return true;
}

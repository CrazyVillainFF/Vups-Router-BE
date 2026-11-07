import crypto from "node:crypto";
import mongoose from "mongoose";
import { MAX_PROGRESS_EVENTS, progressEventSchema } from "./taskRun.js";
import { TASK_STATES, TERMINAL_STATES } from "./taskState.js";

/**
 * The durable record of one task (Phase 1.2).
 *
 * This is the document that makes a task outlive the thing that started it: a
 * request, a socket, a mounted screen, a phone screen or a worker process. A
 * "task" used to be a coroutine inside an HTTP handler, with the only record of
 * it living for ten idle minutes; here the record is the authority, and every
 * field in it describes work the server actually did.
 *
 * Nothing is stored that the server did not observe: plan steps move when the
 * worker really reaches them, model requests are the calls that were sent, tool
 * operations are the calls that were handed over, and an event row is written
 * only for a phase that started. The one thing this table does not keep is
 * provider credentials — a model request is referenced by id, model name and
 * host, never by key.
 */

export const TASK_ID_PREFIX = "tsk_";
export const TASK_ID_PATTERN = /^tsk_[0-9a-f]{24}$/;
export const MAX_TASK_DESCRIPTION_CHARS = 20000;
export const MAX_TASK_MESSAGE_CHARS = 20000;
export const MAX_EVENT_MESSAGE_CHARS = 240;
// Progress rows are capped the same way the desktop run caps them today, so the
// one existing bound carries over instead of a second, softer one being invented.
export const MAX_TASK_EVENTS = MAX_PROGRESS_EVENTS;
export const CLARIFICATION_ID_PREFIX = "clr_";
export const CLARIFICATION_ID_PATTERN = /^clr_[0-9a-f]{24}$/;
export const MAX_CLARIFICATION_QUESTION_CHARS = 2000;
export const MAX_CLARIFICATION_ANSWER_CHARS = 4000;
export const MAX_CLARIFICATION_OPTIONS = 8;
export const MAX_CLARIFICATION_OPTION_CHARS = 200;
export const MAX_CLARIFICATIONS_KEPT = 20;

// A finished task keeps its record for a while so the task centre can show
// history; an open task never expires, because expiry would delete a task that
// is still waiting for a person.
export const TASK_RETENTION_MS = (() => {
  const days = Number(process.env.TASK_RETENTION_DAYS);
  return (Number.isFinite(days) && days > 0 ? days : 30) * 24 * 60 * 60 * 1000;
})();

export function newTaskId() {
  return `${TASK_ID_PREFIX}${crypto.randomBytes(12).toString("hex")}`;
}

export function validTaskId(value) {
  return typeof value === "string" && TASK_ID_PATTERN.test(value.trim());
}

// The same id style as a task id, because a clarification is addressed in a URL
// and has to be recognisable as ours rather than as anything a client invented.
export function newClarificationId() {
  return `${CLARIFICATION_ID_PREFIX}${crypto.randomBytes(12).toString("hex")}`;
}

export function validClarificationId(value) {
  return typeof value === "string" && CLARIFICATION_ID_PATTERN.test(value.trim());
}

const planStepSchema = new mongoose.Schema({
  id: { type: String, required: true, maxlength: 40 },
  title: { type: String, default: "", maxlength: 200 },
  // "blocked" means this step is waiting on another step or on a person; it is
  // not a state the worker has reached.
  status: {
    type: String,
    enum: ["pending", "running", "completed", "failed", "skipped", "blocked"],
    default: "pending"
  },
  detail: { type: String, default: "", maxlength: MAX_EVENT_MESSAGE_CHARS },
  startedAt: { type: Date, default: null },
  completedAt: { type: Date, default: null }
}, { _id: false });

const modelRequestSchema = new mongoose.Schema({
  requestId: { type: String, default: "", maxlength: 80 },
  attempt: { type: Number, default: 1 },
  model: { type: String, default: "", maxlength: 120 },
  provider: { type: String, default: "", maxlength: 60 },
  host: { type: String, default: "", maxlength: 120 },
  status: { type: String, enum: ["running", "completed", "failed", "cancelled"], default: "running" },
  code: { type: String, default: "", maxlength: 60 },
  finishReason: { type: String, default: "", maxlength: 40 },
  startedAt: { type: Date, default: null },
  endedAt: { type: Date, default: null }
}, { _id: false });

const toolOperationSchema = new mongoose.Schema({
  // The durable identity that makes a retry safe: an operation is created once,
  // reported once, and a second report for the same id is ignored.
  operationId: { type: String, required: true, maxlength: 80 },
  callId: { type: String, default: "", maxlength: 120 },
  tool: { type: String, default: "", maxlength: 60 },
  path: { type: String, default: "", maxlength: 200 },
  status: {
    type: String,
    enum: ["pending", "running", "completed", "failed", "denied", "cancelled", "unknown"],
    default: "pending"
  },
  attempts: { type: Number, default: 0 },
  code: { type: String, default: "", maxlength: 60 },
  startedAt: { type: Date, default: null },
  completedAt: { type: Date, default: null }
}, { _id: false });

const clarificationSchema = new mongoose.Schema({
  clarificationId: { type: String, required: true, maxlength: 80 },
  question: { type: String, default: "", maxlength: MAX_CLARIFICATION_QUESTION_CHARS },
  // The bounds a question is actually held to are enforced where the row is
  // built, not here: a provider that over-ships its options must be trimmed into
  // shape rather than rejected, and a rejected write would fail the task that
  // only asked a long question.
  options: { type: [String], default: [] },
  status: { type: String, enum: ["pending", "answered", "superseded"], default: "pending" },
  answer: { type: String, default: "", maxlength: MAX_CLARIFICATION_ANSWER_CHARS },
  blockedSteps: { type: [String], default: [] },
  // The two conversation rows this question owns. Minted with the row so a
  // retried answer writes the same pair once instead of a second pair.
  askedMessageId: { type: String, default: "", maxlength: 80 },
  answeredMessageId: { type: String, default: "", maxlength: 80 },
  askedAt: { type: Date, default: null },
  answeredAt: { type: Date, default: null }
}, { _id: false });

const activeOperationSchema = new mongoose.Schema({
  kind: { type: String, enum: ["none", "provider", "tool", "approval", "clarification"], default: "none" },
  operationId: { type: String, default: "", maxlength: 80 },
  tool: { type: String, default: "", maxlength: 60 },
  callId: { type: String, default: "", maxlength: 120 },
  stage: { type: String, default: "", maxlength: 60 },
  startedAt: { type: Date, default: null },
  expiresAt: { type: Date, default: null }
}, { _id: false });

const retrySchema = new mongoose.Schema({
  attempts: { type: Number, default: 0 },
  maxAttempts: { type: Number, default: 0 },
  nextAttemptAt: { type: Date, default: null },
  lastCode: { type: String, default: "", maxlength: 60 },
  // Which class of provider failure is being waited out, from the shared
  // taxonomy. A retry of a busy model and a retry of a network drop are not the
  // same story, and the record has to be able to tell them apart.
  lastCategory: { type: String, default: "", maxlength: 40 },
  lastMessage: { type: String, default: "", maxlength: MAX_EVENT_MESSAGE_CHARS },
  lastErrorAt: { type: Date, default: null },
  retryAfterMs: { type: Number, default: 0 },
  // The policy the worker applied, so a report can say which rule retried a call
  // rather than only that something happened.
  policy: { type: String, default: "", maxlength: 60 }
}, { _id: false });

const errorSchema = new mongoose.Schema({
  code: { type: String, default: "", maxlength: 60 },
  message: { type: String, default: "", maxlength: 500 },
  kind: { type: String, default: "", maxlength: 40 },
  retryable: { type: Boolean, default: false },
  providerStatus: { type: Number, default: null },
  at: { type: Date, default: null }
}, { _id: false });

const recoverySchema = new mongoose.Schema({
  interruptedAt: { type: Date, default: null },
  reason: { type: String, default: "", maxlength: 120 },
  stateBeforeInterruption: { type: String, enum: TASK_STATES, default: null },
  restarts: { type: Number, default: 0 },
  resumedAt: { type: Date, default: null },
  reconciledAt: { type: Date, default: null }
}, { _id: false });

const leaseSchema = new mongoose.Schema({
  owner: { type: String, default: "", maxlength: 80 },
  claimedAt: { type: Date, default: null },
  heartbeatAt: { type: Date, default: null },
  expiresAt: { type: Date, default: null }
}, { _id: false });

const requestSchema = new mongoose.Schema({
  // The selection the user made, not the resolved key: a task re-resolves its
  // provider when it runs, so a rotated key is picked up and no secret is stored.
  model: { type: String, default: "", maxlength: 120 },
  configId: { type: String, default: "", maxlength: 80 },
  providerId: { type: String, default: "", maxlength: 80 },
  source: { type: String, default: "", maxlength: 20 },
  mode: { type: String, default: "general", maxlength: 20 },
  temperature: { type: Number, default: null },
  vups: { type: Boolean, default: false },
  workspacePath: { type: String, default: "", maxlength: 200 },
  // The two message ids this task owns. Keeping them on the record is what lets
  // a recovered run rewrite its own turn instead of writing a second one.
  userMessageId: { type: String, default: "", maxlength: 80 },
  assistantMessageId: { type: String, default: "", maxlength: 80 },
  // The daily quota is spent once per task, not once per attempt, so a recovery
  // must be able to see that it already paid.
  quotaConsumed: { type: Boolean, default: false }
}, { _id: false });

const resultSchema = new mongoose.Schema({
  messageId: { type: String, default: "", maxlength: 80 },
  // A short projection only. The answer itself belongs to the conversation, so a
  // resumed run rewrites the message it owns instead of writing a second one.
  summary: { type: String, default: "", maxlength: 500 },
  finishReason: { type: String, default: "", maxlength: 40 }
}, { _id: false });

const taskSchema = new mongoose.Schema({
  taskId: { type: String, required: true, unique: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  conversationId: { type: String, default: "" },
  description: { type: String, default: "", maxlength: MAX_TASK_DESCRIPTION_CHARS },
  state: { type: String, enum: TASK_STATES, default: "queued", required: true },
  stage: { type: String, default: "queued", maxlength: 60 },
  plan: { type: [planStepSchema], default: [] },
  events: { type: [progressEventSchema], default: [] },
  activeOperation: { type: activeOperationSchema, default: () => ({}) },
  modelRequests: { type: [modelRequestSchema], default: [] },
  toolOperations: { type: [toolOperationSchema], default: [] },
  clarifications: { type: [clarificationSchema], default: [] },
  retry: { type: retrySchema, default: () => ({}) },
  error: { type: errorSchema, default: () => ({}) },
  recovery: { type: recoverySchema, default: () => ({}) },
  request: { type: requestSchema, default: () => ({}) },
  result: { type: resultSchema, default: () => ({}) },
  lease: { type: leaseSchema, default: () => ({}) },
  cancelRequestedAt: { type: Date, default: null },
  cancelRequestedBy: { type: String, default: "", maxlength: 40 },
  steps: { type: Number, default: 0 },
  startedAt: { type: Date, default: null },
  // Wall clock of the last thing the task did, kept in milliseconds so a client
  // can order a list without parsing dates.
  lastActivityAt: { type: Number, default: () => Date.now() },
  completedAt: { type: Date, default: null },
  expiresAt: { type: Date, default: null }
}, { timestamps: true, versionKey: false });

taskSchema.index({ userId: 1, state: 1, lastActivityAt: -1 });
taskSchema.index({ userId: 1, createdAt: -1 });
taskSchema.index({ state: 1, "lease.expiresAt": 1 });
// Only terminal tasks ever get an expiry, so an open or waiting task cannot be
// collected out from under the user.
taskSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, partialFilterExpression: { expiresAt: { $type: "date" } } });

const Task = mongoose.models.Task || mongoose.model("Task", taskSchema);

export { TERMINAL_STATES, TASK_STATES };
export default Task;

import mongoose from "mongoose";

// One document per desktop tool run: the round budget, the calls handed to the
// app that have not reported back yet, and the progress log the user sees. This
// used to live in a process-local Map, so a restart or a second instance erased
// a task that the desktop client was still continuing.
export const MAX_PROGRESS_EVENTS = 80;
export const MAX_PROGRESS_MESSAGE_CHARS = 180;
export const MAX_PROGRESS_PATH_CHARS = 200;
export const PROGRESS_STATUSES = Object.freeze(["running", "completed", "failed", "cancelled"]);
export const PROGRESS_PHASES = Object.freeze(["task", "tool", "provider", "answer"]);

export const progressEventSchema = new mongoose.Schema({
  seq: { type: Number, required: true },
  at: { type: Date, default: Date.now },
  phase: { type: String, required: true, maxlength: 20 },
  status: { type: String, enum: PROGRESS_STATUSES, default: "completed" },
  message: { type: String, maxlength: MAX_PROGRESS_MESSAGE_CHARS, default: "" },
  tool: { type: String, maxlength: 60, default: "" },
  path: { type: String, maxlength: MAX_PROGRESS_PATH_CHARS, default: "" },
  code: { type: String, maxlength: 60, default: "" },
  callId: { type: String, maxlength: 120, default: "" },
  // Identity for the rows that are not a tool call — "this round asked the
  // model". The app announces the same key before the round is even answered,
  // so the waiting line and its recorded event are one line, not two.
  key: { type: String, maxlength: 40, default: "" },
  // Which question this row announces. The progress log is a bounded window, so
  // the row is only ever a pointer: the question itself lives in the task's
  // clarifications and cannot be trimmed out of the app's view of it.
  clarificationId: { type: String, maxlength: 80, default: "" }
}, { _id: false });

const pendingCallSchema = new mongoose.Schema({
  id: { type: String, required: true, maxlength: 120 },
  tool: { type: String, default: "", maxlength: 60 },
  path: { type: String, default: "", maxlength: MAX_PROGRESS_PATH_CHARS }
}, { _id: false });

const taskRunSchema = new mongoose.Schema({
  runId: { type: String, required: true, unique: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  conversationId: { type: String, default: "" },
  // The folder the Windows app actually bound to this turn, reported by the app
  // itself. Only the path is kept, never a listing or the files inside it.
  workspacePath: { type: String, default: "", maxlength: MAX_PROGRESS_PATH_CHARS },
  steps: { type: Number, default: 0 },
  busy: { type: Boolean, default: false },
  nudged: { type: Boolean, default: false },
  continued: { type: Boolean, default: false },
  quotaConsumed: { type: Boolean, default: false },
  // Wall clock of the last accepted round. Idleness, not total age, is what
  // expires a run: a long build or a slow approval must not delete its own run.
  lastUsedAt: { type: Number, default: Date.now },
  pending: { type: [pendingCallSchema], default: [] },
  events: { type: [progressEventSchema], default: [] },
  expiresAt: { type: Date, required: true }
}, { timestamps: true, versionKey: false });

// The TTL index is a cleanup backstop; the route checks expiresAt itself so an
// expired run is rejected the moment it expires, not when Mongo evicts it.
taskRunSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
taskRunSchema.index({ userId: 1, updatedAt: -1 });

const TaskRun = mongoose.models.TaskRun || mongoose.model("TaskRun", taskRunSchema);

export default TaskRun;

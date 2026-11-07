import { Router } from "express";
import mongoose from "mongoose";
import connectToDatabase from "../db.js";
import { chatRateLimiter, requireAuth } from "../middleware.js";
import { MAX_TASK_DESCRIPTION_CHARS, validClarificationId, validTaskId } from "../task.js";
import { TaskStateError, isTerminal } from "../taskState.js";
import {
  TaskNotFoundError,
  TaskStoppedError,
  cancelTask,
  createTask,
  listTasks,
  requireTask,
  taskDetail,
  taskEventsAfter,
  taskSummary,
  transition
} from "../taskStore.js";
import {
  ClarificationError,
  answerClarification,
  pendingClarificationOf,
  pendingClarificationPayload
} from "../taskClarification.js";
import { abortTask } from "../taskWorker.js";
import { progressText } from "../taskEvents.js";

/**
 * The task API (Phase 1.1/1.2).
 *
 * Submitting returns as soon as the durable record exists. Nothing in this file
 * holds the work: no provider call happens here, no socket owns a task, and no
 * response waits for a run to finish. That is what makes leaving the screen,
 * switching chats or minimising the app a change of attention rather than a
 * cancellation — the client that submitted a task is only ever a viewer of it.
 *
 * Ownership is a query filter on every read, so another account's task is not
 * forbidden but absent: it returns 404, the same as one that never existed.
 */

const router = Router();

const RESUMABLE_STATES = ["paused", "waiting_for_user", "waiting_for_permission"];
const MAX_MESSAGE_ID_CHARS = 80;

router.use(requireAuth);

function newMessageId() {
  return String(new mongoose.Types.ObjectId());
}

function textBody(value, limit = MAX_MESSAGE_ID_CHARS) {
  return typeof value === "string" ? progressText(value, limit) : "";
}

function taskField(task) {
  return { task: withClarification(taskSummary(task), task, { full: false }) };
}

/** The full record, for the screen that shows the question and takes the answer. */
function taskDetailField(task) {
  return { task: withClarification(taskDetail(task), task, { full: true }) };
}

/**
 * The question this task is waiting on, beside the record it belongs to.
 *
 * It travels with the task rather than only with the event log because a
 * question is up to 2,000 characters and a progress row is capped far below
 * that; truncating the model's question into a status line would show the user
 * an instruction they could not actually answer.
 */
function withClarification(record, task, { full }) {
  return { ...record, pendingClarification: pendingClarificationPayload(task, { full }) };
}

/**
 * The one description of what a task asked for. A provider key is never part of
 * it: the worker re-resolves the selection when it runs, so a rotated key is
 * picked up and nothing secret is stored.
 */
function requestFrom(body) {
  const mode = textBody(body?.mode, 20) || "general";
  const temperature = Number(body?.temperature);
  return {
    model: textBody(body?.model, 120),
    configId: textBody(body?.configId, 80),
    providerId: textBody(body?.providerId, 80),
    source: textBody(body?.source, 20),
    mode,
    temperature: Number.isFinite(temperature) ? temperature : null,
    vups: body?.vups === true,
    workspacePath: textBody(body?.workspacePath, 200),
    userMessageId: newMessageId(),
    assistantMessageId: newMessageId(),
    quotaConsumed: false
  };
}

router.post("/", chatRateLimiter, async (req, res, next) => {
  try {
    // Only the outer whitespace goes: what the user typed is the instruction the
    // task runs on, including its line breaks.
    const prompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
    if (!prompt) {
      return res.status(400).json({ code: "invalid_prompt", message: "Say what the task should do." });
    }
    if (prompt.length > MAX_TASK_DESCRIPTION_CHARS) {
      return res.status(400).json({
        code: "invalid_prompt",
        message: `A task description must be ${MAX_TASK_DESCRIPTION_CHARS} characters or fewer.`
      });
    }
    const conversationId = textBody(req.body?.conversationId, 40);
    if (conversationId && !mongoose.isValidObjectId(conversationId)) {
      return res.status(400).json({ code: "invalid_conversation_id", message: "That conversation does not exist." });
    }
    await connectToDatabase();
    // The record is the whole response. A client that never comes back has lost
    // nothing: the task is already the server's to finish.
    const task = await createTask({
      userId: req.userId,
      description: prompt,
      ...(conversationId ? { conversationId } : {}),
      request: requestFrom(req.body)
    });
    return res.status(202).json(taskField(task));
  } catch (error) {
    return next(error);
  }
});

router.get("/", async (req, res, next) => {
  try {
    await connectToDatabase();
    const states = textBody(req.query?.state, 200).split(",").filter(Boolean);
    const tasks = await listTasks({ userId: req.userId, states, limit: Number(req.query?.limit) || 50 });
    return res.json({
      tasks: tasks.map(task => withClarification(taskSummary(task), task, { full: false }))
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/:taskId", async (req, res, next) => {
  try {
    if (!validTaskId(req.params.taskId)) {
      return res.status(400).json({ code: "invalid_task_id", message: "That task id is not one this server issued." });
    }
    await connectToDatabase();
    const task = await requireTask({ taskId: req.params.taskId, userId: req.userId });
    return res.json(taskDetailField(task));
  } catch (error) {
    if (error instanceof TaskNotFoundError) {
      return res.status(404).json({ code: "task_not_found", message: error.message });
    }
    return next(error);
  }
});

/**
 * Progress replay for a client that was away. The cursor is the event sequence,
 * so a reconnect asks for what it missed and cannot be shown a row twice.
 */
router.get("/:taskId/events", async (req, res, next) => {
  try {
    if (!validTaskId(req.params.taskId)) {
      return res.status(400).json({ code: "invalid_task_id", message: "That task id is not one this server issued." });
    }
    await connectToDatabase();
    const task = await requireTask({ taskId: req.params.taskId, userId: req.userId });
    const replay = taskEventsAfter(task, req.query?.after);
    return res.json({
      taskId: task.taskId,
      state: task.state,
      stage: task.stage || "",
      conversationId: task.conversationId || null,
      done: isTerminal(task.state),
      lastSeq: replay.lastSeq,
      // The question itself, not a "the model asked something" row: this is the
      // channel a reopening or sleeping client reads, and it has to be able to
      // show what is being waited for without a second request.
      pendingClarification: pendingClarificationPayload(task, { full: true }),
      events: replay.events
    });
  } catch (error) {
    if (error instanceof TaskNotFoundError) {
      return res.status(404).json({ code: "task_not_found", message: error.message });
    }
    return next(error);
  }
});

/**
 * The only user-facing way to stop a task. It is a recorded action, and the
 * in-flight model call is dropped because the user asked — not because a socket
 * closed. A task this process is not holding is still cancelled: the record is
 * the authority, and the holder finds it out at its next write.
 */
router.post("/:taskId/cancel", chatRateLimiter, async (req, res, next) => {
  try {
    if (!validTaskId(req.params.taskId)) {
      return res.status(400).json({ code: "invalid_task_id", message: "That task id is not one this server issued." });
    }
    await connectToDatabase();
    const { task } = await cancelTask({ taskId: req.params.taskId, userId: req.userId });
    abortTask(task.taskId);
    return res.json(taskDetailField(task));
  } catch (error) {
    if (error instanceof TaskNotFoundError) {
      return res.status(404).json({ code: "task_not_found", message: error.message });
    }
    return next(error);
  }
});

/**
 * Putting a waiting task back in the queue. A finished task refuses: restarting
 * history would run work the user already saw end, so that needs a new task.
 *
 * A task parked on a question does not resume here. It has one way out — the
 * answer route below — because queueing it without an answer would have the
 * model guess at the very thing it stopped to ask about.
 */
router.post("/:taskId/resume", chatRateLimiter, async (req, res, next) => {
  try {
    if (!validTaskId(req.params.taskId)) {
      return res.status(400).json({ code: "invalid_task_id", message: "That task id is not one this server issued." });
    }
    await connectToDatabase();
    const task = await requireTask({ taskId: req.params.taskId, userId: req.userId });
    if (!RESUMABLE_STATES.includes(task.state)) {
      // The state machine still decides; this only names what resume means here.
      if (isTerminal(task.state)) {
        return res.status(409).json({
          code: "task_terminal",
          message: `This task is ${task.state}. Start a new task to do it again.`
        });
      }
      return res.status(409).json({
        code: "state_conflict",
        message: `This task is ${task.state}; only a paused or waiting task can be resumed.`
      });
    }
    const asked = pendingClarificationOf(task);
    if (asked) {
      return res.status(409).json({
        code: "clarification_required",
        message: "This task is waiting for an answer, not a nudge. Reply to the question to carry on.",
        clarificationId: asked.clarificationId
      });
    }
    await transition(task, "queued", {
      stage: "queued",
      event: { phase: "task", status: "running", key: "queued", message: progressText("Queued again to carry on.") }
    });
    return res.json(taskDetailField(task));
  } catch (error) {
    if (error instanceof TaskNotFoundError) {
      return res.status(404).json({ code: "task_not_found", message: error.message });
    }
    if (error instanceof TaskStateError) {
      return res.status(409).json({ code: error.code, message: error.message });
    }
    return next(error);
  }
});

/**
 * Answering one question of one task (Phase 4).
 *
 * Ownership is the same filter as every other read: another account's task or
 * another account's question is not forbidden but absent. The answer, the
 * conversation rows and the queueing are decided together in answerClarification,
 * so a double click cannot put the same task in the queue twice.
 */
router.post("/:taskId/clarifications/:clarificationId/answer", chatRateLimiter, async (req, res, next) => {
  try {
    if (!validTaskId(req.params.taskId)) {
      return res.status(400).json({ code: "invalid_task_id", message: "That task id is not one this server issued." });
    }
    if (!validClarificationId(req.params.clarificationId)) {
      return res.status(400).json({
        code: "invalid_clarification_id",
        message: "That question id is not one this server issued."
      });
    }
    await connectToDatabase();
    const task = await requireTask({ taskId: req.params.taskId, userId: req.userId });
    const answered = await answerClarification({
      task,
      clarificationId: req.params.clarificationId,
      answer: req.body?.answer
    });
    return res.json(taskDetailField(answered));
  } catch (error) {
    if (error instanceof TaskNotFoundError) {
      return res.status(404).json({ code: "task_not_found", message: error.message });
    }
    if (error instanceof ClarificationError) {
      return res.status(error.status).json({ code: error.code, message: error.message });
    }
    if (error instanceof TaskStoppedError) {
      // The task left the parked state in the moment between the read and the
      // transition — a cancellation that landed while the answer was being
      // written. Its own code names it, and the answer did not run.
      return res.status(409).json({ code: error.code, message: error.message });
    }
    if (error instanceof TaskStateError) {
      return res.status(409).json({ code: error.code, message: error.message });
    }
    return next(error);
  }
});

export default router;

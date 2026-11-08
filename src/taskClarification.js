import mongoose from "mongoose";
import Conversation from "./conversation.js";
import Task, {
  MAX_CLARIFICATIONS_KEPT,
  MAX_CLARIFICATION_ANSWER_CHARS,
  MAX_CLARIFICATION_OPTION_CHARS,
  MAX_CLARIFICATION_OPTIONS,
  MAX_CLARIFICATION_QUESTION_CHARS,
  newClarificationId
} from "./task.js";
import { transition } from "./taskStore.js";
import { isTerminal } from "./taskState.js";

// A conversation keeps this many rows everywhere else it is written
// (routes/chat.js). A clarification pair is bounded the same way so answering a
// question cannot be the one write that lets the transcript grow past its cap.
const CONVERSATION_MESSAGE_CAP = 200;

/**
 * Mid-task clarification (Phase 4).
 *
 * A task that cannot go on without a human decision parks in
 * `waiting_for_user` and stops. It does not fail, does not time out and does not
 * pretend to be working: the question is stored on the task, the worker releases
 * its lease, and the task waits for as long as the person takes. Answering it
 * puts the same task back in the queue with the answer already in its
 * conversation, so the model continues a transcript rather than starting again.
 *
 * The question travels as one native tool call, `ask_user`, and nothing else:
 * prose markers are not a contract, and the desktop chat question flow deletes
 * its run and re-charges the quota, which is the opposite of a durable task.
 */

export const ASK_USER_TOOL_NAME = "ask_user";

/**
 * States in which a pending question may be answered.
 *
 * `waiting_for_user → paused` is a legal transition, so a person can pause a
 * task that is already holding a question. The question outlives the state it
 * was asked in: refusing the answer there leaves the task with no way forward,
 * because `/resume` also refuses any task holding a pending row. Both states are
 * parked and neither is claimable (CLAIMABLE_STATES is queued/recovering), so
 * answering either one queues the same task exactly once.
 */
export const ANSWERABLE_STATES = Object.freeze(["waiting_for_user", "paused"]);

export const TASK_CLARIFY_TOOLS = Object.freeze([
  {
    type: "function",
    function: {
      name: ASK_USER_TOOL_NAME,
      description:
        "Ask the user one question you cannot answer yourself, then stop. Use this only when a real decision or missing detail blocks the work. The user answers in the task centre, and this task continues later with that answer.",
      parameters: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "The one thing you need to know, in your own words. The user reads this verbatim."
          },
          options: {
            type: "array",
            items: { type: "string" },
            description: "Optional short choices the user can pick from, most likely first."
          },
          blocked_steps: {
            type: "array",
            items: { type: "string" },
            description: "The plan step ids this question is standing in the way of."
          }
        },
        required: ["question"],
        additionalProperties: false
      }
    }
  }
]);

// One sentence, added to the task's own system turn only when the tool is really
// being offered. It names no other tool and promises no tool result, because the
// task path executes nothing but this question.
export const CLARIFY_INSTRUCTION =
  "If a decision or a missing detail genuinely blocks the work, call ask_user with one question and stop; never invent the answer.";

/**
 * Only transports that carry real function calls can be asked to clarify. The
 * `text` protocol is written for the desktop tool set and would be told about
 * tool results it never gets, and the Qoder loop has its own tool contract; both
 * keep behaving exactly as they did before this feature existed.
 */
export function supportsClarificationTool(transport) {
  return transport === "openai_chat" || transport === "openai_responses" || transport === "anthropic";
}

function callName(call) {
  return String(call?.function?.name ?? call?.name ?? "");
}

function callArguments(call) {
  const raw = call?.function?.arguments ?? call?.args ?? call?.arguments;
  if (raw && typeof raw === "object") return raw;
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    // A truncated argument list is not a question. Saying so is the honest
    // answer; guessing what the model meant would park the task on a guess.
    return null;
  }
}

function textList(value, limit, count) {
  const items = Array.isArray(value) ? value : [];
  return items
    .map(item => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean)
    .slice(0, count)
    .map(item => item.slice(0, limit));
}

/**
 * The one reading of a model reply that means "I need to ask". It is
 * deliberately narrow: exactly one `ask_user` call and no answer text. Anything
 * else — two calls, another tool, or a real answer that also mentions a question
 * — is left to the existing behaviour, because this feature must not turn other
 * replies into parked tasks by inference.
 */
export function parseClarificationCall(result, { planStepIds = [] } = {}) {
  const calls = Array.isArray(result?.toolCalls) ? result.toolCalls : [];
  if (calls.length !== 1) return null;
  if (callName(calls[0]) !== ASK_USER_TOOL_NAME) return null;
  if (String(result?.content ?? "").trim()) return null;

  const args = callArguments(calls[0]);
  const question = typeof args?.question === "string" ? args.question.trim() : "";
  if (!question) return null;

  const known = new Set((Array.isArray(planStepIds) ? planStepIds : []).map(id => String(id)));
  const blockedSteps = textList(args.blocked_steps ?? args.blockedSteps, 40, 20).filter(id => known.has(id));

  return {
    question: question.slice(0, MAX_CLARIFICATION_QUESTION_CHARS),
    options: textList(args.options, MAX_CLARIFICATION_OPTION_CHARS, MAX_CLARIFICATION_OPTIONS),
    blockedSteps
  };
}

export function pendingClarificationOf(task) {
  return (task?.clarifications || []).find(row => row?.status === "pending") || null;
}

function messageId() {
  return String(new mongoose.Types.ObjectId());
}

/**
 * A new question row. Both conversation ids are minted here, with the row, so a
 * request that is sent twice — a double click, a retry, a second tab — writes
 * the same pair of messages once instead of appending a second copy each time.
 */
export function newClarificationRow(parsed, { at = new Date() } = {}) {
  return {
    clarificationId: newClarificationId(),
    question: parsed.question,
    options: parsed.options,
    status: "pending",
    answer: "",
    blockedSteps: parsed.blockedSteps,
    askedMessageId: messageId(),
    answeredMessageId: messageId(),
    askedAt: at,
    answeredAt: null
  };
}

/**
 * Park the task on the question. One write, through the state machine like every
 * other state change, and the caller returns immediately afterwards: the lease
 * is released by the worker's own exit, and a parked task must not be written by
 * anybody else until an answer arrives.
 */
export async function parkForClarification(task, parsed) {
  const row = newClarificationRow(parsed);
  const prior = (task.clarifications || []).map(item => ({
    ...item,
    // A question that was never answered is history by now, not a live gate:
    // one pending row per task is what makes the answer path unambiguous.
    ...(item.status === "pending" ? { status: "superseded" } : {})
  }));
  task.clarifications = [...prior, row].slice(-MAX_CLARIFICATIONS_KEPT);
  task.activeOperation = {
    kind: "clarification",
    operationId: row.clarificationId,
    startedAt: row.askedAt,
    expiresAt: null
  };
  return transition(task, "waiting_for_user", {
    stage: "awaiting_clarification",
    settle: { provider: "completed", tool: "cancelled" },
    events: [{
      phase: "task",
      status: "completed",
      key: "clarification",
      clarificationId: row.clarificationId,
      message: "The model asked you a question."
    }]
  });
}

/**
 * The question and its answer as two conversation rows. They go in before the
 * task is re-queued, so a resumed run reads a transcript that already contains
 * what the person said — and they are added by id, so replaying this cannot
 * double them or rewrite the rows around them.
 */
export async function recordClarificationExchange(task, row) {
  if (!task.conversationId || !mongoose.isValidObjectId(task.conversationId)) return false;
  const pairs = [
    { messageId: row.askedMessageId, role: "assistant", content: row.question },
    { messageId: row.answeredMessageId, role: "user", content: row.answer }
  ].filter(entry => entry.messageId && entry.content);
  if (pairs.length === 0) return true;

  const conversation = await Conversation.findOne({ _id: task.conversationId, userId: task.userId })
    .select("messages.messageId")
    .lean();
  if (!conversation) return false;
  const present = new Set((conversation.messages || []).map(message => String(message.messageId || "")));
  const missing = pairs.filter(entry => !present.has(entry.messageId));
  if (missing.length === 0) return true;

  // Bounded the way a conversation is bounded everywhere else: the oldest rows
  // fall off the front rather than the array growing without end.
  await Conversation.updateOne(
    { _id: task.conversationId, userId: task.userId },
    { $push: { messages: { $each: missing, $slice: -CONVERSATION_MESSAGE_CAP } } }
  );
  return true;
}

/** What an answer costs, and what it must not cost twice. */
export class ClarificationError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "ClarificationError";
    this.status = status;
    this.code = code;
  }
}

/**
 * Take one answer for one pending question and put the task back in the queue.
 *
 * The order is the whole design. The question row is closed by compare-and-set
 * first, so exactly one request can own this answer — a second tab, a double
 * click or a retried request loses it, and the task is never queued twice for
 * one question. The answer then goes into the conversation before the state
 * machine moves the task, so a re-claimed run always reads a transcript that
 * already contains what the person said, and never a queue ahead of its own
 * context.
 */
export async function answerClarification({ task, clarificationId, answer, now = new Date() }) {
  if (isTerminal(task.state)) {
    throw new ClarificationError(
      409,
      "task_terminal",
      `This task is ${task.state}. Start a new task to do it again.`
    );
  }
  if (!ANSWERABLE_STATES.includes(task.state)) {
    throw new ClarificationError(
      409,
      "state_conflict",
      `This task is ${task.state}; an answer only belongs to a task that is waiting for you.`
    );
  }
  const rows = task.clarifications || [];
  const index = rows.findIndex(row => String(row?.clarificationId) === String(clarificationId));
  if (index < 0) {
    throw new ClarificationError(409, "clarification_not_found", "That question is not part of this task.");
  }
  const row = rows[index];
  if (row.status !== "pending") {
    throw new ClarificationError(
      409,
      "clarification_answered",
      "That question already has its answer, so the task was already put back in the queue."
    );
  }
  const text = String(answer ?? "").trim();
  if (!text) {
    throw new ClarificationError(400, "answer_required", "Type an answer before sending it.");
  }
  if (text.length > MAX_CLARIFICATION_ANSWER_CHARS) {
    throw new ClarificationError(
      413,
      "answer_too_long",
      `An answer is up to ${MAX_CLARIFICATION_ANSWER_CHARS} characters.`
    );
  }

  const answered = { ...row, status: "answered", answer: text, answeredAt: now };
  const updated = await Task.updateOne(
    {
      taskId: task.taskId,
      state: task.state,
      [`clarifications.${index}.clarificationId`]: row.clarificationId,
      [`clarifications.${index}.status`]: "pending"
    },
    {
      $set: {
        [`clarifications.${index}.status`]: "answered",
        [`clarifications.${index}.answer`]: text,
        [`clarifications.${index}.answeredAt`]: now
      }
    }
  );
  if (updated.matchedCount === 0) {
    // The row moved under this request. Re-read and decide from what is stored:
    // a task that has already left the parked state is refused, because another
    // request finished this answer. A task that is *still* parked with an
    // answered row was left half-done — its conversation write or its state
    // write failed first time — and the two writes below are both safe to
    // repeat, so the answer is finished here instead of stranding the task.
    const fresh = await Task.findOne({ taskId: task.taskId }).lean();
    const stored = (fresh?.clarifications || []).find(item => item.clarificationId === row.clarificationId);
    if (stored?.status !== "answered" || !ANSWERABLE_STATES.includes(fresh.state)) {
      throw new ClarificationError(
        409,
        "clarification_answered",
        "That question already has its answer, so the task was already put back in the queue."
      );
    }
    Object.assign(task, fresh);
    answered.answer = String(stored.answer || text);
    answered.answeredAt = stored.answeredAt || now;
  }

  const recorded = await recordClarificationExchange(task, answered);
  if (!recorded) {
    // The answer is on the question but not yet in the conversation. Moving the
    // task now would run it against a transcript that does not contain it, so
    // the task stays parked and the same request can be sent again.
    throw new ClarificationError(
      500,
      "clarification_not_recorded",
      "Your answer could not be saved in this conversation, so the task has not been resumed. Try again."
    );
  }

  task.clarifications = (task.clarifications || []).map((item, position) =>
    position === index ? answered : item
  );
  task.activeOperation = { kind: "none" };
  return transition(task, "queued", {
    stage: "queued",
    events: [{
      phase: "task",
      status: "completed",
      key: "clarification_answered",
      clarificationId: row.clarificationId,
      message: "Your answer was saved and the task is queued to carry on."
    }]
  });
}

const LIST_QUESTION_CHARS = 160;

/**
 * The question in the shape the API sends it. A list row gets the first line so
 * the task centre can say what it is waiting for without shipping the whole
 * transcript to every row.
 */
export function clarificationPayload(row, { full = true } = {}) {
  if (!row) return null;
  return {
    clarificationId: row.clarificationId,
    question: full ? row.question : String(row.question || "").slice(0, LIST_QUESTION_CHARS),
    options: row.options || [],
    askedAt: row.askedAt || null,
    blockedSteps: row.blockedSteps || []
  };
}

export function pendingClarificationPayload(task, options) {
  return clarificationPayload(pendingClarificationOf(task), options);
}

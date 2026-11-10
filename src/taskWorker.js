import mongoose from "mongoose";
import connectToDatabase from "./db.js";
import Conversation from "./conversation.js";
import Task from "./task.js";
import { ProviderError, chatCompletion, toolTransportFor, withProviderRetry } from "./providerClient.js";
import { UsageError, consumeDailyQuota, maxConcurrency } from "./usage.js";
import {
  chatSystemPrompt,
  persistConversation,
  persistGeneratedTurn,
  providerFailure,
  recordUnansweredTurn,
  resolveChatProvider,
  vupsRetryOptions
} from "./routes/chat.js";
import {
  answerEvent,
  progressText,
  providerAttemptEvent,
  providerBackoffEvent,
  providerFailureEvent,
  taskStartedEvent
} from "./taskEvents.js";
import {
  TaskStoppedError,
  appendTaskEvents,
  cancelRequested,
  claimNextTask,
  heartbeatTask,
  markPlanStep,
  recordModelRequest,
  reconcileInterruptedTasks,
  releaseLease,
  saveTask,
  setPlan,
  setStage,
  transition,
  workerInstanceLabel
} from "./taskStore.js";
import { TERMINAL_STATES, isTerminal } from "./taskState.js";
import {
  CLARIFY_INSTRUCTION,
  TASK_CLARIFY_TOOLS,
  parseClarificationCall,
  parkForClarification,
  supportsClarificationTool
} from "./taskClarification.js";

/**
 * The task worker (Phase 1.1).
 *
 * This module is what owns a running task. It claims a durable task record,
 * does the work, and writes the result — and none of that is tied to a request,
 * a socket, a mounted screen or a visible app. A client that submits a task and
 * disconnects has not cancelled anything: it has only stopped watching.
 *
 * The lease is the ownership token. One process holds a task at a time and
 * extends the lease while it is really working, which is how an interrupted task
 * is recognised by the next reconciliation instead of being left "running" in
 * the database with nothing running it.
 */

export const PLAN_STEPS = Object.freeze([
  { id: "prepare", title: "Prepare the conversation and the model selection" },
  { id: "model", title: "Ask the selected model" },
  { id: "save", title: "Save the answer in the conversation" }
]);

export function taskLeaseMs() {
  const value = Number(process.env.TASK_LEASE_MS);
  return Number.isFinite(value) && value >= 1000 ? Math.floor(value) : 30000;
}

export function taskWorkerConcurrency() {
  const value = Number(process.env.TASK_WORKER_CONCURRENCY);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : maxConcurrency();
}

/**
 * How many of one user's tasks may be held at the same time, across every worker
 * process. The pool limit says how much work this machine does; this says how
 * much of it any one account may occupy, so a twenty-task backlog from one chat
 * cannot become everybody else's queue. Two is the default because the pool
 * defaults to three: one account never gets the whole of it.
 */
export function taskUserConcurrency() {
  const value = Number(process.env.TASK_USER_CONCURRENCY);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 2;
}

export function taskTickMs() {
  const value = Number(process.env.TASK_WORKER_TICK_MS);
  return Number.isFinite(value) && value >= 50 ? Math.floor(value) : 1000;
}

// Stopped tasks and recovered tasks both need to be recognised as "not mine any
// more", so the lease is what says so.
const LOST_LEASE_MS = 1000;
const inFlight = new Map();
let timer = null;
let shuttingDown = false;
let reconcilesDue = 0;
let claiming = false;

export function workerId() {
  return workerLabel;
}

const workerLabel = workerInstanceLabel();

// Recovery lives with the store, but a restart is the worker's concern, so the
// boot path reaches it through the module that owns the lifecycle.
export { reconcileInterruptedTasks };

export function runningTaskIds() {
  return [...inFlight.keys()];
}

/**
 * Look for work now rather than on the next tick.
 *
 * This is what a hand-off from the service that accepted a submission is worth: it shortens the wait
 * for the first claim pass to one request. It claims nothing by itself — `tick` answers the same way
 * it always does when a pass is already under way, and when no scheduler is running here it does
 * nothing at all, which is the correct answer on a Main-only process.
 */
export async function kickTaskWorker() {
  if (timer === null || shuttingDown) return false;
  await tick().catch(() => {});
  return true;
}

export function isTaskRunningLocally(taskId) {
  return inFlight.has(taskId);
}

export function startTaskWorker({ tickMs } = {}) {
  if (timer) return { owner: workerLabel, tickMs: taskTickMs() };
  shuttingDown = false;
  // The first thing a booting worker does is look for work a dead process left
  // behind. Without this an interrupted task waits for the periodic pass.
  reconcilesDue = 0;
  const interval = tickMs ?? taskTickMs();
  timer = setInterval(() => {
    tick().catch(() => {});
  }, interval);
  // The worker must never be the reason a process stays alive.
  timer.unref?.();
  tick().catch(() => {});
  return { owner: workerLabel, tickMs: interval };
}

export async function stopTaskWorker() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  shuttingDown = true;
  const held = [...inFlight.entries()];
  for (const [taskId, entry] of held) {
    // Stopping the process is not cancelling the task: the record stays open
    // with a lapsed lease, which is exactly what reconciliation recovers.
    entry.controller.abort();
    await markTaskInterrupted(entry.task, "worker_stopped").catch(() => {});
    inFlight.delete(taskId);
  }
  shuttingDown = false;
}

/**
 * Drop this process's claim so another boot can pick the task up again.
 *
 * Only the holder may say this, and only while the task is still open: an
 * unconditional write here would clear a lease another process is running under
 * and stamp recovery on a finished task, which is how one task ends up with two
 * workers and a history that says it was interrupted after it completed.
 */
export async function markTaskInterrupted(task, reason) {
  await Task.updateOne(
    { taskId: task.taskId, "lease.owner": workerLabel, state: { $nin: [...TERMINAL_STATES] } },
    {
      $set: {
        "lease.owner": "",
        "lease.expiresAt": new Date(Date.now() - LOST_LEASE_MS),
        "recovery.interruptedAt": new Date(),
        "recovery.reason": progressText(reason, 120),
        "recovery.stateBeforeInterruption": task.state,
        lastActivityAt: Date.now()
      }
    }
  );
}

async function tick() {
  if (shuttingDown || !process.env.MONGODB_URI) return;
  await connectToDatabase();
  // One pass at a time, because this loop waits on the database between claims.
  // A second pass started while the first is mid-claim counts the same held
  // tasks again, so a tick shorter than a claim round trip is enough to take
  // more work than either the pool limit or the per-user cap allows.
  if (claiming) return;
  claiming = true;
  try {
    // A periodic pass as well as a boot pass: a task whose holder died between
    // restarts still has to come back.
    if (reconcilesDue <= 0) {
      reconcilesDue = 30;
      await reconcileInterruptedTasks().catch(() => []);
    } else {
      reconcilesDue -= 1;
    }
    const capacity = taskWorkerConcurrency();
    const perUserLimit = taskUserConcurrency();
    while (!shuttingDown && inFlight.size < capacity) {
      // Tasks this process is already running are not candidates, even if the
      // row says otherwise: re-claiming one would run it twice here.
      const task = await claimNextTask({
        owner: workerLabel,
        leaseMs: taskLeaseMs(),
        perUserLimit,
        excludeTaskIds: [...inFlight.keys()]
      });
      if (!task) break;
      const controller = new AbortController();
      inFlight.set(task.taskId, { task, controller });
      executeTask(task, controller)
        .catch(error => {
          // The record says what happened; an unexpected throw must not become an
          // unhandled rejection that takes the process with it.
          if (process.env.NODE_ENV !== "test") {
            console.error(`[task-worker] ${task.taskId}: ${error?.message || error}`);
          }
        })
        .finally(() => inFlight.delete(task.taskId));
    }
  } finally {
    claiming = false;
  }
}

/**
 * Stop the provider call a task is waiting on. This is the only way a task ends
 * besides a real terminal condition, and it follows a recorded user action —
 * never a navigation, a closed socket or a hidden screen.
 */
export function abortTask(taskId) {
  const held = inFlight.get(taskId);
  if (!held) return false;
  held.controller.abort();
  return true;
}

async function safeAppend(task, events) {
  try {
    return await appendTaskEvents(task, events);
  } catch {
    // Progress recording must never change what a task does or reports.
    return [];
  }
}

/**
 * The messages this task runs on, read back from the conversation rather than
 * replayed from a client. The answer this task owns is left out, so a resumed
 * run rewrites its own message instead of appending a second one.
 */
async function buildTurn(task) {
  const ownedMessageId = task.request?.assistantMessageId || "";
  let history = [];
  if (task.conversationId && mongoose.isValidObjectId(task.conversationId)) {
    const found = await Conversation.findOne({ _id: task.conversationId, userId: task.userId })
      .select("messages")
      .lean();
    history = found?.messages ?? [];
  }
  const prior = history.filter(message => !ownedMessageId || message.messageId !== ownedMessageId);
  const userMessageId = task.request?.userMessageId || "";
  const alreadyWritten = Boolean(userMessageId) && prior.some(message => message.messageId === userMessageId);
  const messages = alreadyWritten
    ? prior
    : [...prior, { role: "user", content: task.description, ...(userMessageId ? { messageId: userMessageId } : {}) }];
  return { messages, userMessageWritten: alreadyWritten };
}

/**
 * The messages this task runs on. `clarify` is only true when `ask_user` is
 * actually going out with the request: a model that is not offered the tool must
 * not be told about it, and one that is offered it needs to know that a question
 * is a legitimate answer rather than a failure to reply.
 */
function upstreamFor(task, messages, { clarify = false } = {}) {
  const system = chatSystemPrompt(task.request?.mode, task.request?.vups);
  return [
    { role: "system", content: clarify ? `${system}\n${CLARIFY_INSTRUCTION}` : system },
    ...messages
  ];
}

function storedMessages(conversation, ownedMessageId) {
  return (conversation.messages || [])
    .filter(message => !ownedMessageId || message.messageId !== ownedMessageId)
    .filter(message => (message.role === "user" || message.role === "assistant") && typeof message.content === "string")
    .map(message => ({
      role: message.role,
      content: message.content,
      ...(message.messageId ? { messageId: message.messageId } : {})
    }));
}

function hostOf(baseUrl) {
  try {
    return new URL(String(baseUrl)).host.slice(0, 120);
  } catch {
    return "";
  }
}

/**
 * Run one task to a terminal state. Every branch ends the record in a state the
 * transition table allows, and no branch may report a completion that did not
 * happen.
 */
export async function executeTask(claimed, controllerOverride) {
  const controller = controllerOverride || new AbortController();
  const task = claimed;
  let turn = null;
  // The lease renewal is the only thing that tells this process it has stopped
  // being the runner: another worker may take a task the moment a lease lapses,
  // and a zombie that keeps working writes — and finishes — a task it no longer
  // owns. Losing the renewal is therefore an execution stop, not a log line.
  let lostLease = false;
  const heartbeat = setInterval(() => {
    heartbeatTask(task, { owner: workerLabel, leaseMs: taskLeaseMs() })
      .then(renewed => {
        if (renewed === false && !lostLease) {
          lostLease = true;
          controller.abort();
        }
      })
      .catch(() => {});
    // The same beat reads the one thing a peer service can only write. A cancellation always
    // reaches the record first — the cancel route owns that transition — and this is what lets a
    // run held here stop because of it even when the process the user talked to is not this one
    // and the interrupt request between them never arrived.
    cancelRequested(task.taskId)
      .then(status => {
        if (status.cancelled) controller.abort();
      })
      .catch(() => {});
  }, Math.max(1000, Math.floor(taskLeaseMs() / 3)));
  const assistantMessageId = task.request?.assistantMessageId || undefined;

  try {
    if (isTerminal(task.state)) return task;

    if (task.state === "queued") {
      await setPlan(task, PLAN_STEPS.map(step => ({ ...step, status: "pending" })));
      await transition(task, "planning", {
        stage: "preparing",
        events: [
          taskStartedEvent(task.request?.workspacePath || ""),
          {
            phase: "task",
            status: "running",
            key: "planning",
            message: progressText("Preparing the conversation and the model selection.")
          }
        ]
      });
    } else {
      // A recovered run comes back through the front door: it re-reads the
      // conversation and re-resolves the model selection, but keeps the plan and
      // the steps it already recorded, so nothing already done is done twice.
      await transition(task, "planning", {
        stage: "preparing",
        events: [{
          phase: "task",
          status: "running",
          key: "resuming",
          message: progressText("Resuming this task after an interruption.")
        }]
      });
    }

    await markPlanStep(task, "prepare", "running");
    let provider;
    let model;
    try {
      const resolved = await resolveChatProvider(task.userId, task.request || {});
      provider = resolved.provider;
      model = resolved.model;
    } catch (error) {
      await markPlanStep(task, "prepare", "failed", error?.code || "provider_unavailable");
      return await failTask(task, error, {});
    }

    // Whether this model can be handed `ask_user` at all is a property of the
    // transport, not of the model's confidence: a provider without native tool
    // calling gets exactly the request it got before this feature existed.
    const askCanClarify = supportsClarificationTool(toolTransportFor(provider, model));

    turn = await buildTurn(task);
    // Nothing slow happens before the user's message is on disk, so every way a
    // task can end still leaves a conversation that can explain itself.
    const conversation = await persistConversation(task.userId, task.conversationId || null, turn.messages, null);
    if (String(task.conversationId || "") !== String(conversation._id)) {
      task.conversationId = String(conversation._id);
      await saveTask(task);
    }
    turn.messages = storedMessages(conversation, assistantMessageId);
    turn.upstream = upstreamFor(task, turn.messages, { clarify: askCanClarify });

    if (task.request?.quotaConsumed !== true) {
      try {
        await consumeDailyQuota(task.userId);
        task.request = { ...(task.request || {}), quotaConsumed: true };
        await saveTask(task);
      } catch (error) {
        if (error instanceof UsageError) {
          await markPlanStep(task, "prepare", "failed", error.code);
          return await failTask(task, error, { turn });
        }
        throw error;
      }
    }

    await markPlanStep(task, "prepare", "completed");
    task.steps = (task.steps || 0) + 1;
    await transition(task, "running", {
      stage: "model_request",
      events: [providerAttemptEvent({ attempt: 1, step: task.steps })]
    });
    await setStage(task, "model_request", {
      kind: "provider",
      operationId: `provider:${task.taskId}:${task.steps}`,
      stage: "model_request",
      startedAt: new Date(),
      expiresAt: null
    });

    const policy = vupsRetryOptions();
    const requestId = `task-${task.taskId}`;
    const providerLabel = provider.providerId || provider.providerType || "";
    const host = hostOf(provider.baseUrl);
    let attempts = 1;
    const askModel = () => withProviderRetry(
      async attempt => {
        attempts = attempt + 1;
        if (attempt > 0) {
          // The wait is over and a real request is about to go out, so the task
          // is running again rather than retrying. The state machine — not a
          // progress string — is what keeps those two apart.
          await transition(task, "running", {
            stage: "model_request",
            events: [providerAttemptEvent({
              attempt: attempts,
              step: task.steps,
              code: task.retry?.lastCode || ""
            })]
          });
        }
        await recordModelRequest(task, {
          requestId,
          attempt: attempts,
          model,
          provider: providerLabel,
          host,
          status: "running",
          startedAt: new Date()
        });
        return chatCompletion(
          {
            baseUrl: provider.baseUrl,
            authMode: provider.authMode,
            openapiBaseUrl: provider.openapiBaseUrl,
            apiKey: provider.apiKey,
            providerType: provider.providerType,
            model,
            messages: turn.upstream,
            temperature: task.request?.temperature ?? undefined,
            maxTokens: provider.maxTokens,
            reasoning: provider.reasoning,
            conversationId: task.conversationId || task.taskId,
            requestId,
            attempt: attempts,
            // One tool, and no `tool_choice`: the model keeps the default
            // "auto", so a model that has nothing to ask answers exactly as it
            // did before. `toolChoice: "required"` would be the fake-clarification
            // shortcut, and it is not honest work.
            ...(askCanClarify ? { tools: TASK_CLARIFY_TOOLS } : {})
          },
          controller.signal
        );
      },
      {
        ...policy,
        signal: controller.signal,
        // Awaited, and its errors are allowed to escape: the backoff must not
        // start until the record says which attempt failed, why, and for how
        // long the task is waiting. A retry nobody wrote down is a retry that
        // cannot be explained afterwards — and a task that was cancelled while
        // the model was answering must stop here instead of sending another
        // request for a task that no longer exists.
        onRetry: async event => {
          const code = progressText(event.error?.code, 60);
          const category = event.error?.category || "";
          const delayMs = Math.max(0, Math.floor(event.delay || 0));
          const prior = (task.modelRequests || []).find(
            entry => entry.requestId === requestId && entry.attempt === event.attempt
          );
          await recordModelRequest(task, {
            requestId,
            attempt: event.attempt,
            model,
            provider: providerLabel,
            host,
            status: "failed",
            code,
            startedAt: prior?.startedAt,
            endedAt: new Date()
          });
          task.retry = {
            attempts: event.attempt,
            maxAttempts: policy.maxRetries + 1,
            nextAttemptAt: new Date(Date.now() + delayMs),
            lastCode: code,
            lastCategory: progressText(category, 40),
            lastMessage: progressText(event.error?.message, 240),
            lastErrorAt: new Date(),
            retryAfterMs: Number.isFinite(event.error?.retryAfter)
              ? Math.floor(event.error.retryAfter * 1000)
              : 0,
            policy: "provider_backoff"
          };
          await transition(task, "retrying", {
            stage: "provider_backoff",
            events: [providerBackoffEvent({
              step: task.steps,
              attempt: event.attempt,
              maxAttempts: policy.maxRetries + 1,
              delayMs,
              category,
              code
            })]
          });
        }
      }
    );

    await markPlanStep(task, "model", "running");
    let result;
    try {
      result = await askModel();
    } catch (error) {
      if (controller.signal.aborted) return await handleAborted(task, turn, { lostLease });
      if (error instanceof TaskStoppedError) throw error;
      if (error instanceof ProviderError) {
        const failure = providerFailure(provider, error);
        await recordModelRequest(task, {
          requestId,
          attempt: attempts,
          model,
          provider: providerLabel,
          host,
          status: "failed",
          code: failure.code,
          startedAt: new Date(),
          endedAt: new Date()
        });
        await markPlanStep(task, "model", "failed", failure.code);
        return await failTask(task, {
          code: failure.code,
          message: failure.message,
          status: failure.status,
          category: error.category,
          kind: error.category,
          retryable: error.retryable === true
        }, { turn });
      }
      await markPlanStep(task, "model", "failed", error?.code || "internal_error");
      return await failTask(task, { code: error?.code || "internal_error", message: error?.message }, { turn });
    }

    await recordModelRequest(task, {
      requestId,
      attempt: attempts,
      model,
      provider: providerLabel,
      host,
      status: "completed",
      finishReason: result.finishReason,
      startedAt: new Date(),
      endedAt: new Date()
    });
    await markPlanStep(task, "model", "completed");

    // The user may have cancelled while the model was answering. An answer that
    // arrives after that must not land in a conversation the user already ended.
    const status = await cancelRequested(task.taskId);
    if (status.cancelled) return await handleCancelled(task, turn);

    if (askCanClarify && result.toolTransport !== "text") {
      // Only a native call counts. A provider that rejected the tool contract
      // falls back to the desktop text protocol, whose markers belong to the
      // chat tool loop and not to this path — parking a task on a line of prose
      // would be exactly the invented state this feature must never create.
      const asked = parseClarificationCall(result, { planStepIds: (task.plan || []).map(step => step.id) });
      if (asked) {
        // The model stopped because it needed a decision, not because it failed.
        // The question and the parked state go in as one transition, and this
        // worker then exits: the lease is released by the block below, so a task
        // waiting on a person is held by no process and consumes no worker.
        await parkForClarification(task, asked);
        return task;
      }
    }

    const content = String(result.content || "").trim();
    if (!content) {
      await markPlanStep(task, "save", "failed", "empty_response");
      return await failTask(task, {
        code: "empty_response",
        message: "The model returned no answer for this task.",
        retryable: false
      }, { turn });
    }

    await transition(task, "verifying", {
      stage: "verifying",
      events: [{
        phase: "task",
        status: "running",
        key: "verifying",
        message: progressText("Checking the answer and saving it to the conversation.")
      }]
    });
    await markPlanStep(task, "save", "running");
    const saved = await persistGeneratedTurn({
      userId: task.userId,
      conversationId: task.conversationId,
      messages: turn.messages,
      fullText: content,
      messageId: assistantMessageId,
      finishReason: result.finishReason,
      failure: null,
      title: null,
      requestId,
      progress: (task.events || []).slice()
    });
    await markPlanStep(task, "save", "completed");
    task.result = {
      messageId: assistantMessageId ? String(assistantMessageId) : "",
      summary: progressText(saved.summary, 500),
      finishReason: progressText(result.finishReason, 40)
    };
    await transition(task, "completed", {
      stage: "done",
      error: null,
      settle: { task: "completed", provider: "completed", tool: "cancelled", answer: "completed", skill: "completed" },
      events: [answerEvent()]
    });
    return task;
  } catch (error) {
    if (error instanceof TaskStoppedError) {
      // Someone ended this task while it was running. Their state is the truth —
      // but a user cancellation still owes the conversation an answer-shaped row,
      // so a reload shows a cancelled turn instead of a message with no reply.
      if (error.state === "cancelled") return await handleCancelled(task, turn || { messages: [] });
      return task;
    }
    // A bug here still has to end the record honestly. Leaving it "running" with
    // nothing running it is the failure mode this whole layer exists to remove.
    return await failTask(task, {
      code: error?.code || "internal_error",
      message: error?.message || "The task stopped unexpectedly.",
      retryable: false
    }, { turn: null });
  } finally {
    clearInterval(heartbeat);
    // Every exit above is awaited, so this runs only once the outcome is on the
    // record. A `return <promise>` would reach here first, and dropping the
    // lease while the row still says "running" is what makes a task that has
    // already finished look abandoned: reconciliation moves it to "recovering",
    // the queue hands it back out, and one task asks the model twice.
    if (!isTerminal(task.state)) {
      await releaseLease(task, { owner: workerLabel }).catch(() => {});
    }
  }
}

/**
 * A task that ends because the provider could not answer. The record keeps the
 * machine-readable code and an actionable message — never a key or a header —
 * and the conversation keeps a failed turn so a reload shows what really
 * happened instead of a blank gap.
 */
async function failTask(task, error, context = {}) {
  const code = error?.code || "provider_error";
  const message = error?.message || "The model did not answer.";
  await safeAppend(task, [providerFailureEvent(code)]);
  if (context.turn) {
    await recordUnansweredTurn(
      task.userId,
      task.conversationId,
      context.turn.messages,
      task.request?.assistantMessageId,
      { code, message }
    ).catch(() => {});
  }
  await transition(task, "failed", {
    stage: "stopped",
    settle: { task: "failed", provider: "failed", tool: "cancelled", answer: "cancelled", skill: "cancelled" },
    error: {
      code,
      message,
      kind: error?.kind || error?.category || "",
      retryable: error?.retryable === true,
      providerStatus: Number.isFinite(error?.status) ? error.status : null
    }
  });
  return task;
}

/**
 * The user cancelled. The cancel endpoint moved the record and wrote the event;
 * this closes the conversation side so a reload shows an interrupted turn.
 */
async function handleCancelled(task, turn) {
  await recordUnansweredTurn(
    task.userId,
    task.conversationId,
    turn.messages,
    task.request?.assistantMessageId,
    { code: "client_aborted" }
  ).catch(() => {});
  task.state = "cancelled";
  return task;
}

/**
 * An abort that was not a user cancellation: either the cancellation landed a
 * moment before this read, or this process is shutting down. The second case
 * must not be written as a completion or a failure — it is an interruption, and
 * the task stays open for recovery.
 *
 * Losing the lease is a third case and the opposite one: the task is open and
 * somebody else owns it now, so this process has no right to say anything about
 * it at all. Writing an interruption here would clear the new holder's lease and
 * invite a third worker onto the same task.
 */
async function handleAborted(task, turn, { lostLease = false } = {}) {
  if (lostLease) return task;
  const status = await cancelRequested(task.taskId);
  if (status.state === null) {
    // The record is gone (deleted by a retention pass or by hand). Nothing to run.
    return task;
  }
  if (status.cancelled) return handleCancelled(task, turn);
  await markTaskInterrupted(task, "worker_aborted");
  return task;
}

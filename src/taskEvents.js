import TaskRun, {
  MAX_PROGRESS_EVENTS,
  MAX_PROGRESS_MESSAGE_CHARS,
  MAX_PROGRESS_PATH_CHARS
} from "./taskRun.js";

/**
 * Progress events describe work that actually happened: a call the model issued,
 * a result the app reported, a provider attempt, the final answer. Every field is
 * derived from payloads this route already receives and validates, so the log
 * cannot claim a step the run never took, and nothing here runs on a timer.
 */

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

// Which argument names the thing the user would recognise. "content" is
// deliberately absent: a write_file call carries the whole file and a read_file
// result carries its text, and neither belongs in a progress line that is stored
// and echoed back to the client.
const CALL_PATH_KEYS = Object.freeze(["path", "source", "directory", "query", "command", "url"]);
const RESULT_PATH_KEYS = Object.freeze(["path", "source", "directory", "destination"]);
// The two calls that put a skill package's own text in front of the model.
// list_skills only names what is installed, so it is deliberately absent.
const SKILL_TOOLS = Object.freeze(["use_skill", "read_skill_reference"]);

export function progressText(value, limit = MAX_PROGRESS_MESSAGE_CHARS) {
  const text = String(value ?? "").replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1)}…`;
}

export function progressPath(value) {
  return progressText(value, MAX_PROGRESS_PATH_CHARS);
}

function parseJson(value) {
  try {
    return JSON.parse(String(value ?? ""));
  } catch (error) {
    return null;
  }
}

function firstStringKey(source, keys) {
  if (!source || typeof source !== "object") return "";
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/** The tool and the target of one model-issued call, with no file contents. */
export function describeToolCall(call) {
  const tool = String(call?.function?.name ?? "").trim().slice(0, 60);
  const args = parseJson(call?.function?.arguments);
  return { tool, path: progressPath(firstStringKey(args, CALL_PATH_KEYS)), id: String(call?.id ?? "") };
}

function eventFields(event) {
  return {
    phase: String(event.phase ?? "tool").slice(0, 20),
    status: event.status === undefined ? "completed" : event.status,
    message: progressText(event.message),
    tool: String(event.tool ?? "").slice(0, 60),
    path: progressPath(event.path),
    code: String(event.code ?? "").slice(0, 60),
    callId: String(event.callId ?? "").slice(0, 120),
    key: String(event.key ?? "").slice(0, 40),
    clarificationId: String(event.clarificationId ?? "").slice(0, 80),
    at: event.at instanceof Date ? event.at : new Date()
  };
}

export function nextSeq(run) {
  const last = run?.events?.[run.events.length - 1];
  return Number.isFinite(last?.seq) ? last.seq + 1 : 1;
}

/**
 * Number and attach new events to the run, keeping only the most recent window.
 * Returns exactly the events that were added, so the same objects the client is
 * shown are the ones in the stored log.
 */
export function appendRunEvents(run, events = []) {
  const added = [];
  let seq = nextSeq(run);
  for (const event of events) {
    if (!event) continue;
    added.push({ ...eventFields(event), seq: seq++ });
  }
  if (added.length === 0) return added;
  run.events = [...(run.events || []), ...added].slice(-MAX_PROGRESS_EVENTS);
  return added;
}

/** One row per call the model asked for, marked as running until the app reports. */
export function toolCallEvents(toolCalls = []) {
  return toolCalls.map(call => {
    const { tool, path, id } = describeToolCall(call);
    return {
      phase: "tool",
      status: "running",
      tool,
      path,
      callId: id,
      message: path ? `${tool} ${path}` : tool
    };
  });
}

/**
 * The messages this turn added: everything after the last user message. The
 * desktop client resends the whole conversation every round, so a rule that
 * looks at older history would re-report work from a previous turn.
 */
function turnMessages(messages = []) {
  let start = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      start = index + 1;
      break;
    }
  }
  return messages.slice(start);
}

/** The calls named by this turn's assistant messages, by id. */
function callsById(messages = []) {
  const calls = new Map();
  for (const message of messages) {
    if (message?.role !== "assistant" || !Array.isArray(message.tool_calls)) continue;
    for (const call of message.tool_calls) {
      if (call?.id) calls.set(call.id, call);
    }
  }
  return calls;
}

function resultRow(call, payload) {
  const { tool, path: callPath, id } = describeToolCall(call);
  if (!tool) return null;
  const ok = payload?.ok === true;
  const code = ok ? "" : progressText(payload?.error?.code || "unknown", 60);
  const path = progressPath(ok ? firstStringKey(payload?.data, RESULT_PATH_KEYS) || callPath : callPath);
  return {
    phase: "tool",
    status: ok ? "completed" : "failed",
    tool,
    path,
    code,
    callId: id,
    message: ok ? `${tool} completed${path ? ` (${path})` : ""}` : `${tool} failed: ${code || "unknown"}`
  };
}

/**
 * The only row that may say a skill was used. It is built from the payload the
 * app returned for that call, so an instruction file that never arrived cannot
 * be reported as read: a failed call, a plain listing, and a payload that names
 * no package all produce nothing here.
 */
function skillEvent(tool, payload, callId = "") {
  if (!SKILL_TOOLS.includes(tool) || payload?.ok !== true) return null;
  const data = payload.data || {};
  const name = firstStringKey(data, ["name", "id"]);
  if (!name) return null;
  const bytes = Number.isFinite(Number(data.bytes)) ? Number(data.bytes) : 0;
  if (tool === "read_skill_reference") {
    const reference = firstStringKey(data, ["reference"]);
    if (!reference) return null;
    return {
      phase: "skill",
      status: "completed",
      tool,
      callId,
      message: progressText(`Read the ${name} reference ${reference} (${bytes} bytes)`)
    };
  }
  const version = firstStringKey(data, ["version"]);
  const references = Array.isArray(data.references) ? data.references.length : 0;
  return {
    phase: "skill",
    status: "completed",
    tool,
    callId,
    message: progressText(
      `Loaded the ${name}${version ? ` ${version}` : ""} instruction file ` +
        `(${bytes} bytes, ${references} reference file${references === 1 ? "" : "s"})`
    )
  };
}

/**
 * Pair the calls this run handed out with the results the app sent back and
 * settle the row the call already owns, so one operation is one line that moves
 * from running to completed or failed. The payload decides the outcome: a call
 * the app refused is recorded with its real code and never as a success.
 *
 * Calls that ran before the model was ever asked — the deterministic local fast
 * path — were never handed out by this run, so they own no row yet. They are
 * real Windows operations and get their own line from the result payload.
 */
export function settleToolResults(run, messages = []) {
  const pending = Array.isArray(run.pending) ? run.pending : [];
  const thisTurn = turnMessages(Array.isArray(messages) ? messages : []);
  const results = new Map();
  for (const message of thisTurn) {
    if (message?.role !== "tool" || !message.tool_call_id) continue;
    results.set(message.tool_call_id, message.content);
  }
  const added = [];
  const settled = new Set();
  for (const call of pending) {
    if (!results.has(call.id)) continue;
    settled.add(call.id);
    const payload = parseJson(results.get(call.id));
    const ok = payload?.ok === true;
    const code = ok ? "" : progressText(payload?.error?.code || "unknown", 60);
    const path = progressPath(
      ok ? firstStringKey(payload?.data, RESULT_PATH_KEYS) || call.path : call.path
    );
    const fields = {
      status: ok ? "completed" : "failed",
      code,
      path,
      message: ok
        ? `${call.tool} completed${path ? ` (${path})` : ""}`
        : `${call.tool} failed: ${code || "unknown"}`
    };
    const index = (run.events || []).findIndex(
      event => event.callId === call.id && event.status === "running"
    );
    if (index >= 0) {
      const row = { ...run.events[index], ...fields };
      run.events = run.events.map((event, position) => (position === index ? row : event));
      added.push(row);
    } else {
      // A round replayed against a run that lost its open rows still has to
      // record what the app reported, rather than dropping the only evidence.
      added.push(
        ...appendRunEvents(run, [
          { phase: "tool", tool: call.tool, path, callId: call.id, status: fields.status, code, message: fields.message }
        ])
      );
    }
    const skill = skillEvent(call.tool, payload, call.id);
    if (skill) added.push(...appendRunEvents(run, [skill]));
  }
  const known = new Set(
    [...(run.events || []).map(event => event.callId).filter(Boolean), ...settled]
  );
  const calls = callsById(thisTurn);
  const unowned = [...results.keys()].filter(id => !known.has(id));
  added.push(
    ...appendRunEvents(
      run,
      unowned.flatMap(id => {
        const payload = parseJson(results.get(id));
        const row = resultRow(calls.get(id), payload);
        if (!row) return [];
        const skill = skillEvent(row.tool, payload, id);
        return skill ? [row, skill] : [row];
      })
    )
  );
  return { events: added, remaining: pending.filter(call => !settled.has(call.id)) };
}

export function providerAttemptEvent({ attempt = 1, step = 0, code = "" } = {}) {
  const retried = attempt > 1;
  return {
    phase: "provider",
    status: "running",
    key: retried ? `provider:${step}:${attempt}` : `provider:${step}`,
    message: progressText(
      retried
        ? `The model call was busy; retrying it (attempt ${attempt})`
        : "Asking the model what to do next"
    ),
    // The machine-readable reason stays on the event. Raw provider text is not
    // copied here: it can carry request bodies, and the turn's own error path
    // already shows the user an actionable message.
    code: progressText(code, 60)
  };
}

/** How long a real wait is, in words a progress line can show. */
function waitText(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "a moment";
  if (ms < 1000) return `${Math.round(ms / 100) * 100}ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
}

// What each class of provider failure means to the person watching. The lines
// describe the cause the classifier proved; none of them promise an outcome.
const RETRY_CAUSES = Object.freeze({
  rate_limit_requests: "The model service has too many requests right now",
  rate_limit_tokens: "The model service has run out of tokens for this minute",
  concurrency_limit: "The model service is at its concurrent-task limit",
  session_busy: "The model is still finishing its previous reply",
  ambiguous_rate_limit: "The model service is throttling requests",
  overloaded: "The model is busy with other work",
  upstream_unavailable: "The model service is temporarily unavailable",
  provider_unavailable: "The model service could not be reached",
  connection_refused: "The model service did not accept the connection",
  network_error: "The connection to the model dropped",
  timeout: "The model took too long to answer",
  invalid_response: "The model answered in a way that could not be read",
  empty_response: "The model answered with nothing",
  empty_stream: "The model's answer stopped before it finished"
});

/**
 * The wait between two provider attempts. This row is only emitted by the retry
 * loop itself, with the delay it actually decided to sleep and the classification
 * it actually got, so a task that is not waiting never shows a waiting line.
 */
export function providerBackoffEvent({
  step = 0,
  attempt = 1,
  maxAttempts = 0,
  delayMs = 0,
  category = "",
  code = ""
} = {}) {
  const cause = RETRY_CAUSES[category] || "The model call failed";
  const next = Number.isFinite(maxAttempts) && maxAttempts > attempt
    ? `before attempt ${attempt + 1} of ${maxAttempts}`
    : "before the next attempt";
  return {
    phase: "provider",
    status: "running",
    key: `backoff:${step}:${attempt}`.slice(0, 40),
    code: progressText(code, 60),
    message: progressText(`${cause}. Waiting ${waitText(delayMs)} ${next}.`)
  };
}

export function providerFailureEvent(code) {
  return {
    phase: "provider",
    status: "failed",
    code: progressText(code || "provider_error", 60),
    message: progressText(`The model call failed: ${code || "provider_error"}`)
  };
}

export function taskStartedEvent(path = "") {
  return {
    phase: "task",
    status: "running",
    key: "task",
    path: progressPath(path),
    message: progressText(path ? `Working in ${path}` : "Starting the task")
  };
}

export function answerEvent() {
  return {
    phase: "answer",
    status: "completed",
    key: "answer",
    message: "Writing up what actually happened"
  };
}

export function cancelledEvent(message = "The task was stopped") {
  return { phase: "task", status: "cancelled", message: progressText(message) };
}

/**
 * Rows still marked running when a turn ends are settled per phase, so a
 * replayed log never shows work that is not happening. A tool the app never
 * reported is closed as cancelled, not completed — that is what really happened.
 */
export function closeRunningEvents(run, statuses = {}) {
  const changed = [];
  run.events = (run.events || []).map(event => {
    if (event.status !== "running") return event;
    const status = statuses[event.phase];
    if (!status) return event;
    const settled = { ...event, status };
    changed.push(settled);
    return settled;
  });
  return changed;
}

/**
 * The stored log for one owner's run, oldest first, after a sequence cursor.
 * Returns null when the run is gone or idle-past its TTL, so a caller reports
 * "no longer running" rather than an empty list that looks like no progress.
 */
export async function loadRunEvents({ runId, userId, after = 0 } = {}) {
  const run = await TaskRun.findOne({ runId, userId })
    .select("events expiresAt conversationId steps busy")
    .lean();
  if (!run) return null;
  if (run.expiresAt instanceof Date && run.expiresAt.getTime() < Date.now()) return null;
  const since = Number.isFinite(Number(after)) ? Number(after) : 0;
  return {
    conversationId: run.conversationId || null,
    steps: run.steps,
    busy: run.busy === true,
    events: (Array.isArray(run.events) ? run.events : []).filter(event => Number(event.seq) > since)
  };
}

export default TaskRun;

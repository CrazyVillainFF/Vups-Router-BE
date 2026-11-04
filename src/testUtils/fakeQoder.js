import http from "node:http";

// Stands in for Qoder's Cloud Agents API: the session/event protocol, the
// tail-only SSE stream, and the buffered agent.message that repeats whatever
// was already streamed.
export const FAKE_QODER_API_KEY = "qoder-fake-pat-1234567890";
export const FAKE_QODER_SA_KEY = "qoder-fake-sa-key-0987654321";
export const FAKE_QODER_MODELS = ["ultimate", "giga"];
export const FAKE_QODER_MODEL = FAKE_QODER_MODELS[0];
export const FAKE_QODER_REPLY = "Hello world";

function json(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function frame(res, event, data, frameId) {
  res.write(`id: ${frameId || data.id || data.event?.id || "evt_x"}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function eventStart(eventId, type) {
  return { event: "event_start", data: { event: { id: eventId, type }, type: "event_start" } };
}

// Delta frames carry no top-level id, but Qoder stamps the owning event id on
// the `id:` line, which is what Last-Event-ID resumes from.
function deltaFrame(eventId, text) {
  return {
    event: "event_delta",
    data: { id: undefined, delta: { content: { text, type: "text" }, index: 0, type: "content_delta" }, event_id: eventId, type: "event_delta" },
    frameId: eventId
  };
}

async function readBody(req) {
  let data = "";
  for await (const chunk of req) data += chunk;
  return data;
}

export async function startFakeQoder() {
  const state = {
    requests: [],
    environments: [],
    agents: [],
    // Like environments and agents, sessions outlive a log clear: the adapter is
    // expected to keep addressing a session it created on the next turn.
    sessions: [],
    interrupts: [],
    sessionSeq: 0,
    mode: "delta",
    unauthorized: false,
    serviceTokensIssued: 0,
    issuedTokens: new Set(),
    currentSat: "",
    exchangeStatus: 0,
    exchangePayload: null,
    scopeDenied: false,
    modelsStatus: 0,
    modelsDelayMs: 0,
    modelsInvalidShape: false,
    modelsPayload: null,
    agentsStatus: 0,
    rejectSatOnce: false,
    // Session-lifecycle knobs: each one stands in for a documented Qoder
    // behaviour the adapter has to survive.
    busyOnce: 0,
    eventsStatus: 0,
    streamNotFoundOnce: 0,
    dropAfterFrames: 0,
    holdOpen: false,
    replayBuffered: false,
    // Tool scripting: each step runs in order inside one turn. A tools step
    // pauses the session until every call has a result; a text step ends it.
    toolScript: [],
    toolCalls: [],
    toolResults: [],
    unknownToolResults: [],
    pausedMessages: [],
    toolSeq: 0,
    clearRequests() {
      // Mutates in place so test files can keep a stable reference to the log.
      state.requests.length = 0;
      state.mode = "delta";
      state.unauthorized = false;
      state.serviceTokensIssued = 0;
      state.issuedTokens.clear();
      satSequence.clear();
      state.currentSat = "";
      state.exchangeStatus = 0;
      state.exchangePayload = null;
      state.scopeDenied = false;
      state.modelsStatus = 0;
      state.modelsDelayMs = 0;
      state.modelsInvalidShape = false;
      state.modelsPayload = null;
      state.agentsStatus = 0;
      state.rejectSatOnce = false;
      state.interrupts.length = 0;
      state.busyOnce = 0;
      state.eventsStatus = 0;
      state.streamNotFoundOnce = 0;
      state.dropAfterFrames = 0;
      state.holdOpen = false;
      state.replayBuffered = false;
      state.toolScript = [];
      state.toolCalls.length = 0;
      state.toolResults.length = 0;
      state.unknownToolResults.length = 0;
      state.pausedMessages.length = 0;
      state.toolSeq = 0;
      turnWaiters.clear();
      readyTurns.clear();
    },
    paths(method, prefix) {
      return state.requests.filter(entry => entry.method === method && entry.path.startsWith(prefix));
    }
  };

  const bearerToken = req => String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  // Requests are logged with a credential *label*, never the credential: the log
  // is echoed by failing assertions, and tests still need to prove which token
  // reached which host (for example that a service account key never appears on
  // a business call). Issued SATs keep their sequence so a re-exchange is
  // distinguishable from the original token.
  const satSequence = new Map();
  let nextSat = 0;
  function authLabel(req) {
    if (!req.headers.authorization) return undefined;
    const token = bearerToken(req);
    if (!token) return "Bearer ";
    if (token === FAKE_QODER_API_KEY) return "Bearer <pat>";
    if (token === FAKE_QODER_SA_KEY) return "Bearer <sa-key>";
    if (state.issuedTokens.has(token)) return `Bearer <sat#${satSequence.get(token) ?? 0}>`;
    return "Bearer <unknown>";
  }
  function tokenKindOf(req) {
    const label = authLabel(req);
    if (label === undefined) return "none";
    const token = bearerToken(req);
    if (!token) return "empty";
    if (token.startsWith(FAKE_QODER_API_KEY)) return "pat";
    if (token === FAKE_QODER_SA_KEY) return "sa-key";
    if (state.issuedTokens.has(token)) return "sat";
    return "unknown";
  }
  const authorized = req => {
    const token = bearerToken(req);
    if (token.startsWith(FAKE_QODER_API_KEY)) return true;
    return state.issuedTokens.has(token);
  };

  // A session's stream only starts delivering once that same session has been
  // given a message, in either arrival order, like the real service.
  const turnWaiters = new Map();
  const readyTurns = new Map();
  function signalTurn(sessionId) {
    const waiting = turnWaiters.get(sessionId);
    if (waiting?.length) waiting.shift()();
    else readyTurns.set(sessionId, (readyTurns.get(sessionId) || 0) + 1);
  }
  async function awaitTurn(sessionId) {
    if (readyTurns.get(sessionId) > 0) {
      readyTurns.set(sessionId, readyTurns.get(sessionId) - 1);
      return;
    }
    let release;
    const gate = new Promise(done => {
      release = done;
    });
    if (!turnWaiters.has(sessionId)) turnWaiters.set(sessionId, []);
    const waiting = turnWaiters.get(sessionId);
    waiting.push(release);
    await Promise.race([gate, new Promise(done => setTimeout(done, 3000))]);
    const stale = waiting.indexOf(release);
    if (stale !== -1) waiting.splice(stale, 1);
  }

  // Tool turns need a second channel: the write loop of an open stream has to
  // learn about frames pushed while it is parked between events.
  const frameWaiters = new Map();
  function wakeFrames(sessionId) {
    const waiting = frameWaiters.get(sessionId);
    if (waiting?.length) waiting.shift()();
  }
  async function waitFrames(sessionId, ms = 1000) {
    let release;
    const gate = new Promise(done => {
      release = done;
    });
    if (!frameWaiters.has(sessionId)) frameWaiters.set(sessionId, []);
    const waiting = frameWaiters.get(sessionId);
    waiting.push(release);
    await Promise.race([gate, new Promise(done => setTimeout(done, ms))]);
    const stale = waiting.indexOf(release);
    if (stale !== -1) waiting.splice(stale, 1);
  }
  function pushFrame(session, event, data) {
    session.frames.push({ event, data });
    wakeFrames(session.id);
  }
  // Runs the next scripted step: tools pause the turn, text ends it.
  function runToolStep(session) {
    const step = session.script?.[session.step];
    if (!step) {
      session.done = true;
      wakeFrames(session.id);
      return;
    }
    const calls = Array.isArray(step.tools) ? step.tools : [];
    if (calls.length === 0) {
      pushFrame(session, "agent.message", {
        id: `evt_msg_${session.step}`,
        type: "agent.message",
        content: [{ type: "text", text: typeof step.text === "string" ? step.text : FAKE_QODER_REPLY }],
        processed_at: "2026-05-18T03:40:51Z"
      });
      session.done = true;
      wakeFrames(session.id);
      return;
    }
    for (const call of calls) {
      state.toolSeq += 1;
      const customToolUseId = call.customToolUseId || `ctu_${state.toolSeq}`;
      const input = call.input && typeof call.input === "object" ? call.input : {};
      session.pending.set(customToolUseId, { name: call.name, input, result: null });
      state.toolCalls.push({ sessionId: session.id, customToolUseId, name: call.name, input });
      pushFrame(session, "agent.custom_tool_use", {
        id: `evt_ctu_${state.toolSeq}`,
        type: "agent.custom_tool_use",
        custom_tool_use_id: customToolUseId,
        name: call.name,
        input,
        processed_at: "2026-05-18T03:40:51Z"
      });
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const raw = req.method === "POST" || req.method === "PUT" ? await readBody(req) : "";
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = raw;
    }
    // The log is printed by failing assertions, so the bearer token is never
    // recorded verbatim; `auth` carries a label and `tokenKind` the credential
    // class instead.
    state.requests.push({
      method: req.method,
      path: url.pathname,
      search: url.search,
      headers: { ...req.headers, ...(authLabel(req) ? { authorization: authLabel(req) } : {}) },
      auth: authLabel(req) || "",
      tokenKind: tokenKindOf(req),
      body
    });

    if (url.pathname === "/api/v1/serviceToken/exchange" && req.method === "POST") {
      if (state.exchangeStatus) {
        return json(res, state.exchangeStatus, { type: "error", error: { type: "api_error", message: `Injected exchange ${state.exchangeStatus}.` } });
      }
      if (req.headers.authorization !== `Bearer ${FAKE_QODER_SA_KEY}`) {
        return json(res, 401, { type: "error", error: { type: "authentication_error", message: "Invalid service account key." } });
      }
      if (state.scopeDenied || !String(body?.scope || "").split(/\s+/).includes("qca.access")) {
        return json(res, 403, { type: "error", error: { type: "permission_error", message: "Scope qca.access is not allowed for this key." } });
      }
      if (body?.grant_type !== "client_credentials" || body?.audience !== "qoder") {
        return json(res, 400, { type: "error", error: { type: "invalid_request_error", message: "Unsupported grant." } });
      }
      if (state.exchangePayload) return json(res, 200, state.exchangePayload);
      state.serviceTokensIssued += 1;
      const token = `sat-fake-${state.serviceTokensIssued}`;
      state.issuedTokens.add(token);
      satSequence.set(token, state.serviceTokensIssued);
      state.currentSat = token;
      return json(res, 200, { access_token: token, token_type: "Bearer", expires_in: 3600 });
    }

    if (url.pathname.startsWith("/api/v1/cloud/")) {
      const token = bearerToken(req);
      if (state.rejectSatOnce && token && token === state.currentSat) {
        state.rejectSatOnce = false;
        state.issuedTokens.delete(token);
        return json(res, 401, { type: "error", error: { type: "authentication_error", message: "Access token expired." } });
      }
      if (state.unauthorized || !authorized(req)) {
        return json(res, 401, { type: "error", error: { type: "authentication_error", message: "Invalid access token." } });
      }
    }

    if (url.pathname === "/api/v1/cloud/models") {
      if (state.modelsDelayMs) await new Promise(done => setTimeout(done, state.modelsDelayMs));
      if (state.modelsStatus) {
        return json(res, state.modelsStatus, { type: "error", error: { type: "api_error", message: `Injected models ${state.modelsStatus}.` } });
      }
      if (state.modelsInvalidShape) return json(res, 200, { ok: true });
      if (state.modelsPayload) return json(res, 200, state.modelsPayload);
      return json(res, 200, {
        data: [
          {
            id: "ultimate",
            type: "model",
            display_name: "Ultimate",
            source: "system",
            is_enabled: true,
            is_new: false,
            price_factor: 1.6,
            efforts: ["low", "medium", "high", "xhigh", "max"],
            default_effort: "high",
            max_input_tokens: 1000000,
            default_context_window: 200000,
            available_context_windows: [200000, 400000, 1000000]
          },
          { id: "giga", type: "model", display_name: "Giga", source: "system", is_enabled: true },
          { id: "retired", type: "model", display_name: "Retired", source: "system", is_enabled: false }
        ],
        has_more: false
      });
    }
    if (url.pathname === "/api/v1/cloud/environments" && req.method === "GET") {
      return json(res, 200, { data: state.environments, has_more: false });
    }
    if (url.pathname === "/api/v1/cloud/environments" && req.method === "POST") {
      const environment = { id: "env_test", type: "environment", name: body?.name, config: body?.config };
      state.environments.push(environment);
      return json(res, 200, environment);
    }
    if (url.pathname === "/api/v1/cloud/agents" && req.method === "GET") {
      if (state.agentsStatus) {
        return json(res, state.agentsStatus, { type: "error", error: { type: "api_error", message: `Injected agents ${state.agentsStatus}.` } });
      }
      return json(res, 200, { data: state.agents, first_id: null, last_id: null, has_more: false, next_page: null });
    }
    if (url.pathname === "/api/v1/cloud/agents" && req.method === "POST") {
      if (!FAKE_QODER_MODELS.includes(body?.model)) {
        return json(res, 400, { type: "error", error: { type: "invalid_request_error", message: "Unknown model." } });
      }
      const agent = {
        id: `agent_${body.model}`,
        type: "agent",
        name: body?.name,
        model: body?.model,
        system: body?.system,
        // Whatever the adapter registered is what this agent can call; omitting
        // `tools` is what leaves Qoder's own sandbox tools enabled.
        tools: Array.isArray(body?.tools) ? body.tools : [],
        version: 1,
        archived_at: null
      };
      state.agents.push(agent);
      return json(res, 200, agent);
    }
    if (url.pathname === "/api/v1/cloud/sessions" && req.method === "POST") {
      if (!state.agents.some(agent => agent.id === body?.agent) || !state.environments.some(env => env.id === body?.environment_id)) {
        return json(res, 400, { type: "error", error: { type: "invalid_request_error", message: "Missing agent or environment_id." } });
      }
      state.sessionSeq += 1;
      const id = state.sessionSeq === 1 ? "sess_test" : `sess_test_${state.sessionSeq}`;
      const session = {
        id,
        agent: body.agent,
        environmentId: body.environment_id,
        status: "idle",
        content: [],
        frames: [],
        pending: new Map(),
        script: null,
        step: 0,
        done: false
      };
      state.sessions.push(session);
      return json(res, 200, { id, type: "session", status: "idle", agent: { id: body.agent, model: body.model }, environment_id: body.environment_id });
    }
    const sessionMatch = url.pathname.match(/^\/api\/v1\/cloud\/sessions\/([^/]+?)(\/events(?:\/stream)?)?$/);
    if (sessionMatch) {
      const session = state.sessions.find(item => item.id === sessionMatch[1]);
      const suffix = sessionMatch[2] || "";
      if (!session || (suffix !== "/events" && suffix !== "/events/stream")) {
        return json(res, 404, { type: "error", error: { type: "not_found_error", message: "Session not found." } });
      }
      if (suffix === "/events" && req.method === "POST") {
        const events = Array.isArray(body?.events) ? body.events : [];
        const eventType = events[0]?.type;
        if (eventType === "user.interrupt") {
          state.interrupts.push(session.id);
          session.status = "idle";
          session.pending.clear();
          session.script = null;
          session.done = true;
          return json(res, 200, { data: [{ id: `evt_interrupt_${state.interrupts.length}`, type: "user.interrupt", processed_at: "2026-05-18T03:40:50Z" }] });
        }
        if (eventType === "user.custom_tool_result") {
          for (const event of events) {
            const pending = session.pending.get(event?.custom_tool_use_id);
            if (!pending) {
              state.unknownToolResults.push(event?.custom_tool_use_id);
              return json(res, 400, {
                type: "error",
                error: { type: "invalid_request_error", message: `Unknown custom_tool_use_id "${event?.custom_tool_use_id}".` }
              });
            }
            if (pending.result !== null) {
              state.unknownToolResults.push(event?.custom_tool_use_id);
              return json(res, 400, {
                type: "error",
                error: { type: "invalid_request_error", message: `custom_tool_use_id "${event?.custom_tool_use_id}" was already answered.` }
              });
            }
            pending.result = event?.content;
            state.toolResults.push({
              sessionId: session.id,
              customToolUseId: event.custom_tool_use_id,
              content: event.content,
              isError: event.is_error === true
            });
          }
          if ([...session.pending.values()].every(entry => entry.result !== null)) {
            session.pending.clear();
            session.step += 1;
            runToolStep(session);
          }
          signalTurn(session.id);
          return json(res, 200, { data: events.map((event, index) => ({ id: `evt_ctr_${index}`, type: event.type })) });
        }
        if (eventType !== "user.message") {
          return json(res, 400, { type: "error", error: { type: "invalid_request_error", message: "Unsupported event type." } });
        }
        // A paused turn accepts no new message until its tool results arrive.
        if (session.pending.size > 0) {
          state.pausedMessages.push(session.id);
          return json(res, 409, {
            type: "error",
            error: { type: "invalid_request_error", message: "Session is paused waiting for custom tool results." }
          });
        }
        if (state.busyOnce > 0) {
          state.busyOnce -= 1;
          return json(res, 409, {
            type: "error",
            error: { type: "invalid_request_error", message: "Session is currently processing a turn. Cancel the current turn or wait for completion." }
          });
        }
        if (state.eventsStatus) {
          return json(res, state.eventsStatus, { type: "error", error: { type: "api_error", message: `Injected events ${state.eventsStatus}.` } });
        }
        session.content = events[0].content;
        session.status = "running";
        session.done = false;
        session.frames = [];
        session.script = state.toolScript.length > 0 ? state.toolScript.map(step => ({ ...step })) : null;
        if (session.script) {
          session.step = 0;
          session.pending.clear();
          runToolStep(session);
        }
        signalTurn(session.id);
        return json(res, 200, { data: [{ id: "evt_user", type: "user.message", content: events[0].content }] });
      }
      if (state.streamNotFoundOnce > 0 && req.method === "GET") {
        state.streamNotFoundOnce -= 1;
        return json(res, 404, { type: "error", error: { type: "not_found_error", message: "Session not found." } });
      }
      // A tool turn keeps its stream open while the agent is paused: the custom
      // tool use frames arrive first, the result unblocks the next step, and
      // session.status_idle only comes once the whole turn is finished.
      if (suffix === "/events/stream" && req.method === "GET" && (session.script || state.toolScript.length > 0)) {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
        res.on("error", () => {});
        let closed = false;
        res.on("close", () => {
          closed = true;
          wakeFrames(session.id);
        });
        res.write(": heartbeat\n\n");
        // The adapter attaches the stream before posting, so a fresh connection
        // waits for the message (or the tool result) that starts this turn.
        if (session.frames.length === 0 && session.pending.size === 0 && !session.done) {
          await awaitTurn(session.id);
        }
        while (!closed) {
          while (session.frames.length > 0) {
            const entry = session.frames.shift();
            frame(res, entry.event, entry.data);
          }
          if (session.done) {
            frame(res, "session.status_idle", {
              id: "evt_idle",
              type: "session.status_idle",
              stop_reason: { type: "end_turn" },
              processed_at: "2026-05-18T03:40:52Z"
            });
            session.status = "idle";
            res.end();
            return undefined;
          }
          await waitFrames(session.id);
        }
        return undefined;
      }
      if (suffix === "/events/stream" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
        // The adapter cancels a stream it no longer needs; writing to that
        // socket afterwards must not surface as an unhandled error.
        res.on("error", () => {});
        res.write(": heartbeat\n\n");
        const cursor = req.headers["last-event-id"];
        // The stream is opened before the message is posted; a fresh connection
        // waits for that post so the adapter is exercised in the real order,
        // while a resumed one already has its turn running.
        if (!cursor) await awaitTurn(session.id);
        const buffered = {
          id: "evt_am",
          type: "agent.message",
          content: [{ type: "text", text: FAKE_QODER_REPLY }],
          processed_at: "2026-05-18T03:40:51Z"
        };
        const echo = { event: "user.message", data: { id: "evt_user", type: "user.message", content: session.content || [{ type: "text", text: "[User]\nHello" }] } };
        const idle = {
          event: "session.status_idle",
          data: { id: "evt_idle", type: "session.status_idle", stop_reason: { type: "end_turn" }, processed_at: "2026-05-18T03:40:52Z" }
        };
        // With a cursor, Qoder delivers what that event left over instead of
        // replaying what the client already saw.
        const frames = cursor
          ? [{ event: "agent.message", data: buffered }, echo, ...(state.holdOpen ? [] : [idle])]
          : [
            ...(state.mode === "delta"
              ? [
                eventStart("evt_th", "agent.thinking"),
                deltaFrame("evt_th", "hidden reasoning"),
                eventStart("evt_am", "agent.message"),
                deltaFrame("evt_am", "Hello"),
                deltaFrame("evt_am", " world")
              ]
              : state.mode === "partial"
                ? [eventStart("evt_am", "agent.message"), deltaFrame("evt_am", FAKE_QODER_REPLY.slice(0, 3))]
                : []),
            { event: "agent.message", data: buffered },
            ...(state.replayBuffered ? [{ event: "agent.message", data: buffered }] : []),
            echo,
            ...(state.holdOpen ? [] : [idle])
          ];
        let sent = 0;
        for (const entry of frames) {
          if (state.dropAfterFrames && sent >= state.dropAfterFrames) {
            // Socket writes are queued, so let the frames already handed over
            // reach the client before hanging up: the adapter has to resume from
            // the event id it actually saw rather than from an empty one.
            await new Promise(done => setTimeout(done, 25));
            res.destroy();
            return undefined;
          }
          sent += 1;
          frame(res, entry.event, entry.data, entry.frameId);
        }
        if (state.holdOpen) {
          // A turn the client has to stop: Qoder keeps the stream open until the
          // interrupt arrives, so nothing here can mark the turn finished.
          await new Promise(done => res.on("close", done));
          return undefined;
        }
        session.status = "idle";
        res.end();
        return undefined;
      }
    }
    return json(res, 404, { type: "error", error: { type: "not_found_error", message: "Unknown path." } });
  });

  await new Promise(done => server.listen(0, "127.0.0.1", done));
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/v1/cloud`;

  return {
    baseUrl,
    state,
    close() {
      return new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
    }
  };
}

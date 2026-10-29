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

function frame(res, event, data) {
  res.write(`id: ${data.id || data.event?.id || "evt_x"}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function deltaFrame(eventId, text) {
  return {
    event: "event_delta",
    data: { delta: { content: { text, type: "text" }, index: 0, type: "content_delta" }, event_id: eventId, type: "event_delta" }
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
    rejectSatOnce: false,
    clearRequests() {
      // Mutates in place so test files can keep a stable reference to the log.
      state.requests.length = 0;
      state.mode = "delta";
      state.unauthorized = false;
      state.serviceTokensIssued = 0;
      state.issuedTokens.clear();
      state.currentSat = "";
      state.exchangeStatus = 0;
      state.exchangePayload = null;
      state.scopeDenied = false;
      state.modelsStatus = 0;
      state.modelsDelayMs = 0;
      state.modelsInvalidShape = false;
      state.rejectSatOnce = false;
    },
    paths(method, prefix) {
      return state.requests.filter(entry => entry.method === method && entry.path.startsWith(prefix));
    }
  };

  const bearerToken = req => String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  const authorized = req => {
    const token = bearerToken(req);
    if (token.startsWith(FAKE_QODER_API_KEY)) return true;
    return state.issuedTokens.has(token);
  };

  let resolvePosted = null;
  let posted = new Promise(done => {
    resolvePosted = done;
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const raw = req.method === "POST" || req.method === "PUT" ? await readBody(req) : "";
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = raw;
    }
    state.requests.push({ method: req.method, path: url.pathname, search: url.search, headers: req.headers, body });

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
      return json(res, 200, {
        data: [
          { id: "ultimate", type: "model", display_name: "Ultimate", source: "system", is_enabled: true, max_input_tokens: 1000000 },
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
        tools: [],
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
      return json(res, 200, {
        id: "sess_test",
        type: "session",
        status: "idle",
        agent: { id: body.agent, model: body.model },
        environment_id: body.environment_id
      });
    }
    if (url.pathname === "/api/v1/cloud/sessions/sess_test/events" && req.method === "POST") {
      if (body?.events?.[0]?.type !== "user.message") {
        return json(res, 400, { type: "error", error: { type: "invalid_request_error", message: "Unsupported event type." } });
      }
      resolvePosted();
      return json(res, 200, { data: [{ id: "evt_user", type: "user.message", content: body.events[0].content }] });
    }
    if (url.pathname === "/api/v1/cloud/sessions/sess_test/events/stream" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      res.write(": heartbeat\n\n");
      // The stream is opened before the message is posted; wait for it so the
      // adapter is exercised in the same order as the real service.
      await Promise.race([posted, new Promise(done => setTimeout(done, 3000))]);
      posted = new Promise(done => {
        resolvePosted = done;
      });
      const buffered = {
        id: "evt_am",
        type: "agent.message",
        content: [{ type: "text", text: FAKE_QODER_REPLY }],
        processed_at: "2026-05-18T03:40:51Z"
      };
      if (state.mode === "delta") {
        frame(res, "event_start", { event: { id: "evt_th", type: "agent.thinking" }, type: "event_start" });
        frame(res, "event_delta", deltaFrame("evt_th", "hidden reasoning"));
        frame(res, "event_start", { event: { id: "evt_am", type: "agent.message" }, type: "event_start" });
        frame(res, "event_delta", deltaFrame("evt_am", "Hello"));
        frame(res, "event_delta", deltaFrame("evt_am", " world"));
      } else if (state.mode === "partial") {
        frame(res, "event_start", { event: { id: "evt_am", type: "agent.message" }, type: "event_start" });
        frame(res, "event_delta", deltaFrame("evt_am", FAKE_QODER_REPLY.slice(0, 3)));
      }
      frame(res, "agent.message", buffered);
      frame(res, "user.message", { id: "evt_user", type: "user.message", content: [{ type: "text", text: "[User]\nHello" }] });
      frame(res, "session.status_idle", {
        id: "evt_idle",
        type: "session.status_idle",
        stop_reason: { type: "end_turn" },
        processed_at: "2026-05-18T03:40:52Z"
      });
      res.end();
      return undefined;
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

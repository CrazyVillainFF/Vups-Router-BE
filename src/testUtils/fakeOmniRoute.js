import http from "node:http";

export const FAKE_OMNIROUTE_KEY = "sk-omni-route-test-secret-123456";
export const FAKE_OMNIROUTE_MODELS = [
  "openai/gpt-5.2",
  "anthropic/claude-sonnet-4-6",
  "meta/llama-4-70b"
];

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => {
      data += chunk;
      if (data.length > 1024 * 1024) {
        reject(new Error("Request too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function json(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function startFakeOmniRoute() {
  const state = {
    models: [...FAKE_OMNIROUTE_MODELS],
    modelsRequests: 0,
    chatRequests: [],
    behavior: {
      modelsStatus: 200,
      chatStatus: 200,
      chatStatusText: "",
      delayMs: 0,
      failStreamMidway: false,
      invalidKey: false,
      emptyModels: false
    },
    set(partial) {
      Object.assign(state.behavior, partial);
    },
    reset() {
      state.models = [...FAKE_OMNIROUTE_MODELS];
      state.modelsRequests = 0;
      state.chatRequests.length = 0;
      state.behavior.modelsStatus = 200;
      state.behavior.chatStatus = 200;
      state.behavior.chatStatusText = "";
      state.behavior.delayMs = 0;
      state.behavior.failStreamMidway = false;
      state.behavior.invalidKey = false;
      state.behavior.emptyModels = false;
    }
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const auth = req.headers.authorization || "";
    const key = auth.startsWith("Bearer ") ? auth.slice(7) : "";

    if (url.pathname === "/v1/models" && req.method === "GET") {
      state.modelsRequests += 1;
      if (state.behavior.delayMs > 0) await delay(state.behavior.delayMs);
      if (key !== FAKE_OMNIROUTE_KEY || state.behavior.invalidKey) {
        return json(res, 401, { error: { message: "Invalid OmniRoute API key." } });
      }
      if (state.behavior.modelsStatus !== 200) {
        return json(res, state.behavior.modelsStatus, { error: { message: `Model list rejected with ${state.behavior.modelsStatus}` } });
      }
      const models = state.behavior.emptyModels ? [] : state.models;
      return json(res, 200, {
        object: "list",
        data: models.map(id => ({ id, object: "model", owned_by: "omniroute" }))
      });
    }

    if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      state.chatRequests.push({ key, url: url.pathname, body, headers: req.headers });
      if (state.behavior.delayMs > 0) await delay(state.behavior.delayMs);
      if (key !== FAKE_OMNIROUTE_KEY || state.behavior.invalidKey) {
        return json(res, 401, { error: { message: "Invalid OmniRoute API key." } });
      }
      if (state.behavior.chatStatus !== 200) {
        const text = state.behavior.chatStatusText || `OmniRoute upstream failure ${state.behavior.chatStatus}`;
        return json(res, state.behavior.chatStatus, { error: { message: text } });
      }
      if (!body.model || !state.models.includes(body.model)) {
        return json(res, 404, { error: { message: `Model "${body.model}" is not configured in OmniRoute.` } });
      }

      if (!body.stream) {
        return json(res, 200, {
          id: "chatcmpl-omniroute",
          model: body.model,
          choices: [{
            index: 0,
            message: { role: "assistant", content: `OmniRoute echo from ${body.model}: ${body.messages.at(-1)?.content ?? ""}` },
            finish_reason: "stop"
          }]
        });
      }

      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      const chunks = ["Omni", "Route ", `${body.model}`, " stream"];
      for (const chunk of chunks) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`);
        await delay(5);
      }
      if (state.behavior.failStreamMidway) {
        res.write(`data: ${JSON.stringify({ error: { message: "OmniRoute upstream exploded mid-stream." } })}\n\n`);
        res.end();
        return;
      }
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    return json(res, 404, { error: { message: `No fake OmniRoute route for ${req.method} ${url.pathname}` } });
  });

  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return {
    state,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    reset: () => state.reset(),
    close: () => new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())))
  };
}

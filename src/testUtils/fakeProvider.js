import http from "node:http";

export const FAKE_API_KEY = "sk-fake-provider-key-123456";
export const FAKE_MODELS = ["fake-model-mini", "fake-model-pro", "fake-model-reasoning"];

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

export async function startFakeProvider() {
  const state = {
    chatRequests: [],
    modelsRequests: 0,
    behavior: {
      listStatus: 200,
      chatStatus: 200,
      chatStatusText: "",
      failStreamMidway: false,
      invalidKey: false
    },
    set(partial) {
      Object.assign(state.behavior, partial);
    },
    reset() {
      state.chatRequests.length = 0;
      state.modelsRequests = 0;
      state.behavior.listStatus = 200;
      state.behavior.chatStatus = 200;
      state.behavior.chatStatusText = "";
      state.behavior.failStreamMidway = false;
      state.behavior.invalidKey = false;
    }
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const auth = req.headers.authorization || "";
    const key = auth.startsWith("Bearer ") ? auth.slice(7) : "";

    if (url.pathname.endsWith("/models") && req.method === "GET") {
      state.modelsRequests += 1;
      if (key !== FAKE_API_KEY) return json(res, 401, { error: { message: "Invalid API key provided." } });
      if (state.behavior.listStatus !== 200) {
        return json(res, state.behavior.listStatus, { error: { message: `Listing rejected with ${state.behavior.listStatus}` } });
      }
      return json(res, 200, { data: FAKE_MODELS.map(id => ({ id, owned_by: "fake" })) });
    }

    if (url.pathname.endsWith("/chat/completions") && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      state.chatRequests.push({ key, body });
      if (key !== FAKE_API_KEY || state.behavior.invalidKey) {
        return json(res, 401, { error: { message: "Invalid API key provided." } });
      }
      if (state.behavior.chatStatus !== 200) {
        if (state.behavior.chatStatus === 429) {
          return json(res, 429, { error: { message: state.behavior.chatStatusText || "Rate limit reached for this model." } });
        }
        if (state.behavior.chatStatus === 402) return json(res, 402, { error: { message: "Insufficient credits." } });
        if (state.behavior.chatStatus === 404) return json(res, 404, { error: { message: "The model does not exist." } });
        return json(res, state.behavior.chatStatus, { error: { message: "Provider failure." } });
      }
      if (!body.model || !FAKE_MODELS.includes(body.model)) {
        return json(res, 404, { error: { message: `The model \`${body.model}\` does not exist.` } });
      }
      const model = body.model;

      if (!body.stream) {
        return json(res, 200, {
          id: "chatcmpl-fake",
          model,
          choices: [{ index: 0, message: { role: "assistant", content: `Echo from ${model}: ${body.messages.at(-1)?.content ?? ""}` }, finish_reason: "stop" }]
        });
      }

      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      const chunks = ["Hello ", "from ", `${model}`, "!"];
      for (const chunk of chunks) {
        res.write(`data: ${JSON.stringify({ id: "chatcmpl-fake", model, choices: [{ delta: { content: chunk } }] })}\n\n`);
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      if (state.behavior.failStreamMidway) {
        res.write(`data: ${JSON.stringify({ error: { message: "Upstream exploded mid-stream." } })}\n\n`);
        res.end();
        return;
      }
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    return json(res, 404, { error: { message: `No fake route for ${req.method} ${url.pathname}` } });
  });

  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    state,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())))
  };
}

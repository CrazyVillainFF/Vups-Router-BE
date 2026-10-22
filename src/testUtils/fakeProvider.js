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
    keyRequests: 0,
    behavior: {
      listStatus: 200,
      keyStatus: 200,
      chatStatus: 200,
      chatStatusText: "",
      failStreamMidway: false,
      failModel: null,
      failModelStatus: 404,
      failModelMessage: "",
      invalidKey: false,
      finishReason: "stop",
      usageChunk: false,
      emptyDeltaFirst: false,
      emptyStream: false,
      extraModels: []
    },
    set(partial) {
      Object.assign(state.behavior, partial);
    },
    reset() {
      state.chatRequests.length = 0;
      state.modelsRequests = 0;
      state.keyRequests = 0;
      state.behavior.listStatus = 200;
      state.behavior.keyStatus = 200;
      state.behavior.chatStatus = 200;
      state.behavior.chatStatusText = "";
      state.behavior.failStreamMidway = false;
      state.behavior.failModel = null;
      state.behavior.failModelStatus = 404;
      state.behavior.failModelMessage = "";
      state.behavior.invalidKey = false;
      state.behavior.finishReason = "stop";
      state.behavior.usageChunk = false;
      state.behavior.emptyDeltaFirst = false;
      state.behavior.emptyStream = false;
      state.behavior.extraModels = [];
    }
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const auth = req.headers.authorization || "";
    const key = auth.startsWith("Bearer ") ? auth.slice(7) : "";

    if (url.pathname.endsWith("/key") && req.method === "GET") {
      state.keyRequests += 1;
      if (key !== FAKE_API_KEY || state.behavior.invalidKey) {
        return json(res, 401, { error: { message: "Invalid API key provided." } });
      }
      if (state.behavior.keyStatus !== 200) {
        return json(res, state.behavior.keyStatus, { error: { message: `Key check rejected with ${state.behavior.keyStatus}` } });
      }
      return json(res, 200, {
        data: {
          label: "fake-key-label",
          limit: 5,
          limit_remaining: 3.5,
          usage: 1.5,
          is_free_tier: true
        }
      });
    }

    if (url.pathname.endsWith("/models") && req.method === "GET") {
      state.modelsRequests += 1;
      if (key !== FAKE_API_KEY) return json(res, 401, { error: { message: "Invalid API key provided." } });
      if (state.behavior.listStatus !== 200) {
        return json(res, state.behavior.listStatus, { error: { message: `Listing rejected with ${state.behavior.listStatus}` } });
      }
      const models = [
        ...FAKE_MODELS.map(id => ({
          id,
          name: id,
          owned_by: "fake",
          pricing: { prompt: "0", completion: "0", request: "0" },
          architecture: { output_modalities: ["text"], modality: "text->text" },
          supported_parameters: id === "fake-model-reasoning" ? ["tools", "reasoning"] : ["tools"],
          context_length: 32768,
          top_provider: { max_completion_tokens: 4096 }
        })),
        ...state.behavior.extraModels
      ];
      return json(res, 200, { data: models });
    }

    if (url.pathname.endsWith("/chat/completions") && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      state.chatRequests.push({ key, body });
      if (key !== FAKE_API_KEY || state.behavior.invalidKey) {
        return json(res, 401, { error: { message: "Invalid API key provided." } });
      }
      if (state.behavior.failModel && body.model === state.behavior.failModel) {
        return json(res, state.behavior.failModelStatus, {
          error: {
            message: state.behavior.failModelMessage || `The model \`${body.model}\` is temporarily unavailable.`
          }
        });
      }
      if (state.behavior.chatStatus !== 200) {
        if (state.behavior.chatStatus === 429) {
          return json(res, 429, { error: { message: state.behavior.chatStatusText || "Rate limit reached for this model." } });
        }
        if (state.behavior.chatStatus === 402) return json(res, 402, { error: { message: "Insufficient credits." } });
        if (state.behavior.chatStatus === 404) return json(res, 404, { error: { message: "The model does not exist." } });
        return json(res, state.behavior.chatStatus, { error: { message: "Provider failure." } });
      }
      const knownModels = [...FAKE_MODELS, ...state.behavior.extraModels.map(entry => entry.id)];
      if (!body.model || !knownModels.includes(body.model)) {
        return json(res, 404, { error: { message: `The model \`${body.model}\` does not exist.` } });
      }
      const model = body.model;

      if (!body.stream) {
        return json(res, 200, {
          id: "chatcmpl-fake",
          model,
          choices: [{ index: 0, message: { role: "assistant", content: `Echo from ${model}: ${body.messages.at(-1)?.content ?? ""}` }, finish_reason: state.behavior.finishReason }]
        });
      }

      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      if (state.behavior.emptyStream) {
        res.write(`data: ${JSON.stringify({ id: "chatcmpl-fake", model, choices: [{ delta: { role: "assistant" }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id: "chatcmpl-fake", model, choices: [{ delta: {}, finish_reason: state.behavior.finishReason }] })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      const chunks = ["Hello ", "from ", `${model}`, "!"];
      if (state.behavior.emptyDeltaFirst) {
        res.write(`data: ${JSON.stringify({ id: "chatcmpl-fake", model, choices: [{ delta: { role: "assistant" }, finish_reason: null }] })}\n\n`);
      }
      for (let i = 0; i < chunks.length; i += 1) {
        const last = i === chunks.length - 1;
        res.write(`data: ${JSON.stringify({
          id: "chatcmpl-fake",
          model,
          choices: [{ delta: { content: chunks[i] }, ...(last ? { finish_reason: state.behavior.finishReason } : {}) }]
        })}\n\n`);
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      if (state.behavior.failStreamMidway) {
        res.write(`data: ${JSON.stringify({ error: { message: "Upstream exploded mid-stream." } })}\n\n`);
        res.end();
        return;
      }
      if (state.behavior.usageChunk) {
        res.write(`data: ${JSON.stringify({
          id: "chatcmpl-fake",
          model,
          choices: [],
          usage: { prompt_tokens: 5, completion_tokens: 9, total_tokens: 14 }
        })}\n\n`);
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

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
      chatFailuresRemaining: null,
      chatRetryAfter: null,
      chatErrorPayload: null,
      chatResponseHeaders: null,
      failStreamMidway: false,
      streamWithoutTerminal: false,
      streamErrorPayload: null,
      streamInitialDelayMs: 0,
      failModel: null,
      failModelStatus: 404,
      failModelMessage: "",
      invalidKey: false,
      finishReason: "stop",
      usageChunk: false,
      streamReasoning: false,
      reasoningOnly: false,
      streamChunkDelayMs: 5,
      emptyDeltaFirst: false,
      emptyStream: false,
      chatResponseText: null,
      toolCalls: null,
      nudgeToolCalls: null,
      nudgeResponseText: null,
      chatDelayMs: 0,
      extraModels: [],
      acceptedKeys: null
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
      state.behavior.chatFailuresRemaining = null;
      state.behavior.chatRetryAfter = null;
      state.behavior.chatErrorPayload = null;
      state.behavior.chatResponseHeaders = null;
      state.behavior.failStreamMidway = false;
      state.behavior.streamWithoutTerminal = false;
      state.behavior.streamErrorPayload = null;
      state.behavior.streamInitialDelayMs = 0;
      state.behavior.failModel = null;
      state.behavior.failModelStatus = 404;
      state.behavior.failModelMessage = "";
      state.behavior.invalidKey = false;
      state.behavior.finishReason = "stop";
      state.behavior.usageChunk = false;
      state.behavior.streamReasoning = false;
      state.behavior.reasoningOnly = false;
      state.behavior.streamChunkDelayMs = 5;
      state.behavior.emptyDeltaFirst = false;
      state.behavior.emptyStream = false;
      state.behavior.chatResponseText = null;
      state.behavior.toolCalls = null;
      state.behavior.nudgeToolCalls = null;
      state.behavior.nudgeResponseText = null;
      state.behavior.chatDelayMs = 0;
      state.behavior.extraModels = [];
      state.behavior.acceptedKeys = null;
    }
  };

  // A second fake instance can stand in for the shared server-side provider,
  // which authenticates with its own key instead of FAKE_API_KEY.
  function acceptsKey(key) {
    const accepted = state.behavior.acceptedKeys;
    return Array.isArray(accepted) ? accepted.includes(key) : key === FAKE_API_KEY;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const auth = req.headers.authorization || "";
    const key = auth.startsWith("Bearer ") ? auth.slice(7) : "";

    if (url.pathname.endsWith("/key") && req.method === "GET") {
      state.keyRequests += 1;
      if (!acceptsKey(key) || state.behavior.invalidKey) {
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
      if (!acceptsKey(key)) return json(res, 401, { error: { message: "Invalid API key provided." } });
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
      if (!acceptsKey(key) || state.behavior.invalidKey) {
        return json(res, 401, { error: { message: "Invalid API key provided." } });
      }
      if (state.behavior.failModel && body.model === state.behavior.failModel) {
        return json(res, state.behavior.failModelStatus, {
          error: {
            message: state.behavior.failModelMessage || `The model \`${body.model}\` is temporarily unavailable.`
          }
        });
      }
      let chatStatus = state.behavior.chatStatus;
      if (Number.isInteger(state.behavior.chatFailuresRemaining)) {
        if (state.behavior.chatFailuresRemaining > 0) {
          state.behavior.chatFailuresRemaining -= 1;
          chatStatus = state.behavior.chatStatus === 200 ? 503 : state.behavior.chatStatus;
        } else {
          chatStatus = 200;
        }
      }
      if (chatStatus !== 200) {
        if (state.behavior.chatErrorPayload) {
          res.writeHead(chatStatus, {
            "Content-Type": "application/json",
            ...(state.behavior.chatRetryAfter ? { "Retry-After": String(state.behavior.chatRetryAfter) } : {}),
            ...(state.behavior.chatResponseHeaders || {})
          });
          return res.end(JSON.stringify(state.behavior.chatErrorPayload));
        }
        if (chatStatus === 429) {
          res.writeHead(429, {
            "Content-Type": "application/json",
            ...(state.behavior.chatRetryAfter ? { "Retry-After": String(state.behavior.chatRetryAfter) } : {})
          });
          return res.end(JSON.stringify({ error: { message: state.behavior.chatStatusText || "Rate limit reached for this model." } }));
        }
        if (chatStatus === 402) return json(res, 402, { error: { message: "Insufficient credits." } });
        if (chatStatus === 404) return json(res, 404, { error: { message: "The model does not exist." } });
        return json(res, chatStatus, { error: { message: "Provider failure." } });
      }
      const knownModels = [...FAKE_MODELS, ...state.behavior.extraModels.map(entry => entry.id)];
      if (!body.model || !knownModels.includes(body.model)) {
        return json(res, 404, { error: { message: `The model \`${body.model}\` does not exist.` } });
      }
      const model = body.model;
      // The desktop execution layer re-prompts a model that only announced an
      // action or stalled on "shall I continue?"; tests drive that second round
      // through these fields.
      const nudged = Array.isArray(body.messages) && body.messages.some(message =>
        message?.role === "system" &&
        typeof message.content === "string" &&
        (message.content.includes("did not call any tool") ||
          message.content.includes("should continue with the next dependent step"))
      );
      if (state.behavior.chatDelayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, state.behavior.chatDelayMs));
      }

      if (!body.stream) {
        if (nudged && Array.isArray(state.behavior.nudgeToolCalls) && state.behavior.nudgeToolCalls.length > 0) {
          const calls = state.behavior.nudgeToolCalls.map((call, index) => ({
            id: call.id || `fake_nudge_call_${index}`,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) }
          }));
          return json(res, 200, {
            id: "chatcmpl-fake",
            model,
            choices: [{
              index: 0,
              message: { role: "assistant", content: null, tool_calls: calls },
              finish_reason: "tool_calls"
            }]
          });
        }
        if (nudged && typeof state.behavior.nudgeResponseText === "string") {
          return json(res, 200, {
            id: "chatcmpl-fake",
            model,
            choices: [{ index: 0, message: { role: "assistant", content: state.behavior.nudgeResponseText }, finish_reason: "stop" }]
          });
        }
        if (Array.isArray(state.behavior.toolCalls) && state.behavior.toolCalls.length > 0) {
          const calls = state.behavior.toolCalls.map((call, index) => ({
            id: call.id || `fake_call_${index}`,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) }
          }));
          return json(res, 200, {
            id: "chatcmpl-fake",
            model,
            choices: [{
              index: 0,
              message: { role: "assistant", content: null, tool_calls: calls },
              finish_reason: "tool_calls"
            }]
          });
        }
        const content = state.behavior.chatResponseText ?? `Echo from ${model}: ${body.messages.at(-1)?.content ?? ""}`;
        return json(res, 200, {
          id: "chatcmpl-fake",
          model,
          choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: state.behavior.finishReason }]
        });
      }

      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      if (state.behavior.streamInitialDelayMs > 0) {
        res.flushHeaders?.();
        await new Promise(resolve => setTimeout(resolve, state.behavior.streamInitialDelayMs));
      }
      if (state.behavior.emptyStream) {
        res.write(`data: ${JSON.stringify({ id: "chatcmpl-fake", model, choices: [{ delta: { role: "assistant" }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id: "chatcmpl-fake", model, choices: [{ delta: {}, finish_reason: state.behavior.finishReason }] })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      if (state.behavior.streamReasoning || state.behavior.reasoningOnly) {
        // OpenRouter duplicates each reasoning increment in both delta.reasoning
        // and delta.reasoning_details, so a parser must not count it twice.
        for (const piece of ["Thinking about ", "the request. "]) {
          res.write(`data: ${JSON.stringify({
            id: "chatcmpl-fake",
            model,
            choices: [{
              delta: {
                content: "",
                reasoning: piece,
                reasoning_details: [{ type: "reasoning.text", text: piece, format: "unknown", index: 0 }]
              },
              finish_reason: null
            }]
          })}\n\n`);
          await new Promise(resolve => setTimeout(resolve, state.behavior.streamChunkDelayMs));
        }
      }
      if (state.behavior.reasoningOnly) {
        res.write(`data: ${JSON.stringify({
          id: "chatcmpl-fake",
          model,
          choices: [{ delta: {}, finish_reason: state.behavior.finishReason }]
        })}\n\n`);
        res.write(`data: ${JSON.stringify({
          id: "chatcmpl-fake",
          model,
          choices: [],
          usage: {
            prompt_tokens: 5,
            completion_tokens: 40,
            total_tokens: 45,
            completion_tokens_details: { reasoning_tokens: 40 }
          }
        })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      const chunks = state.behavior.chatResponseText
        ? state.behavior.chatResponseText.match(/[\s\S]{1,240}/g) || [""]
        : ["Hello ", "from ", `${model}`, "!"];
      if (state.behavior.emptyDeltaFirst) {
        res.write(`data: ${JSON.stringify({ id: "chatcmpl-fake", model, choices: [{ delta: { role: "assistant" }, finish_reason: null }] })}\n\n`);
      }
      for (let i = 0; i < chunks.length; i += 1) {
        const last = i === chunks.length - 1;
        res.write(`data: ${JSON.stringify({
          id: "chatcmpl-fake",
          model,
          choices: [{ delta: { content: chunks[i] }, ...(last && !state.behavior.streamWithoutTerminal ? { finish_reason: state.behavior.finishReason } : {}) }]
        })}\n\n`);
        await new Promise(resolve => setTimeout(resolve, state.behavior.streamChunkDelayMs));
      }
      if (state.behavior.failStreamMidway) {
        res.write(`data: ${JSON.stringify(state.behavior.streamErrorPayload || { error: { message: "Upstream exploded mid-stream." } })}\n\n`);
        res.end();
        return;
      }
      if (state.behavior.streamWithoutTerminal) {
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

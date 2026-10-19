import http from "node:http";

export const FAKE_OLLAMA_MODEL = "gemma3:4b";
export const FAKE_OLLAMA_MODELS = [FAKE_OLLAMA_MODEL, "llama3:8b"];

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

export async function startFakeOllama() {
  const state = {
    installed: [...FAKE_OLLAMA_MODELS],
    tagsRequests: 0,
    chatRequests: [],
    behavior: { tagsStatus: 200 },
    reset() {
      state.installed = [...FAKE_OLLAMA_MODELS];
      state.tagsRequests = 0;
      state.chatRequests.length = 0;
      state.behavior.tagsStatus = 200;
    }
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");

    if (url.pathname === "/api/tags" && req.method === "GET") {
      state.tagsRequests += 1;
      if (state.behavior.tagsStatus !== 200) return json(res, state.behavior.tagsStatus, { error: "tags unavailable" });
      return json(res, 200, { models: state.installed.map(name => ({ name, model: name })) });
    }

    if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      state.chatRequests.push({ body, authorization: req.headers.authorization || "" });
      if (!state.installed.includes(body.model)) {
        return json(res, 404, { error: { message: `model '${body.model}' not found, try pulling it first` } });
      }
      if (!body.stream) {
        return json(res, 200, {
          choices: [{ index: 0, message: { role: "assistant", content: `Shared reply from ${body.model}` }, finish_reason: "stop" }]
        });
      }
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      const chunks = ["Shared ", `${body.model} `, "reply!"];
      for (const chunk of chunks) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`);
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    return json(res, 404, { error: { message: `No fake Ollama route for ${req.method} ${url.pathname}` } });
  });

  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return {
    state,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())))
  };
}

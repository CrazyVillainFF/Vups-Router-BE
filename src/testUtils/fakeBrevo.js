import http from "node:http";

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

export const FAKE_BREVO_KEY = "xkeysib-fake-brevo-key-123456";

export async function startFakeBrevo() {
  const state = {
    requests: [],
    behavior: { status: 201 },
    set(partial) {
      Object.assign(state.behavior, partial);
    },
    reset() {
      state.requests.length = 0;
      state.behavior.status = 201;
    }
  };

  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    if (req.method === "POST" && req.url === "/v3/smtp/email") {
      let parsed = null;
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = null;
      }
      state.requests.push({ headers: req.headers, body: parsed });
      const status = state.behavior.status;
      res.writeHead(status, { "Content-Type": "application/json" });
      if (status === 201) return res.end(JSON.stringify({ messageId: "fake-brevo-message-id" }));
      if (status === 429) return res.end(JSON.stringify({ code: "too_many_requests" }));
      return res.end(JSON.stringify({ code: "error" }));
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ code: "not_found" }));
  });

  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    state,
    close: () => new Promise(resolve => server.close(resolve))
  };
}

export function extractOtpCode(request) {
  const html = String(request?.body?.htmlContent || "");
  // The code is the only span whose entire content is six digits, so hex
  // colors like #111416 elsewhere in the document cannot be mistaken for it.
  const match = html.match(/<span[^>]*>(\d{6})<\/span>/);
  return match ? match[1] : null;
}

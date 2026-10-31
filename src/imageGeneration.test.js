import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import {
  IMAGE_GENERATION_MODEL,
  ImageGenerationError,
  generateImage,
  validateImagePrompt
} from "./imageGeneration.js";

const ENV_KEYS = [
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_AI_BASE_URL",
  "IMAGE_GENERATION_TIMEOUT_MS"
];

async function withEnv(values, fn) {
  const saved = new Map(ENV_KEYS.map(key => [key, process.env[key]]));
  for (const key of ENV_KEYS) {
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  }
  try {
    return await fn();
  } finally {
    for (const key of ENV_KEYS) {
      if (saved.get(key) === undefined) delete process.env[key];
      else process.env[key] = saved.get(key);
    }
  }
}

function listen(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

const IMAGE_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("vups-generated-image")
]);

test("validates image prompts at the Cloudflare model limit", () => {
  assert.deepEqual(validateImagePrompt("  a cyberpunk cat  "), { prompt: "a cyberpunk cat" });
  assert.match(validateImagePrompt("   ").error, /Enter an image prompt/);
  assert.match(validateImagePrompt(null).error, /Enter an image prompt/);
  assert.match(validateImagePrompt("x".repeat(2049)).error, /2048 characters or fewer/);
  assert.equal(validateImagePrompt("x".repeat(2048)).prompt.length, 2048);
});

test("generates an image from the documented JSON base64 response", async () => {
  const requests = [];
  const { server, port } = await listen((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
      res.writeHead(200, { "Content-Type": "application/json" });
      const image = IMAGE_BYTES.toString("base64").replace(/=+$/, "");
      res.end(JSON.stringify({ result: { image: `data:image/png;charset=utf-8;base64,${image}` }, success: true, errors: [] }));
    });
  });

  try {
    await withEnv(
      {
        CLOUDFLARE_ACCOUNT_ID: "account-123",
        CLOUDFLARE_API_TOKEN: "cf-secret-token",
        CLOUDFLARE_AI_BASE_URL: `http://127.0.0.1:${port}`,
        IMAGE_GENERATION_TIMEOUT_MS: undefined
      },
      async () => {
        const result = await generateImage("a lime green robot");
        assert.equal(result.mimeType, "image/png");
        assert.equal(result.model, IMAGE_GENERATION_MODEL);
        assert.ok(result.image.startsWith("data:image/png;base64,"));
        assert.equal(Buffer.from(result.image.split(",")[1], "base64").toString(), IMAGE_BYTES.toString());
      }
    );
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, "POST");
    assert.equal(requests[0].url, `/accounts/account-123/ai/run/${IMAGE_GENERATION_MODEL}`);
    assert.equal(requests[0].auth, "Bearer cf-secret-token");
    assert.deepEqual(requests[0].body, { prompt: "a lime green robot" });
  } finally {
    await close(server);
  }
});

test("accepts a binary image response and preserves its content type", async () => {
  const { server, port } = await listen((_req, res) => {
    res.writeHead(200, { "Content-Type": "image/png" });
    res.end(IMAGE_BYTES);
  });

  try {
    await withEnv(
      {
        CLOUDFLARE_ACCOUNT_ID: "account-123",
        CLOUDFLARE_API_TOKEN: "cf-secret-token",
        CLOUDFLARE_AI_BASE_URL: `http://127.0.0.1:${port}`
      },
      async () => {
        const result = await generateImage("binary image");
        assert.equal(result.mimeType, "image/png");
        assert.equal(result.image, `data:image/png;base64,${IMAGE_BYTES.toString("base64")}`);
      }
    );
  } finally {
    await close(server);
  }
});

test("missing Cloudflare configuration fails clearly without a request", async () => {
  await withEnv(
    {
      CLOUDFLARE_ACCOUNT_ID: undefined,
      CLOUDFLARE_API_TOKEN: undefined,
      CLOUDFLARE_AI_BASE_URL: undefined
    },
    async () => {
      await assert.rejects(
        generateImage("anything"),
        error => error instanceof ImageGenerationError &&
          error.status === 503 &&
          error.code === "image_generation_not_configured" &&
          /CLOUDFLARE_ACCOUNT_ID/.test(error.message)
      );
    }
  );
});

test("maps Cloudflare authentication, rate-limit, and provider failures", async () => {
  let status = 401;
  const { server, port } = await listen((_req, res) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: false, errors: [{ message: "upstream failure" }] }));
  });

  try {
    await withEnv(
      {
        CLOUDFLARE_ACCOUNT_ID: "account-123",
        CLOUDFLARE_API_TOKEN: "cf-secret-token",
        CLOUDFLARE_AI_BASE_URL: `http://127.0.0.1:${port}`
      },
      async () => {
        await assert.rejects(generateImage("x"), error => error.code === "image_generation_auth_failed" && error.status === 503);
        status = 429;
        await assert.rejects(generateImage("x"), error => error.code === "image_generation_rate_limited" && error.status === 429);
        status = 500;
        await assert.rejects(generateImage("x"), error => error.code === "image_generation_failed" && error.status === 502);
      }
    );
  } finally {
    await close(server);
  }
});

test("maps request timeouts to a retryable 504 without leaking the token", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    const error = new Error("timed out");
    error.name = "TimeoutError";
    throw error;
  };
  try {
    await withEnv(
      {
        CLOUDFLARE_ACCOUNT_ID: "account-123",
        CLOUDFLARE_API_TOKEN: "cf-secret-token",
        CLOUDFLARE_AI_BASE_URL: "https://api.cloudflare.test/client/v4"
      },
      async () => {
        await assert.rejects(
          generateImage("slow"),
          error => error.code === "image_generation_timeout" &&
            error.status === 504 &&
            !error.message.includes("cf-secret-token")
        );
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects malformed base64 images instead of returning a broken data URL", async () => {
  const { server, port } = await listen((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ result: { image: "not-valid-base64" }, success: true }));
  });

  try {
    await withEnv(
      {
        CLOUDFLARE_ACCOUNT_ID: "account-123",
        CLOUDFLARE_API_TOKEN: "cf-secret-token",
        CLOUDFLARE_AI_BASE_URL: `http://127.0.0.1:${port}`
      },
      async () => {
        await assert.rejects(
          generateImage("broken"),
          error => error.code === "image_generation_invalid_response" && error.status === 502
        );
      }
    );
  } finally {
    await close(server);
  }
});

test("a caller stop aborts the upstream image request instead of waiting it out", async () => {
  let connected = false;
  let upstreamClosed = false;
  const { server, port } = await listen((req, res) => {
    connected = true;
    req.on("close", () => {
      upstreamClosed = true;
      res.destroy();
    });
  });

  try {
    await withEnv(
      {
        CLOUDFLARE_ACCOUNT_ID: "account-123",
        CLOUDFLARE_API_TOKEN: "cf-secret-token",
        CLOUDFLARE_AI_BASE_URL: `http://127.0.0.1:${port}`
      },
      async () => {
        const controller = new AbortController();
        const run = generateImage("a slow image", controller.signal);
        const timer = setTimeout(() => controller.abort(), 25);
        try {
          await assert.rejects(
            run,
            error => error instanceof ImageGenerationError &&
              error.code === "cancelled" &&
              error.status === 499
          );
        } finally {
          clearTimeout(timer);
        }
        assert.equal(connected, true, "the upstream request must have started");
        await new Promise(resolve => setTimeout(resolve, 50));
        assert.equal(upstreamClosed, true, "the upstream connection must be closed by the abort");
      }
    );
  } finally {
    await close(server);
  }
});

test("a pre-aborted signal never starts an image request", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error("fetch must not run");
  };
  try {
    await withEnv(
      {
        CLOUDFLARE_ACCOUNT_ID: "account-123",
        CLOUDFLARE_API_TOKEN: "cf-secret-token",
        CLOUDFLARE_AI_BASE_URL: "https://api.cloudflare.test/client/v4"
      },
      async () => {
        const controller = new AbortController();
        controller.abort();
        await assert.rejects(
          generateImage("stop", controller.signal),
          error => error.code === "cancelled" && error.status === 499
        );
      }
    );
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
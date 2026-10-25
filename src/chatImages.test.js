import assert from "node:assert/strict";
import { after, test } from "node:test";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-secret-with-at-least-32-characters";
process.env.ENCRYPTION_SECRET = "test-encryption-secret-with-at-least-32-chars";
process.env.RATE_LIMIT_MAX = "10000";
process.env.CHAT_RATE_LIMIT_MAX = "10000";
delete process.env.MONGODB_URI;

const { MongoMemoryServer } = await import("mongodb-memory-server");
const mongod = await MongoMemoryServer.create();
process.env.MONGODB_URI = mongod.getUri("vupsrouter_images_test");

const { startFakeProvider, FAKE_API_KEY } = await import("./testUtils/fakeProvider.js");
const fakeProvider = await startFakeProvider();

// Point the shared OpenRouter provider at the fake provider so the whole
// shared-model path (vision capability + upstream payload) is covered too.
process.env.OPENROUTER_API_KEY = FAKE_API_KEY;
process.env.OPENROUTER_BASE_URL = fakeProvider.baseUrl;
process.env.OPENROUTER_MODEL = "fake-model-mini";
process.env.OPENROUTER_MODELS = "fake-model-mini,fake-model-pro";
process.env.OPENROUTER_VISION_MODELS = "fake-model-mini";
delete process.env.OLLAMA_BASE_URL;
delete process.env.VUPS_BASE_URL;
delete process.env.VUPS_API_KEY;
delete process.env.VUPS_UNDERLYING_MODEL;
delete process.env.VUPS_VISION;
delete process.env.VUPS_VISION_MODEL;

const { default: app } = await import("./index.js");
const { default: mongoose } = await import("mongoose");
const { validateImages, MAX_IMAGES_PER_MESSAGE, MAX_IMAGE_BYTES } = await import("./chatImages.js");

const server = app.listen(0, "127.0.0.1");
await new Promise(resolve => server.once("listening", resolve));
const baseURL = `http://127.0.0.1:${server.address().port}`;

after(async () => {
  await new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
  await fakeProvider.close();
  await mongoose.disconnect();
  await mongod.stop();
});

// ─── Fixtures ───────────────────────────────────────────────────────────────

const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("vupsrouter-image-fixture")
]);
const PNG_DATA = PNG_BYTES.toString("base64");
const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("jpeg-fixture")]);
const GIF_BYTES = Buffer.concat([Buffer.from("GIF89a", "ascii"), Buffer.from("gif-fixture")]);
const WEBP_BYTES = Buffer.concat([Buffer.from("RIFF", "ascii"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBP", "ascii"), Buffer.from("webp-fixture")]);

function pngImage(overrides = {}) {
  return { name: "cat.png", mimeType: "image/png", data: PNG_DATA, ...overrides };
}

function paddedPng(totalBytes) {
  const padding = Buffer.alloc(Math.max(0, totalBytes - PNG_BYTES.length), 0x20);
  return Buffer.concat([PNG_BYTES, padding]).toString("base64");
}

let emailCounter = 0;
function uniqueEmail() {
  emailCounter += 1;
  return `images${Date.now()}-${emailCounter}@example.com`;
}

async function api(path, { method = "GET", body, cookie, headers = {} } = {}) {
  const response = await fetch(`${baseURL}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: response.status, body: json, headers: response.headers };
}

function sessionCookie(response) {
  const cookies = response.headers.getSetCookie();
  const session = cookies.find(value => value.startsWith("vr_session="));
  return session ? session.split(";")[0] : null;
}

async function signupUser() {
  const email = uniqueEmail();
  const response = await api("/api/auth/signup", {
    method: "POST",
    body: { name: "Image Tester", email, password: "correct-horse-battery" }
  });
  assert.equal(response.status, 201);
  return { email, cookie: sessionCookie(response) };
}

async function configureProvider(cookie) {
  const response = await api("/api/settings/provider", {
    method: "PUT",
    cookie,
    body: {
      provider: "Fake OpenAI-compatible",
      baseUrl: fakeProvider.baseUrl,
      apiKey: FAKE_API_KEY,
      model: "fake-model-reasoning"
    }
  });
  assert.equal(response.status, 200);
}

function lastChatRequest() {
  return fakeProvider.state.chatRequests.at(-1);
}

async function chatWith(cookie, payload) {
  const response = await api("/api/chat", { method: "POST", cookie, body: payload });
  return response;
}

async function withEnv(values, run) {
  const saved = new Map(Object.keys(values).map(name => [name, process.env[name]]));
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return await run();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function vupsChat(cookie, payload) {
  return api("/api/chat/vups-v3-galax", { method: "POST", cookie, body: payload });
}

// ─── Unit: validateImages ───────────────────────────────────────────────────

test("validateImages accepts PNG, JPEG, GIF, and WebP payloads", () => {
  const cases = [
    ["image/png", PNG_BYTES],
    ["image/jpeg", JPEG_BYTES],
    ["image/gif", GIF_BYTES],
    ["image/webp", WEBP_BYTES]
  ];
  for (const [mimeType, bytes] of cases) {
    const result = validateImages([{ name: "x", mimeType, data: bytes.toString("base64") }]);
    assert.equal(result.error, undefined, `${mimeType} should be accepted`);
    assert.equal(result.images.length, 1);
    assert.equal(result.images[0].mimeType, mimeType);
    assert.equal(result.images[0].bytes, bytes.length);
  }
});

test("validateImages accepts public https image URLs without fetching them", () => {
  const result = validateImages([{ name: "cat.png", url: "https://example.com/images/cat.png#preview" }]);
  assert.equal(result.error, undefined);
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0].url, "https://example.com/images/cat.png");
  assert.equal(result.images[0].mimeType, "image/png");
  assert.equal(result.images[0].bytes, 0);

  const inferredName = validateImages([{ url: "https://cdn.example.com/photo.jpeg" }]);
  assert.equal(inferredName.error, undefined);
  assert.equal(inferredName.images[0].name, "photo.jpeg");
  assert.equal(inferredName.images[0].mimeType, "image/jpeg");
});

test("validateImages rejects unsafe or ambiguous image URLs", () => {
  assert.match(validateImages([{ url: "http://example.com/cat.png" }]).error, /https/);
  assert.match(validateImages([{ url: "https://127.0.0.1/cat.png" }]).error, /public host/);
  assert.match(validateImages([{ url: "https://[::1]/cat.png" }]).error, /public host/);
  assert.match(validateImages([{ url: "https://user:pass@example.com/cat.png" }]).error, /credentials/);
  assert.match(validateImages([{ url: "not a url" }]).error, /not valid/);
  assert.match(
    validateImages([{ url: "https://example.com/cat.png", mimeType: "image/png", data: PNG_DATA }]).error,
    /either base64 data or a URL/
  );
});

test("validateImages rejects unknown types, bad base64, and mismatched magic bytes", () => {
  const svg = validateImages([{ mimeType: "image/svg+xml", data: PNG_DATA }]);
  assert.match(svg.error, /PNG, JPEG, GIF, WEBP/);

  const badBase64 = validateImages([{ mimeType: "image/png", data: "not base64 !!" }]);
  assert.match(badBase64.error, /valid base64/);

  const mismatch = validateImages([{ mimeType: "image/png", data: JPEG_BYTES.toString("base64") }]);
  assert.match(mismatch.error, /valid image data/);

  const empty = validateImages([{ mimeType: "image/png", data: "" }]);
  assert.ok(empty.error);
});

test("validateImages enforces count, per-image size, and total size limits", () => {
  const tooMany = validateImages(Array.from({ length: MAX_IMAGES_PER_MESSAGE + 1 }, () => pngImage()));
  assert.match(tooMany.error, new RegExp(`at most ${MAX_IMAGES_PER_MESSAGE}`));

  const oversize = validateImages([pngImage({ data: paddedPng(MAX_IMAGE_BYTES + 1) })]);
  assert.match(oversize.error, /4 MB|MB or smaller/);

  const heavy = () => pngImage({ data: paddedPng(3 * 1024 * 1024) });
  const tooHeavy = validateImages([heavy(), heavy(), heavy()]);
  assert.match(tooHeavy.error, /total .*8 MB|per message/);
});

// ─── Integration: personal provider ─────────────────────────────────────────

test("images are forwarded upstream as OpenAI content parts", async () => {
  const user = await signupUser();
  await configureProvider(user.cookie);
  fakeProvider.state.chatRequests.length = 0;

  const response = await chatWith(user.cookie, {
    model: "fake-model-reasoning",
    stream: false,
    messages: [{ role: "user", content: "What is in this image?", images: [pngImage()] }]
  });

  assert.equal(response.status, 200);
  const upstream = lastChatRequest();
  assert.equal(upstream.key, FAKE_API_KEY);
  const sent = upstream.body.messages;
  assert.equal(sent[0].role, "system");
  assert.equal(typeof sent[0].content, "string");
  const last = sent.at(-1);
  assert.equal(last.role, "user");
  assert.ok(Array.isArray(last.content));
  assert.deepEqual(last.content[0], { type: "text", text: "What is in this image?" });
  assert.deepEqual(last.content[1], { type: "image_url", image_url: { url: `data:image/png;base64,${PNG_DATA}` } });
  assert.ok(response.body.message.content.includes("Echo from fake-model-reasoning"));
});

test("image-only messages are accepted and omit the text part", async () => {
  const user = await signupUser();
  await configureProvider(user.cookie);
  fakeProvider.state.chatRequests.length = 0;

  const response = await chatWith(user.cookie, {
    model: "fake-model-reasoning",
    stream: false,
    messages: [{ role: "user", content: "", images: [pngImage()] }]
  });

  assert.equal(response.status, 200);
  const last = lastChatRequest().body.messages.at(-1);
  assert.equal(last.content.length, 1);
  assert.equal(last.content[0].type, "image_url");
});

test("remote image URLs are forwarded as OpenAI content parts and stored as metadata only", async () => {
  const user = await signupUser();
  await configureProvider(user.cookie);
  fakeProvider.state.chatRequests.length = 0;
  const imageUrl = "https://cdn.example.com/images/cat.png";

  const response = await chatWith(user.cookie, {
    model: "fake-model-reasoning",
    stream: false,
    messages: [{ role: "user", content: "What is in this image?", images: [{ url: imageUrl }] }]
  });

  assert.equal(response.status, 200);
  const last = lastChatRequest().body.messages.at(-1);
  assert.deepEqual(last.content[1], { type: "image_url", image_url: { url: imageUrl } });

  const conversation = await api(`/api/conversations/${response.body.conversationId}`, { cookie: user.cookie });
  assert.equal(conversation.status, 200);
  const [userMessage] = conversation.body.conversation.messages;
  assert.deepEqual(userMessage.attachments, [
    { name: "cat.png", mimeType: "image/png", bytes: 0 }
  ]);
});

test("text-only messages still send a plain string payload", async () => {
  const user = await signupUser();
  await configureProvider(user.cookie);
  fakeProvider.state.chatRequests.length = 0;

  const response = await chatWith(user.cookie, {
    model: "fake-model-reasoning",
    stream: false,
    messages: [{ role: "user", content: "hello there" }]
  });

  assert.equal(response.status, 200);
  assert.equal(lastChatRequest().body.messages.at(-1).content, "hello there");
});

test("images attached to earlier messages are rejected", async () => {
  const user = await signupUser();
  const response = await chatWith(user.cookie, {
    model: "fake-model-reasoning",
    stream: false,
    messages: [
      { role: "user", content: "first", images: [pngImage()] },
      { role: "assistant", content: "ok" },
      { role: "user", content: "second" }
    ]
  });
  assert.equal(response.status, 400);
  assert.match(response.body.message, /current message/);
});

test("invalid attachment payloads are rejected with clear errors", async () => {
  const user = await signupUser();
  const badType = await chatWith(user.cookie, {
    model: "fake-model-reasoning",
    stream: false,
    messages: [{ role: "user", content: "hi", images: [{ mimeType: "image/svg+xml", data: PNG_DATA }] }]
  });
  assert.equal(badType.status, 400);
  assert.match(badType.body.message, /PNG, JPEG, GIF, WEBP/);

  const badData = await chatWith(user.cookie, {
    model: "fake-model-reasoning",
    stream: false,
    messages: [{ role: "user", content: "hi", images: [{ mimeType: "image/png", data: "%%%" }] }]
  });
  assert.equal(badData.status, 400);

  const tooMany = await chatWith(user.cookie, {
    model: "fake-model-reasoning",
    stream: false,
    messages: [{ role: "user", content: "hi", images: Array.from({ length: MAX_IMAGES_PER_MESSAGE + 1 }, () => pngImage()) }]
  });
  assert.equal(tooMany.status, 400);
  assert.match(tooMany.body.message, new RegExp(`at most ${MAX_IMAGES_PER_MESSAGE}`));
});

test("unauthenticated chat requests with images are rejected", async () => {
  const response = await chatWith(null, {
    stream: false,
    messages: [{ role: "user", content: "hi", images: [pngImage()] }]
  });
  assert.equal(response.status, 401);
});

// ─── Integration: shared models and vision capability ──────────────────────

test("shared model without vision support returns a clear 400", async () => {
  const user = await signupUser();
  const response = await chatWith(user.cookie, {
    model: "fake-model-pro",
    stream: false,
    messages: [{ role: "user", content: "look", images: [pngImage()] }]
  });
  assert.equal(response.status, 400);
  assert.equal(response.body.code, "model_no_vision");
  assert.match(response.body.message, /does not accept image inputs/);
  assert.match(response.body.message, /fake-model-mini/);
});

test("vision-capable shared model accepts images end to end", async () => {
  const user = await signupUser();
  fakeProvider.state.chatRequests.length = 0;
  const response = await chatWith(user.cookie, {
    model: "fake-model-mini",
    stream: false,
    messages: [{ role: "user", content: "describe", images: [pngImage()] }]
  });
  assert.equal(response.status, 200);
  const upstream = lastChatRequest();
  assert.equal(upstream.body.model, "fake-model-mini");
  const last = upstream.body.messages.at(-1);
  assert.ok(Array.isArray(last.content));
  assert.equal(last.content[1].image_url.url, `data:image/png;base64,${PNG_DATA}`);
});

test("shared model list exposes vision capabilities to the client", async () => {
  const user = await signupUser();
  const response = await api("/api/settings/models", { cookie: user.cookie });
  assert.equal(response.status, 200);
  const shared = response.body.models.filter(model => model.shared);
  assert.deepEqual(
    shared.map(model => [model.id, model.vision]),
    [["fake-model-mini", true], ["fake-model-pro", false]]
  );
});

// ─── Integration: Vups v3 Galax fallback vision routing ─────────────────────

test("Vups v3 Galax keeps text on the text model and routes images to the vision model", async () => {
  const user = await signupUser();
  await withEnv(
    {
      VUPS_BASE_URL: undefined,
      VUPS_API_KEY: undefined,
      VUPS_UNDERLYING_MODEL: undefined,
      VUPS_VISION: undefined,
      VUPS_VISION_MODEL: "fake-model-mini",
      OPENROUTER_DEFAULT_MODEL: "fake-model-pro"
    },
    async () => {
      fakeProvider.state.reset();

      const text = await vupsChat(user.cookie, {
        stream: false,
        model: "vups-v3-galax",
        messages: [{ role: "user", content: "hello text model" }]
      });
      assert.equal(text.status, 200);
      assert.equal(lastChatRequest().body.model, "fake-model-pro");
      assert.deepEqual(lastChatRequest().body.reasoning, { enabled: false });

      const image = await vupsChat(user.cookie, {
        stream: false,
        model: "vups-v3-galax",
        messages: [{ role: "user", content: "describe this", images: [pngImage()] }]
      });
      assert.equal(image.status, 200);
      const upstream = lastChatRequest();
      assert.equal(upstream.body.model, "fake-model-mini", "image requests must use the vision model");
      assert.deepEqual(upstream.body.reasoning, { enabled: false });
      const sent = upstream.body.messages.at(-1);
      assert.ok(Array.isArray(sent.content));
      assert.equal(sent.content[1].image_url.url, `data:image/png;base64,${PNG_DATA}`);

      const conversation = await api(`/api/conversations/${image.body.conversationId}`, { cookie: user.cookie });
      assert.equal(conversation.status, 200);
      const [userMessage] = conversation.body.conversation.messages;
      assert.deepEqual(userMessage.attachments, [
        { name: "cat.png", mimeType: "image/png", bytes: PNG_BYTES.length }
      ]);
      assert.ok(!JSON.stringify(conversation.body).includes(PNG_DATA.slice(0, 24)));
    }
  );
  fakeProvider.state.reset();
});

test("Vups streaming image requests use the configured vision model", async () => {
  const user = await signupUser();
  await withEnv(
    {
      VUPS_BASE_URL: undefined,
      VUPS_API_KEY: undefined,
      VUPS_UNDERLYING_MODEL: undefined,
      VUPS_VISION: undefined,
      VUPS_VISION_MODEL: "fake-model-mini",
      OPENROUTER_DEFAULT_MODEL: "fake-model-pro"
    },
    async () => {
      fakeProvider.state.reset();
      const response = await fetch(`${baseURL}/api/chat/vups-v3-galax`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: user.cookie },
        body: JSON.stringify({
          stream: true,
          model: "vups-v3-galax",
          messages: [{ role: "user", content: "describe this", images: [pngImage()] }]
        })
      });
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type"), /text\/event-stream/);
      const events = (await response.text())
        .split("\n")
        .filter(line => line.startsWith("data: "))
        .map(line => JSON.parse(line.slice(6)));
      assert.ok(events.some(event => event.type === "done"));

      const upstream = lastChatRequest();
      assert.equal(upstream.body.model, "fake-model-mini");
      assert.deepEqual(upstream.body.reasoning, { enabled: false });
      const sent = upstream.body.messages.at(-1);
      assert.ok(Array.isArray(sent.content));
      assert.equal(sent.content[1].image_url.url, `data:image/png;base64,${PNG_DATA}`);
    }
  );
  fakeProvider.state.reset();
});

test("a missing Vups vision model is reported as model unavailable, not an unreadable image", async () => {
  const user = await signupUser();
  await withEnv(
    {
      VUPS_BASE_URL: undefined,
      VUPS_API_KEY: undefined,
      VUPS_UNDERLYING_MODEL: undefined,
      VUPS_VISION: undefined,
      VUPS_VISION_MODEL: "fake-model-mini",
      OPENROUTER_DEFAULT_MODEL: "fake-model-pro"
    },
    async () => {
      fakeProvider.state.reset();
      fakeProvider.state.set({
        failModel: "fake-model-mini",
        failModelStatus: 404,
        failModelMessage: "No endpoints found for model fake-model-mini"
      });
      const response = await vupsChat(user.cookie, {
        stream: false,
        model: "vups-v3-galax",
        messages: [{ role: "user", content: "look", images: [pngImage()] }]
      });
      assert.equal(response.status, 503);
      assert.equal(response.body.code, "vups_model_unavailable");
      assert.match(response.body.message, /VUPS_VISION_MODEL/);
      assert.ok(!/could not read that image/i.test(response.body.message));
    }
  );
  fakeProvider.state.reset();
});

test("VUPS_VISION=false rejects Vups image requests before calling the provider", async () => {
  const user = await signupUser();
  await withEnv(
    {
      VUPS_BASE_URL: undefined,
      VUPS_API_KEY: undefined,
      VUPS_UNDERLYING_MODEL: undefined,
      VUPS_VISION: "false",
      VUPS_VISION_MODEL: "fake-model-mini",
      OPENROUTER_DEFAULT_MODEL: "fake-model-pro"
    },
    async () => {
      fakeProvider.state.reset();
      const response = await vupsChat(user.cookie, {
        stream: false,
        model: "vups-v3-galax",
        messages: [{ role: "user", content: "look", images: [pngImage()] }]
      });
      assert.equal(response.status, 400);
      assert.equal(response.body.code, "vups_vision_unsupported");
      assert.equal(fakeProvider.state.chatRequests.length, 0);
    }
  );
});

test("a no-image-endpoint provider error is reported as a vision rejection, not a missing model", async () => {
  const user = await signupUser();
  await withEnv(
    {
      VUPS_BASE_URL: undefined,
      VUPS_API_KEY: undefined,
      VUPS_UNDERLYING_MODEL: undefined,
      VUPS_VISION: undefined,
      VUPS_VISION_MODEL: "fake-model-mini",
      OPENROUTER_DEFAULT_MODEL: "fake-model-pro"
    },
    async () => {
      fakeProvider.state.reset();
      fakeProvider.state.set({
        failModel: "fake-model-mini",
        failModelStatus: 404,
        failModelMessage: "No endpoints found that support image input"
      });
      const response = await vupsChat(user.cookie, {
        stream: false,
        model: "vups-v3-galax",
        messages: [{ role: "user", content: "look", images: [pngImage()] }]
      });
      assert.equal(response.status, 400);
      assert.equal(response.body.code, "vups_vision_rejected");
      assert.match(response.body.message, /could not read that image/i);
    }
  );
  fakeProvider.state.reset();
});

// ─── Persistence ────────────────────────────────────────────────────────────

test("history stores attachment metadata and never image bytes", async () => {
  const user = await signupUser();
  await configureProvider(user.cookie);
  const response = await chatWith(user.cookie, {
    model: "fake-model-reasoning",
    stream: false,
    messages: [{ role: "user", content: "check this out", images: [pngImage({ name: "cat.png" })] }]
  });
  assert.equal(response.status, 200);

  const conversation = await api(`/api/conversations/${response.body.conversationId}`, { cookie: user.cookie });
  assert.equal(conversation.status, 200);
  const [userMessage] = conversation.body.conversation.messages;
  assert.equal(userMessage.content, "check this out");
  assert.deepEqual(userMessage.attachments, [
    { name: "cat.png", mimeType: "image/png", bytes: PNG_BYTES.length }
  ]);
  assert.ok(!JSON.stringify(conversation.body).includes(PNG_DATA.slice(0, 24)));
});

test("image-only conversations get a sensible stored title", async () => {
  const user = await signupUser();
  await configureProvider(user.cookie);
  const response = await chatWith(user.cookie, {
    model: "fake-model-reasoning",
    stream: false,
    messages: [{ role: "user", content: "", images: [pngImage()] }]
  });
  assert.equal(response.status, 200);
  const conversation = await api(`/api/conversations/${response.body.conversationId}`, { cookie: user.cookie });
  assert.equal(conversation.body.conversation.title, "Image attachment");
});

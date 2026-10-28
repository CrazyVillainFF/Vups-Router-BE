import "dotenv/config";
import { checkOpenRouter, openRouterBaseUrl } from "../src/openrouter.js";
import { extractStreamReasoning, extractStreamText, startChatCompletionStream, withProviderRetry } from "../src/providerClient.js";

const key = (process.env.OPENROUTER_API_KEY || "").trim();
const base = openRouterBaseUrl();

function fail(message) {
  console.error(`[fail] ${message}`);
  process.exitCode = 1;
}

if (!key || !base) {
  fail("OPENROUTER_API_KEY or a valid OPENROUTER_BASE_URL is not set. Never commit the key.");
  process.exit(1);
}

console.log(`[info] base URL: ${base}`);
const check = await checkOpenRouter({ forceRefresh: true });
console.log(`[info] catalog status: ${check.status}; free chat models: ${check.models?.filter(model => model.available).length ?? 0}`);
if (!check.available) {
  fail(`shared catalog is not available (${check.status}).`);
  process.exit(1);
}
console.log(`[ok] default: ${check.model}${check.fallbackModel ? `; fallback: ${check.fallbackModel}` : ""}`);
if (check.defaultUnavailable) console.log("[warn] the configured default is not currently free/available; a catalog model was selected instead.");
if (check.catalogStale) console.log("[warn] catalog response came from the stale cache.");

try {
  const keyResponse = await fetch(`${base}/key`, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    signal: AbortSignal.timeout(15000)
  });
  const keyPayload = await keyResponse.json().catch(() => null);
  if (!keyResponse.ok) {
    fail(`key check failed with HTTP ${keyResponse.status}${keyPayload?.error?.message ? `: ${keyPayload.error.message}` : ""}`);
  } else {
    const data = keyPayload?.data || {};
    console.log(`[ok] API key accepted (usage: ${data.usage ?? "n/a"}, limit: ${data.limit ?? "n/a"}, is_free_tier: ${data.is_free_tier ?? "n/a"})`);
  }
} catch (error) {
  fail(`key check could not be completed: ${error.message}`);
}

const configured = (process.env.OPENROUTER_MODELS || "")
  .split(",")
  .map(value => value.trim())
  .filter(Boolean);
const readyIds = check.models.filter(model => model.available).map(model => model.id);
const probeLimitValue = Number(process.env.OPENROUTER_VERIFY_PROBE_LIMIT);
const probeLimit = Number.isFinite(probeLimitValue) && probeLimitValue > 0 ? Math.floor(probeLimitValue) : 3;
const targets = configured.length > 0
  ? configured
  : [...new Set([check.model, check.fallbackModel, ...readyIds])].filter(Boolean).slice(0, probeLimit);

console.log(`[info] probing ${targets.length} model(s); set OPENROUTER_VERIFY_PROBE_LIMIT to change the dynamic sample size`);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function probeChat(id) {
  const response = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      model: id,
      messages: [{ role: "user", content: "Reply with the single word OK." }],
      max_tokens: 512,
      stream: false
    }),
    signal: AbortSignal.timeout(90000)
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    return { ok: false, reason: `HTTP ${response.status}${payload?.error?.message ? `: ${payload.error.message}` : ""}` };
  }
  const content = String(payload?.choices?.[0]?.message?.content ?? "");
  const finish = payload?.choices?.[0]?.finish_reason ?? "n/a";
  if (content.trim().length === 0) {
    return { ok: false, reason: `empty content (finish_reason: ${finish})` };
  }
  return { ok: true, detail: `finish_reason: ${finish}, reply: ${JSON.stringify(content.slice(0, 60))}` };
}

for (const id of targets) {
  if (!readyIds.includes(id)) {
    fail(`"${id}" is not currently free and chat-capable.`);
    continue;
  }
  try {
    let result = await probeChat(id);
    if (!result.ok) {
      console.log(`[info] retrying "${id}" once; first attempt: ${result.reason}`);
      await sleep(3000);
      result = await probeChat(id);
    }
    if (result.ok) console.log(`[ok] chat probe succeeded with "${id}" (${result.detail})`);
    else fail(`chat probe for "${id}" failed: ${result.reason}`);
  } catch (error) {
    fail(`chat probe for "${id}" could not be completed: ${error.message}`);
  }
}

async function probeStream(id) {
  // Same retry policy the chat route now applies, so this reports what a user
  // would actually experience rather than a single unlucky upstream slot.
  const response = await withProviderRetry(
    () => startChatCompletionStream(
      {
        baseUrl: base,
        apiKey: key,
        model: id,
        messages: [{ role: "user", content: "Reply with the single word OK." }],
        maxTokens: 1024
      },
      AbortSignal.timeout(120000)
    ),
    { maxRetries: 2, baseDelayMs: 2000, maxDelayMs: 15000 }
  );
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let reasoningChars = 0;
  let usage = null;
  let finish = null;
  let sawDone = false;

  function handleLine(line) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const raw = trimmed.slice(5).trim();
    if (!raw) return;
    if (raw === "[DONE]") {
      sawDone = true;
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const choice = parsed?.choices?.[0];
    if (typeof choice?.finish_reason === "string" && choice.finish_reason) finish = choice.finish_reason;
    if (parsed?.usage && typeof parsed.usage === "object") usage = parsed.usage;
    reasoningChars += extractStreamReasoning(parsed).length;
    content += extractStreamText(parsed);
  }

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) handleLine(line);
  }
  handleLine(buffer);

  const detail =
    `answer ${content.length} chars, reasoning ${reasoningChars} chars, finish_reason: ${finish ?? "none"}, ` +
    `terminal: ${sawDone ? "[DONE]" : "missing"}, usage: ${usage ? JSON.stringify(usage) : "none"}`;
  if (content.trim().length === 0) return { ok: false, reason: `stream produced no answer text (${detail})` };
  if (!sawDone) return { ok: false, reason: `stream ended without [DONE] (${detail})` };
  if (!usage) return { ok: true, detail: `${detail}; warn: no usage chunk even though the request asked for one` };
  return { ok: true, detail };
}

const streamModel = (process.env.OPENROUTER_VERIFY_STREAM_MODEL || "").trim() || check.model;
if (streamModel) {
  try {
    let streamed = await probeStream(streamModel);
    if (!streamed.ok) {
      console.log(`[info] streaming retry for "${streamModel}"; first attempt: ${streamed.reason}`);
      await sleep(5000);
      streamed = await probeStream(streamModel);
    }
    if (streamed.ok) console.log(`[ok] streaming probe succeeded with "${streamModel}" (${streamed.detail})`);
    else fail(`streaming probe for "${streamModel}" failed: ${streamed.reason}`);
  } catch (error) {
    fail(`streaming probe for "${streamModel}" could not be completed: ${error.code ? `${error.code}: ` : ""}${error.message}`);
  }
}

if (process.exitCode) console.error("[result] some checks failed");
else console.log("[result] catalog and probed models are free, listed, and responding");

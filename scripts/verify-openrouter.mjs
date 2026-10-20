import "dotenv/config";
import { checkOpenRouter, openRouterBaseUrl } from "../src/openrouter.js";

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
    console.log(`[ok] API key accepted (label: ${data.label || "n/a"}, usage: ${data.usage ?? "n/a"}, limit: ${data.limit ?? "n/a"}, is_free_tier: ${data.is_free_tier ?? "n/a"})`);
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

if (process.exitCode) console.error("[result] some checks failed");
else console.log("[result] catalog and probed models are free, listed, and responding");

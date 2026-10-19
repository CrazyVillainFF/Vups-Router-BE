import "dotenv/config";

const key = (process.env.OPENROUTER_API_KEY || "").trim();
const base = (process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/+$/, "");

const DEFAULT_MODELS = [
  "nvidia/nemotron-3.5-lightning:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "cohere/north-mini-code:free",
  "nvidia/nemotron-3-ultra-550b-a55b:free"
];

const envModels = (process.env.OPENROUTER_MODELS || "")
  .split(",")
  .map(value => value.trim())
  .filter(Boolean);
const targets = envModels.length > 0 ? [...new Set(envModels)] : DEFAULT_MODELS;

function fail(message) {
  console.error(`[fail] ${message}`);
  process.exitCode = 1;
}

if (!key) {
  fail("OPENROUTER_API_KEY is not set. Set it in the environment (never commit it).");
  process.exit(1);
}

console.log(`[info] base URL: ${base}`);
console.log(`[info] checking ${targets.length} enabled shared model(s)`);

let modelsPayload;
try {
  const response = await fetch(`${base}/models`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  modelsPayload = await response.json();
} catch (error) {
  fail(`could not reach the OpenRouter model list: ${error.message}`);
  process.exit(1);
}

const entries = Array.isArray(modelsPayload?.data) ? modelsPayload.data : [];
const byId = new Map(entries.map(entry => [entry.id, entry]));
console.log(`[ok] model list reachable (${entries.length} models)`);

try {
  const keyResponse = await fetch(`${base}/key`, { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
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

const available = [];
for (const id of targets) {
  const entry = byId.get(id);
  if (entry) {
    available.push(id);
    console.log(`[ok] "${id}" is listed (name: ${entry.name || "n/a"})`);
  } else {
    fail(`"${id}" is NOT in the current model list — replace it before enabling it.`);
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function probeChat(id) {
  const response = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      model: id,
      messages: [{ role: "user", content: "Reply with the single word OK." }],
      max_tokens: 2048,
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
    return { ok: false, reason: `empty content (finish_reason: ${finish}) — the model may need a larger max_tokens or may be reasoning-only` };
  }
  return { ok: true, detail: `finish_reason: ${finish}, reply: ${JSON.stringify(content.slice(0, 60))}` };
}

for (const id of available) {
  try {
    let result = await probeChat(id);
    if (!result.ok) {
      console.log(`[info] retrying "${id}" once — first attempt: ${result.reason}`);
      await sleep(3000);
      result = await probeChat(id);
    }
    if (result.ok) {
      console.log(`[ok] chat probe succeeded with "${id}" (${result.detail})`);
    } else {
      fail(`chat probe for "${id}" failed: ${result.reason}`);
    }
  } catch (error) {
    fail(`chat probe for "${id}" could not be completed: ${error.message}`);
  }
}

if (process.exitCode) console.error("[result] some checks failed");
else console.log("[result] all configured shared models are valid, listed, and responding");

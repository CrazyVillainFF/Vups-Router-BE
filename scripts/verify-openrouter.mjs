import "dotenv/config";

const key = (process.env.OPENROUTER_API_KEY || "").trim();
const base = (process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/+$/, "");
const model = (process.env.OPENROUTER_MODEL || "").trim();

function fail(message) {
  console.error(`[fail] ${message}`);
  process.exitCode = 1;
}

if (!key) {
  fail("OPENROUTER_API_KEY is not set. Set it in the environment (never commit it).");
  process.exit(1);
}

console.log(`[info] base URL: ${base}`);
console.log(`[info] configured model: ${model || "(none — using default)"}`);

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
console.log(`[ok] model list reachable (${entries.length} models)`);

const nemotron = entries.find(entry => entry.id === "nvidia/nemotron-3.5-lightning:free");
console.log(nemotron ? "[ok] nvidia/nemotron-3.5-lightning:free is currently available" : "[info] nvidia/nemotron-3.5-lightning:free is NOT in the current model list");

const freeIds = entries.filter(entry => typeof entry.id === "string" && entry.id.endsWith(":free")).map(entry => entry.id);
console.log(`[info] ${freeIds.length} free models currently listed, e.g.:`);
for (const id of freeIds.slice(0, 12)) console.log(`       - ${id}`);

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

if (model) {
  if (!entries.some(entry => entry.id === model)) {
    fail(`model "${model}" is not in the current model list — do not claim it is available.`);
    process.exit(1);
  }
  try {
    const chatResponse = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "Reply with the single word OK." }], max_tokens: 512, stream: false }),
      signal: AbortSignal.timeout(60000)
    });
    const chatPayload = await chatResponse.json().catch(() => null);
    if (!chatResponse.ok) {
      fail(`chat probe failed with HTTP ${chatResponse.status}${chatPayload?.error?.message ? `: ${chatPayload.error.message}` : ""}`);
    } else {
      const content = chatPayload?.choices?.[0]?.message?.content ?? "";
      const finish = chatPayload?.choices?.[0]?.finish_reason ?? "n/a";
      if (String(content).trim().length === 0) {
        fail(`chat probe returned HTTP ${chatResponse.status} but empty content (finish_reason: ${finish}) — the model may need a larger max_tokens or may be reasoning-only.`);
      } else {
        console.log(`[ok] chat probe succeeded with "${model}" (finish_reason: ${finish}, reply: ${JSON.stringify(String(content).slice(0, 60))})`);
      }
    }
  } catch (error) {
    fail(`chat probe could not be completed: ${error.message}`);
  }
}

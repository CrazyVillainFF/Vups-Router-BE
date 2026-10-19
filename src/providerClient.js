const REQUEST_TIMEOUT_MS = 60000;
const STREAM_TIMEOUT_MS = 300000;
const MAX_ERROR_LENGTH = 400;

export class ProviderError extends Error {
  constructor(message, status = null, code = "provider_error") {
    super(message);
    this.name = "ProviderError";
    this.status = status;
    this.code = code;
  }
}

export function normalizeBaseUrl(value) {
  if (typeof value !== "string") throw new ProviderError("API base URL is required.", 400, "invalid_base_url");
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) throw new ProviderError("API base URL is required.", 400, "invalid_base_url");
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ProviderError("API base URL must be a valid URL such as https://api.example.com/v1.", 400, "invalid_base_url");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new ProviderError("API base URL must start with http:// or https://.", 400, "invalid_base_url");
  }
  if (parsed.username || parsed.password) {
    throw new ProviderError("API base URL must not contain embedded credentials.", 400, "invalid_base_url");
  }
  return parsed.origin + parsed.pathname.replace(/\/+$/, "") + parsed.search;
}

export function validateProviderFields({ provider, baseUrl, apiKey, model }, { requireKey = true } = {}) {
  if (typeof provider !== "string" || provider.trim().length < 2 || provider.trim().length > 80) {
    return "Provider name must be between 2 and 80 characters.";
  }
  if (typeof baseUrl !== "string" || baseUrl.trim().length === 0 || baseUrl.trim().length > 500) {
    return "API base URL is required (max 500 characters).";
  }
  try {
    normalizeBaseUrl(baseUrl);
  } catch (error) {
    return error.message;
  }
  if (requireKey && (typeof apiKey !== "string" || apiKey.trim().length < 4 || apiKey.trim().length > 4096)) {
    return "API key is required (between 4 and 4096 characters).";
  }
  if (apiKey !== undefined && apiKey !== null && typeof apiKey === "string" && apiKey.length > 4096) {
    return "API key must be 4096 characters or fewer.";
  }
  if (model !== undefined && model !== null && (typeof model !== "string" || model.length > 200)) {
    return "Model ID must be 200 characters or fewer.";
  }
  return null;
}

function truncate(value) {
  if (typeof value !== "string") return "";
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > MAX_ERROR_LENGTH ? `${clean.slice(0, MAX_ERROR_LENGTH)}…` : clean;
}

export function describeProviderError(status, payload) {
  const detail = truncate(
    payload?.error?.message || payload?.message || (typeof payload === "string" ? payload : "")
  );
  const suffix = detail ? ` Provider said: ${detail}` : "";
  if (status === 400) return new ProviderError(`The provider rejected the request (HTTP 400). Check the model ID and parameters.${suffix}`, status, "bad_request");
  if (status === 401) return new ProviderError(`The provider rejected your API key (HTTP 401). Check the key in Settings.${suffix}`, status, "invalid_api_key");
  if (status === 402) return new ProviderError(`Your provider account has insufficient credits (HTTP 402).${suffix}`, status, "insufficient_credits");
  if (status === 403) return new ProviderError(`The provider denied access (HTTP 403). Your key may lack permission for this model.${suffix}`, status, "forbidden");
  if (status === 404) return new ProviderError(`The provider returned HTTP 404. The API base URL or model ID is likely wrong.${suffix}`, status, "not_found");
  if (status === 408) return new ProviderError(`The provider timed out (HTTP 408).${suffix}`, status, "timeout");
  if (status === 413) return new ProviderError(`The conversation is too large for this provider (HTTP 413).${suffix}`, status, "too_large");
  if (status === 422) return new ProviderError(`The provider could not process the request (HTTP 422). Check the model ID.${suffix}`, status, "unprocessable");
  if (status === 429) return new ProviderError(`Rate limit or quota exceeded (HTTP 429). Wait a moment and try again.${suffix}`, status, "rate_limited");
  if (typeof status === "number" && status >= 500) return new ProviderError(`The provider is temporarily unavailable (HTTP ${status}).${suffix}`, status, "provider_unavailable");
  return new ProviderError(`The provider returned an unexpected error${status ? ` (HTTP ${status})` : ""}.${suffix}`, status ?? null, "provider_error");
}

async function readJsonSafely(response) {
  try {
    return await response.json();
  } catch {
    try {
      return await response.text();
    } catch {
      return null;
    }
  }
}

function authHeaders(apiKey) {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: `Bearer ${apiKey}`
  };
}

export async function listProviderModels({ baseUrl, apiKey }, signal) {
  const url = `${normalizeBaseUrl(baseUrl)}/models`;
  let response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: authHeaders(apiKey),
      signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw new ProviderError("Timed out while contacting the provider's model list endpoint.", null, "timeout");
    }
    throw new ProviderError("Could not reach the provider's model list endpoint. Check the API base URL and your network.", null, "network_error");
  }
  if (!response.ok) {
    const payload = await readJsonSafely(response);
    throw describeProviderError(response.status, payload);
  }
  const payload = await readJsonSafely(response);
  const entries = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : null;
  if (!entries) {
    throw new ProviderError("The provider's response did not contain a model list. Enter the model ID manually.", response.status, "unsupported_listing");
  }
  return entries
    .map(entry => ({
      id: typeof entry?.id === "string" ? entry.id : typeof entry?.name === "string" ? entry.name : null,
      ownedBy: typeof entry?.owned_by === "string" ? entry.owned_by : undefined
    }))
    .filter(entry => entry.id)
    .slice(0, 1000);
}

export async function chatCompletion({ baseUrl, apiKey, model, messages, temperature, maxTokens }, signal) {
  const url = `${normalizeBaseUrl(baseUrl)}/chat/completions`;
  const body = { model, messages, stream: false };
  if (typeof temperature === "number" && Number.isFinite(temperature)) body.temperature = temperature;
  if (typeof maxTokens === "number" && Number.isFinite(maxTokens)) body.max_tokens = maxTokens;

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw new ProviderError("Timed out while waiting for the provider.", null, "timeout");
    }
    throw new ProviderError("Could not reach the provider. Check the API base URL and your network.", null, "network_error");
  }
  if (!response.ok) {
    throw describeProviderError(response.status, await readJsonSafely(response));
  }
  const payload = await readJsonSafely(response);
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.length === 0) {
    throw new ProviderError("The provider returned an empty or unexpected response.", response.status, "empty_response");
  }
  return content;
}

export async function startChatCompletionStream({ baseUrl, apiKey, model, messages, temperature }, signal) {
  const url = `${normalizeBaseUrl(baseUrl)}/chat/completions`;
  const body = { model, messages, stream: true };
  if (typeof temperature === "number" && Number.isFinite(temperature)) body.temperature = temperature;

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { ...authHeaders(apiKey), Accept: "text/event-stream" },
      body: JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(STREAM_TIMEOUT_MS)
    });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      if (signal?.aborted) throw new ProviderError("Request cancelled.", null, "cancelled");
      throw new ProviderError("Timed out while waiting for the provider's stream.", null, "timeout");
    }
    throw new ProviderError("Could not reach the provider. Check the API base URL and your network.", null, "network_error");
  }
  if (!response.ok) {
    throw describeProviderError(response.status, await readJsonSafely(response));
  }
  if (!response.body) {
    throw new ProviderError("The provider did not return a response stream.", response.status, "empty_stream");
  }
  return response;
}

export function extractStreamText(payload) {
  const choice = payload?.choices?.[0];
  if (!choice) return typeof payload?.content === "string" ? payload.content : "";
  const delta = choice.delta ?? choice.message ?? {};
  const content = delta.content ?? choice.text;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map(part => (typeof part === "string" ? part : typeof part?.text === "string" ? part.text : ""))
      .join("");
  }
  return "";
}

export async function testProviderConnection({ baseUrl, apiKey, model }, signal) {
  const availableModels = [];
  let listError = null;
  try {
    const models = await listProviderModels({ baseUrl, apiKey }, signal);
    availableModels.push(...models);
  } catch (error) {
    listError = error;
    if (error instanceof ProviderError && ["invalid_api_key", "invalid_base_url", "network_error", "insufficient_credits"].includes(error.code)) {
      throw error;
    }
  }

  if (model) {
    if (availableModels.length > 0 && !availableModels.some(entry => entry.id === model)) {
      throw new ProviderError(`The provider does not list a model named "${model}". Refresh the model list and choose an available model.`, null, "model_unavailable");
    }
    const reply = await chatCompletion(
      { baseUrl, apiKey, model, messages: [{ role: "user", content: "Reply with OK." }], maxTokens: 8 },
      signal
    );
    return { availableModels, modelChecked: true, sample: reply.slice(0, 40) };
  }

  if (availableModels.length === 0 && listError) throw listError;
  return { availableModels, modelChecked: false, sample: null };
}

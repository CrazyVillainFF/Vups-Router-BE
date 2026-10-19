import { imageDataUrl } from "./chatImages.js";

function envMillis(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 1000 ? Math.floor(value) : fallback;
}

const REQUEST_TIMEOUT_MS = envMillis("PROVIDER_TIMEOUT_MS", 60000);
const STREAM_TIMEOUT_MS = envMillis("PROVIDER_STREAM_TIMEOUT_MS", 300000);
const MAX_ERROR_LENGTH = 400;

export class ProviderError extends Error {
  constructor(message, status = null, code = "provider_error") {
    super(message);
    this.name = "ProviderError";
    this.status = status;
    this.code = code;
  }
}

const ENDPOINT_SUFFIX = /\/(chat\/completions|responses|messages|completions|models|embeddings)$/i;
const AGENTROUTER_HOSTS = new Set(["agentrouter.org", "www.agentrouter.org"]);

function isAgentRouterHost(hostname) {
  return AGENTROUTER_HOSTS.has(String(hostname || "").toLowerCase());
}

// Strips accidental endpoint suffixes so request URLs never end up doubled
// (e.g. ".../v1/chat/completions/chat/completions"). The "/v1" (or any other
// version) path segment is preserved; only the concrete operation paths are
// removed, since the client appends those itself. AgentRouter's documented
// base URL always ends in /v1, so pasting only the origin is normalized too.
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
  let cleanedPath = parsed.pathname.replace(/\/+$/, "");
  while (ENDPOINT_SUFFIX.test(cleanedPath)) {
    cleanedPath = cleanedPath.replace(ENDPOINT_SUFFIX, "");
  }
  if (isAgentRouterHost(parsed.hostname) && (cleanedPath === "" || /^(\/v\d+)+$/i.test(cleanedPath))) {
    cleanedPath = "/v1";
  }
  return parsed.origin + cleanedPath + parsed.search;
}

// AgentRouter requires its GPT models on the OpenAI Responses endpoint. Other
// models and every other provider stay on the OpenAI chat-completions path.
export function usesResponsesApi(baseUrl, model) {
  const normalized = normalizeBaseUrl(baseUrl);
  let host;
  try {
    host = new URL(normalized).hostname;
  } catch {
    return false;
  }
  return isAgentRouterHost(host) && /^gpt-/i.test(String(model ?? "").trim());
}

export function resolveChatEndpoint(baseUrl, model) {
  const normalized = normalizeBaseUrl(baseUrl);
  return `${normalized}${usesResponsesApi(normalized, model) ? "/responses" : "/chat/completions"}`;
}

// Classifies the host of a provider base URL so we can warn about endpoints
// the deployed backend can never reach (localhost, private ranges, metadata).
export function classifyProviderHost(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return "public";
  if (host === "localhost" || host.endsWith(".localhost")) return "local";
  if (host === "::1" || host === "0.0.0.0" || host === "::") return "local";
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const first = Number(v4[1]);
    const second = Number(v4[2]);
    if (first === 127 || first === 0) return "local";
    if (first === 10) return "private";
    if (first === 172 && second >= 16 && second <= 31) return "private";
    if (first === 192 && second === 168) return "private";
    if (first === 169 && second === 254) return "private";
    if (first === 100 && second >= 64 && second <= 127) return "private";
  }
  if (host.startsWith("fc") || host.startsWith("fd")) return "private";
  if (host.startsWith("fe80:")) return "private";
  if (host.endsWith(".internal")) return "private";
  return "public";
}

export function privateProviderUrlsAllowed() {
  return process.env.ALLOW_PRIVATE_PROVIDER_URLS === "true" || process.env.NODE_ENV !== "production";
}

// SSRF guard for user-supplied endpoints: in production, loopback/private/
// metadata destinations are only allowed when the operator explicitly opts in
// (ALLOW_PRIVATE_PROVIDER_URLS=true) for a trusted private deployment.
export function assertAllowedProviderUrl(normalizedBaseUrl) {
  let host;
  try {
    host = new URL(normalizedBaseUrl).hostname;
  } catch {
    return;
  }
  const kind = classifyProviderHost(host);
  if (kind === "public" || privateProviderUrlsAllowed()) return;
  const reachability =
    kind === "local"
      ? `"${host}" is a local address, so a deployed VupsRouter backend points at the machine the server runs on — not at your computer.`
      : `"${host}" is a private network address that a deployed VupsRouter backend cannot route to.`;
  throw new ProviderError(
    `This base URL cannot be reached from the VupsRouter server. ${reachability} Fix it by: (1) exposing the gateway on a publicly reachable HTTPS URL (for example a secure tunnel such as ngrok or Cloudflare Tunnel) and using that URL, (2) running VupsRouter locally next to the gateway, or (3) setting ALLOW_PRIVATE_PROVIDER_URLS=true on the server only if this is a deliberately trusted private deployment.`,
    400,
    kind === "local" ? "local_endpoint" : "private_endpoint"
  );
}

function safeHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "the provider";
  }
}

function networkError(error, url) {
  const host = safeHost(url);
  const causeCode = error?.cause?.code || error?.code || "";
  if (causeCode === "ENOTFOUND" || causeCode === "EAI_AGAIN") {
    return new ProviderError(`DNS lookup failed for "${host}". Check the API base URL hostname and that the provider is online.`, null, "dns_error");
  }
  if (causeCode === "ECONNREFUSED") {
    return new ProviderError(`Connection refused by "${host}". The endpoint may be offline, the port closed, or the URL wrong.`, null, "connection_refused");
  }
  if (causeCode === "ECONNRESET" || causeCode === "EPIPE") {
    return new ProviderError(`The connection to "${host}" was reset before a response arrived. Try again.`, null, "network_error");
  }
  return new ProviderError(`Could not reach "${host}". Check the API base URL and your network.`, null, "network_error");
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

export function redactSecrets(value) {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{6,}/g, "sk-[redacted]");
}

export function describeProviderError(status, payload) {
  const detail = redactSecrets(truncate(
    payload?.error?.message || payload?.message || (typeof payload === "string" ? payload : "")
  ));
  const suffix = detail ? ` Provider said: ${detail}` : "";
  if (status === 400) return new ProviderError(`The provider rejected the request (HTTP 400). Check the model ID and parameters.${suffix}`, status, "bad_request");
  if (status === 401) return new ProviderError(`The provider rejected your API key (HTTP 401). Check the key in Settings.${suffix}`, status, "invalid_api_key");
  if (status === 402) return new ProviderError(`Your provider account has insufficient credits (HTTP 402).${suffix}`, status, "insufficient_credits");
  if (status === 403) return new ProviderError(`The provider denied access (HTTP 403). Your key may lack permission for this model.${suffix}`, status, "forbidden");
  if (status === 404) return new ProviderError(`The provider returned HTTP 404. The API base URL or model ID is likely wrong.${suffix}`, status, "not_found");
  if (status === 405) return new ProviderError(`The provider rejected the request method or endpoint (HTTP 405). The base URL may point at the wrong API path, or the model may require a different endpoint.${suffix}`, status, "method_not_allowed");
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
    throw networkError(error, url);
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

// Converts normalized messages into the OpenAI chat format used by every
// provider we support (OpenRouter, personal OpenAI-compatible APIs, and the
// shared Ollama server's /v1 compatibility layer). Messages carrying images
// become content-parts arrays with base64 data URLs; everything else is
// passed through untouched.
export function serializeMessages(messages) {
  return messages.map(message => {
    const images = Array.isArray(message?.images) ? message.images : [];
    if (images.length === 0) return { role: message.role, content: message.content };
    const parts = [];
    if (typeof message.content === "string" && message.content.trim().length > 0) {
      parts.push({ type: "text", text: message.content });
    }
    for (const image of images) {
      parts.push({ type: "image_url", image_url: { url: imageDataUrl(image) } });
    }
    return { role: message.role, content: parts };
  });
}

function serializeResponsesMessages(messages) {
  return serializeMessages(messages).map(message => {
    if (typeof message.content === "string") return message;
    return {
      role: message.role,
      content: message.content.map(part => (
        part.type === "image_url"
          ? { type: "input_image", image_url: part.image_url?.url ?? "" }
          : { type: "input_text", text: part.text ?? "" }
      ))
    };
  });
}

export function buildChatRequestBody({ model, messages, temperature, maxTokens, stream, responses = false }) {
  if (responses) {
    const instructions = messages
      .filter(message => message.role === "system" && typeof message.content === "string")
      .map(message => message.content)
      .filter(Boolean)
      .join("\n\n");
    const input = serializeResponsesMessages(messages.filter(message => message.role !== "system"));
    const body = { model, input, stream };
    if (instructions) body.instructions = instructions;
    if (typeof maxTokens === "number" && Number.isFinite(maxTokens)) body.max_output_tokens = maxTokens;
    return body;
  }
  const body = { model, messages: serializeMessages(messages), stream };
  if (typeof temperature === "number" && Number.isFinite(temperature)) body.temperature = temperature;
  if (typeof maxTokens === "number" && Number.isFinite(maxTokens)) body.max_tokens = maxTokens;
  return body;
}

export function extractResponseText(payload) {
  if (typeof payload?.output_text === "string" && payload.output_text.length > 0) return payload.output_text;
  if (Array.isArray(payload?.output)) {
    const text = payload.output
      .flatMap(item => (Array.isArray(item?.content) ? item.content : []))
      .filter(part => typeof part?.text === "string" && (part.type === "output_text" || part.type === "text"))
      .map(part => part.text)
      .join("");
    if (text.length > 0) return text;
  }
  const content = payload?.choices?.[0]?.message?.content;
  return typeof content === "string" ? content : "";
}

function responsesFinishReason(payload) {
  if (typeof payload?.incomplete_details?.reason === "string") {
    return payload.incomplete_details.reason === "max_output_tokens" ? "length" : payload.incomplete_details.reason;
  }
  return payload?.status === "completed" ? "stop" : null;
}

export async function chatCompletion({ baseUrl, apiKey, model, messages, temperature, maxTokens }, signal) {
  const responses = usesResponsesApi(baseUrl, model);
  const url = resolveChatEndpoint(baseUrl, model);
  const body = buildChatRequestBody({ model, messages, temperature, maxTokens, stream: false, responses });

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
    throw networkError(error, url);
  }
  if (!response.ok) {
    throw describeProviderError(response.status, await readJsonSafely(response));
  }
  const payload = await readJsonSafely(response);
  const content = extractResponseText(payload);
  if (content.length === 0) {
    throw new ProviderError("The provider returned an empty or unexpected response.", response.status, "empty_response");
  }
  return {
    content,
    finishReason: responses ? responsesFinishReason(payload) : (typeof payload?.choices?.[0]?.finish_reason === "string" ? payload.choices[0].finish_reason : null)
  };
}

export async function startChatCompletionStream({ baseUrl, apiKey, model, messages, temperature, maxTokens }, signal) {
  const responses = usesResponsesApi(baseUrl, model);
  const url = resolveChatEndpoint(baseUrl, model);
  const body = buildChatRequestBody({ model, messages, temperature, maxTokens, stream: true, responses });

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
    throw networkError(error, url);
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
  if (payload?.type === "response.output_text.delta" && typeof payload.delta === "string") return payload.delta;
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
    const result = await chatCompletion(
      { baseUrl, apiKey, model, messages: [{ role: "user", content: "Reply with OK." }], maxTokens: 64 },
      signal
    );
    return { availableModels, modelChecked: true, sample: result.content.slice(0, 40) };
  }

  if (availableModels.length === 0 && listError) throw listError;
  return { availableModels, modelChecked: false, sample: null };
}

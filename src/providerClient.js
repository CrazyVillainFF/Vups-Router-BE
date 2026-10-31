import dns from "node:dns/promises";
import { createHash } from "node:crypto";
import { imageSourceUrl } from "./chatImages.js";
import { freeFromPricing, geminiCapabilities, normalizeCapabilities, visionFromCapabilities } from "./modelCapabilities.js";

function envMillis(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 1000 ? Math.floor(value) : fallback;
}

// Fallback deadline for provider calls that arrive without a caller signal.
// Chat routes always pass their own signal, so model generation is not capped
// by these values; they only bound helper calls that have no caller of their own.
const REQUEST_TIMEOUT_MS = envMillis("PROVIDER_TIMEOUT_MS", 60000);
const STREAM_TIMEOUT_MS = envMillis("PROVIDER_STREAM_TIMEOUT_MS", 300000);
const MAX_ERROR_LENGTH = 400;

export class ProviderError extends Error {
  constructor(message, status = null, code = "provider_error", retryAfter = null, diagnostics = null) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
    this.category = null;
    this.classification = null;
    this.retryable = null;
    this.diagnostics = diagnostics;
  }
}

const ENDPOINT_SUFFIX = /\/(chat\/completions|text\/chat|text\/chat_stream|responses|messages|completions|models|embeddings)$/i;
const AGENTROUTER_HOSTS = new Set(["agentrouter.org", "www.agentrouter.org"]);
// agentrouter.org answers an official-CLI fingerprint check before it checks the
// key, so a server-side client gets 401 unauthorized_client_error no matter how
// correct the request is. co.agentrouter.org is the documented host for
// third-party agents: OpenAI-compatible under /v1, Anthropic at the origin.
const AGENTROUTER_API_HOSTS = new Set(["co.agentrouter.org"]);
const ANTHROPIC_HOSTS = new Set(["api.anthropic.com", "www.api.anthropic.com"]);
const GOOGLE_GEMINI_HOSTS = new Set(["generativelanguage.googleapis.com"]);
const OPENCODE_ZEN_HOSTS = new Set(["opencode.ai", "www.opencode.ai"]);
const OPENROUTER_HOSTS = new Set(["openrouter.ai", "www.openrouter.ai"]);
const PROVIDER_TYPES = ["openai_compatible", "openai_responses", "anthropic_compatible", "azure_openai", "watsonx", "local_gateway", "native", "qoder_cloud_agents"];
const WATSONX_VERSION = "2024-10-08";
const WATSONX_LISTING_VERSION = "2024-10-10";
const WATSONX_IAM_URL = () => process.env.WATSONX_IAM_URL || "https://iam.cloud.ibm.com/identity/token";

// Bedrock's OpenAI-compatible Chat Completions/Responses routes live under
// /openai/v1 on the regional runtime endpoint, but that endpoint does not
// implement GET /models (AWS documents ListFoundationModels instead). A 403/404
// there just means "listing not supported", not "invalid key".
export function isBedrockHost(hostname) {
  return /^bedrock-(?:runtime|mantle)\.[a-z0-9-]+\.(?:amazonaws\.com|api\.aws)$/i.test(String(hostname || ""));
}

function isAgentRouterHost(hostname) {
  return AGENTROUTER_HOSTS.has(String(hostname || "").toLowerCase());
}

function isAgentRouterApiHost(hostname) {
  return AGENTROUTER_API_HOSTS.has(String(hostname || "").toLowerCase());
}

function isAnthropicHost(hostname) {
  return ANTHROPIC_HOSTS.has(String(hostname || "").toLowerCase());
}

export function isOpenCodeZenHost(hostname) {
  return OPENCODE_ZEN_HOSTS.has(String(hostname || "").toLowerCase());
}

export function isOpenCodeZenBase(value) {
  try {
    const parsed = new URL(String(value ?? "").trim());
    return isOpenCodeZenHost(parsed.hostname)
      && /^\/inference(?:\/(?:openai|anthropic|google|systemone|v\d+)(?:\/|$)|$)/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

export function isGoogleGeminiHost(hostname) {
  return GOOGLE_GEMINI_HOSTS.has(String(hostname || "").toLowerCase());
}

export function isGoogleGeminiBase(value) {
  try {
    return isGoogleGeminiHost(new URL(String(value ?? "").trim()).hostname);
  } catch {
    return false;
  }
}

// OpenRouter extends the OpenAI chat schema with two behaviours VupsRouter has
// to ask for explicitly: a final usage chunk on streams, and reasoning text
// delivered beside (not inside) delta.content.
export function isOpenRouterBase(value) {
  try {
    return OPENROUTER_HOSTS.has(new URL(String(value ?? "").trim()).hostname.toLowerCase());
  } catch {
    return false;
  }
}

// Google's OpenAI-compatible surface lives under /v1beta/openai. The native
// model catalogue and quota semantics live under /v1beta, so discovery and
// error classification branch on this host while chat stays OpenAI-shaped.
function googleGeminiModelsUrl(baseUrl) {
  return `${new URL(normalizeBaseUrl(baseUrl)).origin}/v1beta/models?pageSize=1000`;
}

function isGoogleNonChatModel(id) {
  return /(?:embedding|imagen|veo|lyria|tts|image|live|transcribe|audio|omni|computer-use|deep-research)/i.test(String(id ?? ""));
}

// OpenCode restricts its zero-cost Zen models to the official OpenCode client.
// Those IDs end in "-free" in the live catalogue. VupsRouter must not imitate
// that client or relay those models; it rejects them with an actionable error.
export function isOpenCodeZenFreeModel(model) {
  return /-free$/i.test(String(model ?? "").trim());
}

function rejectFreeZenModel(model) {
  const id = String(model ?? "").trim();
  if (!isOpenCodeZenFreeModel(id)) return;
  throw new ProviderError(
    `OpenCode Zen only allows its free model "${id}" inside the official OpenCode client, so VupsRouter cannot use it. Choose a paid OpenCode Zen model (add credits in the OpenCode Console) or connect another provider.`,
    403,
    "free_tier_client_only"
  );
}

// OpenCode Zen serves each model through one documented API family. The
// endpoint table is the source of truth, so route by model instead of asking
// users to change the protocol for every request.
export function opencodeZenProtocol(model) {
  const id = String(model ?? "").trim().toLowerCase();
  if (/^(?:gemini|jev)(?:-|$)/.test(id)) return "unsupported";
  if (/^claude(?:-|$)/.test(id)) return "anthropic";
  if (/^qwen/.test(id)) return /^qwen3\.8-max(?:-|$)/.test(id) ? "chat" : "anthropic";
  if (/^(?:gpt|grok|muse-spark)(?:-|$)/.test(id)) return "responses";
  return "chat";
}

function opencodeZenEndpoint(baseUrl, model) {
  rejectFreeZenModel(model);
  const family = opencodeZenProtocol(model);
  if (family === "unsupported") {
    throw new ProviderError(
      `OpenCode Zen serves "${String(model ?? "").trim()}" through a native API that VupsRouter does not support yet. Choose an OpenAI-compatible, Responses, or Anthropic Messages model instead.`,
      400,
      "unsupported_protocol"
    );
  }
  const origin = new URL(normalizeBaseUrl(baseUrl)).origin;
  if (family === "anthropic") return `${origin}/inference/anthropic/v1/messages`;
  if (family === "responses") return `${origin}/inference/openai/v1/responses`;
  return `${origin}/inference/openai/v1/chat/completions`;
}

function usesAnthropicApi(baseUrl, model, providerType) {
  if (isOpenCodeZenBase(baseUrl)) return opencodeZenProtocol(model) === "anthropic";
  return normalizeProviderType(providerType) === "anthropic_compatible";
}

export function normalizeProviderType(value) {
  return PROVIDER_TYPES.includes(value) ? value : "openai_compatible";
}

// Strips accidental endpoint suffixes so request URLs never end up doubled
// (e.g. ".../v1/chat/completions/chat/completions"). The "/v1" (or any other
// version) path segment is preserved; only the concrete operation paths are
// removed, since the client appends those itself. AgentRouter's and Anthropic's
// documented base URLs are versioned, so pasting only the origin is normalized.
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
  if ((isAgentRouterHost(parsed.hostname) || isAgentRouterApiHost(parsed.hostname) || isAnthropicHost(parsed.hostname)) && (cleanedPath === "" || /^(\/v\d+)+$/i.test(cleanedPath))) {
    cleanedPath = "/v1";
  }
  if (isGoogleGeminiHost(parsed.hostname) && (cleanedPath === "" || /^\/v1(?:beta)?$/i.test(cleanedPath) || /^\/openai$/i.test(cleanedPath))) {
    cleanedPath = "/v1beta/openai";
  }
  return parsed.origin + cleanedPath + parsed.search;
}

function anthropicBaseUrl(baseUrl) {
  const normalized = normalizeBaseUrl(baseUrl);
  const parsed = new URL(normalized);
  const path = parsed.pathname.replace(/\/+$/, "");
  if (!/\/v\d+$/i.test(path)) parsed.pathname = `${path}/v1`.replace(/\/{2,}/g, "/");
  return parsed.origin + parsed.pathname.replace(/\/+$/, "") + parsed.search;
}

// watsonx.ai inference lives under /ml/v1 on a regional cluster URL. Users may
// also append ?project_id=... to their base URL; it is required to route
// foundation-model calls and is forwarded to the API as project_id.
function watsonxBaseUrl(baseUrl) {
  const normalized = normalizeBaseUrl(baseUrl);
  const parsed = new URL(normalized);
  const path = parsed.pathname.replace(/\/+$/, "");
  if (/\/ml\/v\d+$/i.test(path)) {
    parsed.pathname = path;
  } else if (/\/ml$/i.test(path)) {
    parsed.pathname = `${path}/v1`;
  } else {
    parsed.pathname = `${path}/ml/v1`.replace(/\/{2,}/g, "/");
  }
  return parsed.origin + parsed.pathname.replace(/\/+$/, "");
}

export function watsonxProjectId(baseUrl) {
  try {
    return new URL(normalizeBaseUrl(baseUrl)).searchParams.get("project_id") || "";
  } catch {
    return "";
  }
}

function requireWatsonxProjectId(baseUrl) {
  const projectId = watsonxProjectId(baseUrl);
  if (!projectId) {
    throw new ProviderError(
      "watsonx.ai needs your project ID. Append ?project_id=your-project-id to the base URL — find it in your watsonx project under Manage > General.",
      400,
      "missing_project_id"
    );
  }
  return projectId;
}

// ─── Qoder Cloud Agents ──────────────────────────────────────────────────────
// Qoder's public API is a session/event protocol, not chat completions:
//   GET  /models                      enabled model IDs for the account
//   GET  /environments                sandboxes; a session needs an env_ ID
//   GET  /agents                      cursor-paged agents; a session needs agent_
//   POST /sessions                    { agent, environment_id } -> sess_...
//   GET  /sessions/{id}/events/stream  SSE
//   POST /sessions/{id}/events         { events: [{ type: "user.message", ... }] }
// Since 2026-08-24 the stream delivers only events created after the connection
// and never replays history, so the stream is opened before the message is sent.
// A reply arrives as incremental `event_delta` frames plus one authoritative
// buffered `agent.message`; the turn ends with `session.status_idle`.
// Qoder documents one region pair per deployment: token exchange happens on the
// OpenAPI host, business calls on the API host, and the two must share a region.
const QODER_REGIONS = {
  global: {
    label: "Global",
    businessBase: "https://api.qoder.com",
    openapiBase: "https://openapi.qoder.sh"
  },
  cn: {
    label: "China mainland",
    businessBase: "https://api.qoder.com.cn",
    openapiBase: "https://openapi.qoder.com.cn"
  }
};
const QODER_BUSINESS_HOSTS = new Map([
  ["api.qoder.com", "global"],
  ["www.api.qoder.com", "global"],
  ["api.qoder.com.cn", "cn"],
  ["www.api.qoder.com.cn", "cn"]
]);
const QODER_OPENAPI_HOSTS = new Map([
  ["openapi.qoder.sh", "global"],
  ["openapi.qoder.com.cn", "cn"]
]);
const QODER_CLOUD_PATH = "/api/v1/cloud";
// Cloud Agents is a Managed API. Forward is not implemented here, so only the
// scope this feature actually uses is requested — never forward.access.
const QODER_CLOUD_SCOPE = "qca.access";
const QODER_SAT_TTL_SECONDS = 3600;
const QODER_SAT_REFRESH_MARGIN_MS = 60000;
const QODER_AUTH_MODES = new Set(["pat", "service_account"]);
const QODER_ROLE_LABELS = { user: "User", assistant: "Assistant", system: "System" };
// Keyed on the credential fingerprint so two users of the same public host
// never share an environment or an agent.
const qoderEnvironmentCache = new Map();
const qoderAgentCache = new Map();
// Requested model name -> the id Qoder actually lists for that credential.
const qoderModelIdCache = new Map();
// Service account tokens are short-lived. They stay in process memory only and
// are refreshed from the SA key when they near expiry or are rejected.
const qoderSatCache = new Map();
// One exchange per credential at a time: concurrent requests for the same key
// await the same in-flight promise instead of each calling the token service.
const qoderSatPending = new Map();
// Qoder keeps the turn history inside the session, so one conversation reuses
// one session instead of paying for a new sandbox on every message.
const qoderSessionCache = new Map();
const QODER_SESSION_TTL_MS = 30 * 60 * 1000;
// A dropped SSE connection is resumed from the last event id, which Qoder
// documents as continuing delivery after that event.
const QODER_STREAM_RECONNECTS = 2;

export function qoderRegionForHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  return QODER_BUSINESS_HOSTS.get(host) || QODER_OPENAPI_HOSTS.get(host) || null;
}

function qoderCloudPath(pathname) {
  let path = String(pathname || "").replace(/\/+$/, "");
  if (/\/api\/v\d+\/forward(?:\/|$)/i.test(path)) {
    throw new ProviderError(
      "This build supports Qoder Cloud Agents (Managed) at /api/v1/cloud. Qoder Forward API endpoints are not implemented, so use the Cloud Agents base URL.",
      400,
      "unsupported_qoder_mode"
    );
  }
  const cloud = path.match(/^(.*\/api\/v\d+\/cloud)(?:\/|$)/i);
  if (cloud) return cloud[1];
  if (/\/api\/v\d+$/i.test(path)) return `${path}/cloud`;
  // A pasted /api/v1 root must not become /api/v1/api/v1/cloud.
  path = path.replace(/\/api\/v\d+(?=\/|$)/gi, "");
  return `${path}${QODER_CLOUD_PATH}`.replace(/\/{2,}/g, "/");
}

// The documented base URL may be a host, a host with /api/v1/cloud, or a host
// with extra path segments. Every form resolves to one canonical Cloud root.
export function qoderApiBase(baseUrl) {
  const parsed = new URL(normalizeBaseUrl(baseUrl));
  const host = parsed.hostname.toLowerCase();
  const businessRegion = QODER_BUSINESS_HOSTS.get(host);
  if (businessRegion) return `${QODER_REGIONS[businessRegion].businessBase}${QODER_CLOUD_PATH}`;
  const openapiRegion = QODER_OPENAPI_HOSTS.get(host);
  if (openapiRegion) return `${QODER_REGIONS[openapiRegion].businessBase}${QODER_CLOUD_PATH}`;
  return `${parsed.origin}${qoderCloudPath(parsed.pathname)}${parsed.search}`;
}

function qoderJoin(base, suffix) {
  const url = new URL(base);
  const extra = String(suffix || "").replace(/^\/+/, "").replace(/\/+$/, "");
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = extra ? `${path}/${extra}`.replace(/\/{2,}/g, "/") : path;
  return url.toString();
}

export function qoderOpenApiRoot(openapiBaseUrl) {
  const value = String(openapiBaseUrl || "").trim();
  if (!value) return "";
  const parsed = new URL(normalizeBaseUrl(value));
  const host = parsed.hostname.toLowerCase();
  const region = QODER_OPENAPI_HOSTS.get(host) || QODER_BUSINESS_HOSTS.get(host);
  if (region) return QODER_REGIONS[region].openapiBase;
  const path = parsed.pathname
    .replace(/\/+$/, "")
    .replace(/\/api\/v\d+\/serviceToken\/exchange$/i, "")
    .replace(/\/api\/v\d+$/i, "");
  return `${parsed.origin}${path}`;
}

export function qoderServiceTokenUrl(openapiBaseUrl) {
  const root = qoderOpenApiRoot(openapiBaseUrl);
  if (!root) {
    throw new ProviderError(
      "Qoder service account keys need the OpenAPI base URL for token exchange. Use https://openapi.qoder.sh (global) or https://openapi.qoder.com.cn (China).",
      400,
      "missing_openapi_url"
    );
  }
  const parsed = new URL(root);
  let path = parsed.pathname.replace(/\/+$/, "");
  if (!/\/api\/v\d+$/i.test(path)) path = `${path}/api/v1`.replace(/\/{2,}/g, "/");
  parsed.pathname = `${path}/serviceToken/exchange`.replace(/\/{2,}/g, "/");
  parsed.search = "";
  return parsed.toString();
}

function qoderCredentials({ baseUrl, apiKey, authMode = "pat", openapiBaseUrl = "" }) {
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    throw new ProviderError("Enter a Qoder PAT or service account key first.", 400, "missing_api_key");
  }
  const mode = QODER_AUTH_MODES.has(authMode) ? authMode : "pat";
  const businessBase = qoderApiBase(baseUrl);
  const businessHost = new URL(businessBase).hostname.toLowerCase();
  const region = qoderRegionForHost(businessHost) || qoderRegionForHost(new URL(normalizeBaseUrl(baseUrl)).hostname) || null;
  if (new URL(businessBase).protocol !== "https:" && !privateProviderUrlsAllowed()) {
    throw new ProviderError("Qoder's API URL must use HTTPS. Use https://api.qoder.com or https://api.qoder.com.cn.", 400, "invalid_base_url");
  }
  let openapiRoot = "";
  if (mode === "service_account") {
    const configured = String(openapiBaseUrl || "").trim() || (region ? QODER_REGIONS[region].openapiBase : "");
    openapiRoot = qoderOpenApiRoot(configured);
    if (!openapiRoot) {
      throw new ProviderError(
        "Qoder service account keys need the OpenAPI base URL for token exchange. Use https://openapi.qoder.sh (global) or https://openapi.qoder.com.cn (China).",
        400,
        "missing_openapi_url"
      );
    }
    const openapiHost = new URL(openapiRoot).hostname.toLowerCase();
    const openapiRegion = qoderRegionForHost(openapiHost);
    if (region && openapiRegion && region !== openapiRegion) {
      const label = value => (value === "cn" ? "China mainland" : "Global");
      throw new ProviderError(
        `The Qoder API URL is ${label(region)} but the OpenAPI URL is ${label(openapiRegion)}. Token exchange and business calls must use the same region.`,
        400,
        "incorrect_region"
      );
    }
    if (new URL(openapiRoot).protocol !== "https:" && !privateProviderUrlsAllowed()) {
      throw new ProviderError("Qoder's OpenAPI URL must use HTTPS.", 400, "invalid_base_url");
    }
  }
  return {
    apiKey: apiKey.trim(),
    authMode: mode,
    businessBase,
    businessHost,
    region,
    openapiRoot,
    exchangeUrl: openapiRoot ? qoderServiceTokenUrl(openapiRoot) : ""
  };
}

// URL/region validation without a credential, reused by the settings routes
// before anything is saved.
export function validateQoderSettings({ baseUrl, authMode = "pat", openapiBaseUrl = "" }) {
  qoderCredentials({ baseUrl, apiKey: "validation-placeholder", authMode, openapiBaseUrl });
}

function qoderSatCacheKey(credentials) {
  return createHash("sha256").update(`qoder-sat|${credentials.openapiRoot}|${credentials.apiKey}`).digest("hex");
}

function qoderTokenExpiryMs(payload, token) {
  const now = Date.now();
  const expiresIn = Number(payload?.expires_in ?? payload?.expiresIn);
  if (Number.isFinite(expiresIn) && expiresIn > 0) return now + Math.min(expiresIn, 43200) * 1000;
  const rawExpiry = payload?.expires_at ?? payload?.expiresAt;
  if (typeof rawExpiry === "string" && rawExpiry.trim()) {
    const parsed = Date.parse(rawExpiry);
    if (Number.isFinite(parsed)) return parsed;
  }
  const numeric = Number(rawExpiry);
  if (Number.isFinite(numeric) && numeric > 0) return numeric > 1e12 ? numeric : numeric * 1000;
  const parts = String(token || "").split(".");
  if (parts.length === 3) {
    try {
      const claims = JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
      const exp = Number(claims?.exp);
      if (Number.isFinite(exp) && exp > 0) return exp * 1000;
    } catch {
      /* not a JWT; fall back to the requested TTL */
    }
  }
  return now + QODER_SAT_TTL_SECONDS * 1000;
}

function qoderExchangeFailure(config, status, payload) {
  const detail = sanitizedErrorDetail(payload);
  const suffix = detail ? ` Qoder said: ${detail}` : "";
  if (status === 400) {
    return new ProviderError(
      `Qoder rejected the service token request (HTTP 400). Check the qca.access scope and the service account key.${suffix}`,
      status,
      "bad_request"
    );
  }
  if (status === 401) {
    return new ProviderError(
      `Qoder rejected the service account key (HTTP 401). Create a new key in the Qoder organization console and try again.${suffix}`,
      status,
      "invalid_api_key"
    );
  }
  if (status === 403) {
    return new ProviderError(
      `The service account key is not allowed to request qca.access (HTTP 403). Grant the Cloud Agents scope to this key.${suffix}`,
      status,
      "insufficient_scope"
    );
  }
  if (status === 404) {
    return new ProviderError(
      "The Qoder OpenAPI host has no service token endpoint (HTTP 404). Check the region: https://openapi.qoder.sh for Global or https://openapi.qoder.com.cn for China mainland.",
      status,
      "incorrect_region"
    );
  }
  if (status === 429) {
    return new ProviderError(`Qoder is rate-limiting token exchanges (HTTP 429). Wait a moment and try again.${suffix}`, status, "rate_limited");
  }
  if (typeof status === "number" && status >= 500) {
    return new ProviderError(`Qoder's token service is temporarily unavailable (HTTP ${status}).${suffix}`, status, "provider_unavailable");
  }
  return new ProviderError(`Qoder's token service returned an unexpected error (HTTP ${status}).${suffix}`, status, "provider_error");
}

async function qoderExchangeServiceToken(config, signal) {
  const url = config.exchangeUrl;
  const context = { stage: "token_exchange", authMode: config.authMode, region: config.region };
  let response;
  try {
    response = await guardedProviderFetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        grant_type: "client_credentials",
        audience: "qoder",
        scope: QODER_CLOUD_SCOPE,
        ttl_seconds: QODER_SAT_TTL_SECONDS
      }),
      signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      const timeout = attachProviderDiagnostic(
        new ProviderError("Timed out while exchanging the Qoder service account key (token exchange).", null, "timeout"),
        { url, context, classification: { category: "timeout", classification: "transient", retryable: true } }
      );
      timeout.qoderStage = "token_exchange";
      throw timeout;
    }
    if (error instanceof ProviderError) {
      error.qoderStage = error.qoderStage || "token_exchange";
      throw error;
    }
    const failure = networkError(error, url, context);
    failure.qoderStage = "token_exchange";
    throw failure;
  }
  const payload = await readJsonSafely(response);
  if (!response.ok) {
    // Never include access_token from an unexpected 2xx-shaped body in logs.
    const safePayload = payload && typeof payload === "object" ? { ...payload, access_token: undefined } : payload;
    const failure = attachProviderDiagnostic(
      qoderExchangeFailure(config, response.status, safePayload),
      { url, status: response.status, payload: safePayload, headers: response.headers, context, retryAfter: parseRetryAfter(response.headers.get("retry-after")) }
    );
    failure.qoderStage = "token_exchange";
    throw failure;
  }
  const token = typeof payload?.access_token === "string" ? payload.access_token.trim() : "";
  if (!token) {
    const failure = attachProviderDiagnostic(
      new ProviderError(
        "Qoder's token exchange returned no access_token. Check that the service account key is active and that qca.access is allowed.",
        502,
        "invalid_response"
      ),
      { url, status: response.status, context, headers: response.headers, classification: { category: "invalid_response", classification: "permanent", retryable: false } }
    );
    failure.qoderStage = "token_exchange";
    throw failure;
  }
  const expiresAt = qoderTokenExpiryMs(payload, token);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() + 5000) {
    const failure = attachProviderDiagnostic(
      new ProviderError("Qoder returned a service token that is already expired. Check the server clock and try again.", 502, "invalid_response"),
      { url, status: response.status, context, classification: { category: "invalid_response", classification: "permanent", retryable: false } }
    );
    failure.qoderStage = "token_exchange";
    throw failure;
  }
  return { token, expiresAt };
}

async function qoderAccessToken(credentials) {
  if (credentials.authMode !== "service_account") return credentials.apiKey;
  const key = qoderSatCacheKey(credentials);
  const cached = qoderSatCache.get(key);
  if (cached && cached.expiresAt > Date.now() + QODER_SAT_REFRESH_MARGIN_MS) return cached.token;
  // Resolving an agent and an environment run concurrently, so without sharing
  // the in-flight exchange each branch would spend a service account key on its
  // own request to the token service.
  const pending = qoderSatPending.get(key);
  if (pending) return pending;
  // The exchange belongs to every waiter, so it gets its own timeout instead of
  // the first caller's: one client pressing Stop must not cancel a token another
  // live request is waiting for.
  const exchange = (async () => {
    try {
      const issued = await qoderExchangeServiceToken(credentials, AbortSignal.timeout(REQUEST_TIMEOUT_MS));
      qoderSatCache.set(key, issued);
      if (qoderSatCache.size > 200) {
        for (const [entryKey, entry] of qoderSatCache) {
          if (entry.expiresAt <= Date.now()) qoderSatCache.delete(entryKey);
        }
        while (qoderSatCache.size > 200) qoderSatCache.delete(qoderSatCache.keys().next().value);
      }
      return issued.token;
    } finally {
      if (qoderSatPending.get(key) === exchange) qoderSatPending.delete(key);
    }
  })();
  qoderSatPending.set(key, exchange);
  return exchange;
}

async function qoderAuthHeaders(credentials, accept) {
  const headers = {
    "Content-Type": "application/json",
    Accept: accept || "application/json",
    Authorization: `Bearer ${await qoderAccessToken(credentials)}`
  };
  return headers;
}

function qoderBusinessError(url, response, payload, credentials, context) {
  const error = providerHttpError(
    url,
    response.status,
    payload,
    parseRetryAfter(response.headers.get("retry-after")),
    response.headers,
    { ...context, authMode: credentials.authMode, region: credentials.region }
  );
  error.qoderStage = "business_api";
  const detail = sanitizedErrorDetail(payload);
  const suffix = detail ? ` Qoder said: ${detail}` : "";
  if (response.status === 401) {
    error.code = "invalid_api_key";
    error.message =
      credentials.authMode === "service_account"
        ? `Qoder rejected the service account token (HTTP 401) even after a fresh exchange. Check that the key is active and allowed to use Cloud Agents.${suffix}`
        : `Qoder rejected the personal access token (HTTP 401). Create a new token in Qoder Settings → Personal Access Tokens.${suffix}`;
  } else if (response.status === 403) {
    error.code = "insufficient_scope";
    error.message = `Qoder denied the request (HTTP 403). The credential is missing the qca.access scope or access to Cloud Agents.${suffix}`;
  } else if (response.status === 404) {
    error.code = "not_found";
    error.message =
      "Qoder returned HTTP 404. Check the API base URL: it must be the business host (https://api.qoder.com or https://api.qoder.com.cn) with /api/v1/cloud, not the OpenAPI host.";
  } else if (response.status === 409) {
    // Qoder answers 409 while a turn is still running, so the message has to
    // say what to do rather than report a generic failure.
    const busy = String(url).endsWith("/events") || /processing a turn|rescheduling/i.test(detail);
    error.code = busy ? "session_busy" : "provider_conflict";
    error.message = busy
      ? `Qoder is still working on the previous reply in this conversation (HTTP 409). Wait for it to finish, or press Stop and send again.${suffix}`
      : `Qoder rejected the request because the session is in a conflicting state (HTTP 409).${suffix}`;
  }
  return error;
}

function qoderCacheKey(credentials) {
  const fingerprint = createHash("sha256").update(String(credentials.apiKey || "")).digest("hex").slice(0, 16);
  return `${credentials.businessBase}|${fingerprint}`;
}

function qoderRemember(cache, key, value) {
  if (cache.size > 200) cache.clear();
  cache.set(key, value);
  return value;
}

async function qoderRequest(url, { method = "GET", body, accept, credentials, extraHeaders = null }, signal, context = {}) {
  for (let attempt = 0; ; attempt += 1) {
    const headers = await qoderAuthHeaders(credentials, accept);
    let response;
    try {
      response = await guardedProviderFetch(url, {
        method,
        headers: extraHeaders ? { ...headers, ...extraHeaders } : headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
    } catch (error) {
      if (error?.name === "TimeoutError") {
        throw attachProviderDiagnostic(
          new ProviderError("Timed out while contacting Qoder Cloud Agents.", null, "timeout"),
          { url, context, classification: { category: "timeout", classification: "transient", retryable: true } }
        );
      }
      if (error?.name === "AbortError" && signal?.aborted) throw new ProviderError("Request cancelled.", null, "cancelled");
      if (error instanceof ProviderError) throw error;
      throw networkError(error, url, context);
    }
    if (response.ok) return response;
    const payload = await readJsonSafely(response);
    const error = qoderBusinessError(url, response, payload, credentials, context);
    // A SAT can expire or be revoked between exchange and use. Discard it and
    // retry once with a freshly exchanged token; the second 401 is final.
    if (attempt === 0 && credentials.authMode === "service_account" && error.status === 401) {
      qoderSatCache.delete(qoderSatCacheKey(credentials));
      continue;
    }
    throw error;
  }
}

async function qoderModelEntries(credentials, signal, context) {
  const url = qoderJoin(credentials.businessBase, "models");
  const response = await qoderRequest(url, { credentials }, signal, context);
  const payload = await readJsonSafely(response);
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.data)) {
    throw attachProviderDiagnostic(
      new ProviderError("Qoder's model list response was not in the documented shape (expected a data array).", 502, "invalid_response"),
      { url, status: response.status, payload, headers: response.headers, context, classification: { category: "invalid_response", classification: "permanent", retryable: false } }
    );
  }
  return payload.data.filter(entry => entry?.is_enabled !== false);
}

async function qoderListModels(credentials, signal) {
  const context = { stage: "business_api", operation: "models", authMode: credentials.authMode, region: credentials.region };
  const entries = await qoderModelEntries(credentials, signal, context);
  return entries
    .map(entry => {
      const id = typeof entry?.id === "string" ? entry.id.trim() : "";
      if (!id) return null;
      const displayName = typeof entry?.display_name === "string" && entry.display_name.trim() ? entry.display_name.trim() : id;
      // Agents are created without a context_window, so the documented default
      // window is what actually applies to this conversation - not the model's
      // ceiling. Warning at the real number keeps a Qoder rejection from
      // arriving as a surprise mid-chat.
      const defaultWindow = Number.isFinite(entry?.default_context_window) ? entry.default_context_window : null;
      const ceiling = Number.isFinite(entry?.max_input_tokens) ? entry.max_input_tokens : null;
      const contextLength = defaultWindow ?? ceiling;
      const capabilities = { chat: true, streaming: true, ...(contextLength ? { contextLength } : {}) };
      return {
        id,
        // "user" means a model the account registered itself, which is not a
        // Qoder-hosted model and must not be labelled as one.
        ownedBy: entry?.source === "user" ? `Qoder custom model · ${displayName}` : `Qoder · ${displayName}`,
        vision: visionFromCapabilities(capabilities),
        capabilities,
        contextLength,
        maxOutputTokens: null
      };
    })
    .filter(Boolean)
    .slice(0, 1000);
}

// Qoder's model ids are opaque (`qfmodel`) while its console shows a display
// name (`Qwen3.8-Flash`), and creating a session with a name it does not list
// fails with "Field 'model' must reference an available model". A saved model
// may carry either spelling, so the requested name is resolved against the
// account's own list before an agent is created.
function qoderModelKey(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

async function qoderResolveModelId(credentials, requestedModel, signal, context) {
  const wanted = String(requestedModel || "").trim();
  if (!wanted) return wanted;
  const cacheKey = `${qoderCacheKey(credentials)}|${qoderModelKey(wanted)}`;
  if (qoderModelIdCache.has(cacheKey)) return qoderModelIdCache.get(cacheKey);
  let entries;
  try {
    entries = await qoderModelEntries(credentials, signal, { ...context, operation: "models" });
  } catch {
    // Resolution is a convenience: when the list itself is unreachable, send the
    // saved name through and let Qoder answer for itself.
    return wanted;
  }
  const rows = entries
    .map(entry => ({
      id: typeof entry?.id === "string" ? entry.id.trim() : "",
      name: typeof entry?.display_name === "string" ? entry.display_name.trim() : ""
    }))
    .filter(row => row.id);
  const wantedKey = qoderModelKey(wanted);
  const exact = rows.find(row => row.id.toLowerCase() === wanted.toLowerCase());
  const byName = rows.filter(row => qoderModelKey(row.name || row.id) === wantedKey);
  const match = exact || (byName.length === 1 ? byName[0] : null);
  if (!match) {
    const available = rows.map(row => row.id).slice(0, 8).join(", ");
    throw new ProviderError(
      `Qoder does not list a model called "${wanted}". ${available ? `This account has ${available}.` : "This account has no enabled models."}`,
      400,
      "invalid_model"
    );
  }
  return qoderRemember(qoderModelIdCache, cacheKey, match.id);
}

// Read-only fallback used when /models is unavailable: it still proves the
// credential can reach the business API, without creating anything.
async function qoderProbeAgents(credentials, signal) {
  const url = new URL(qoderJoin(credentials.businessBase, "agents"));
  url.searchParams.set("limit", "1");
  const context = { stage: "business_api", operation: "agents", authMode: credentials.authMode, region: credentials.region };
  const response = await qoderRequest(url.toString(), { credentials }, signal, context);
  const payload = await readJsonSafely(response);
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.data)) {
    throw attachProviderDiagnostic(
      new ProviderError("Qoder's agents response was not in the documented shape (expected a data array).", 502, "invalid_response"),
      { url: url.toString(), status: response.status, payload, headers: response.headers, context, classification: { category: "invalid_response", classification: "permanent", retryable: false } }
    );
  }
  return payload;
}

// The API requires an existing environment. Use the account's first one and
// only create the documented cloud default when the account has none.
async function qoderEnvironmentId(credentials, signal, context) {
  const base = credentials.businessBase;
  const cacheKey = qoderCacheKey(credentials);
  if (qoderEnvironmentCache.has(cacheKey)) return qoderEnvironmentCache.get(cacheKey);
  const listed = await qoderRequest(qoderJoin(base, "environments"), { credentials }, signal, context);
  const existing = (await readJsonSafely(listed))?.data?.[0];
  if (existing?.id) return qoderRemember(qoderEnvironmentCache, cacheKey, existing.id);
  const created = await qoderRequest(qoderJoin(base, "environments"), {
    method: "POST",
    credentials,
    body: { name: "VupsRouter", config: { type: "cloud" } }
  }, signal, context);
  const id = (await readJsonSafely(created))?.id;
  if (typeof id !== "string" || !id) {
    throw new ProviderError("Qoder Cloud Agents created no environment. Create one in your Qoder console and try again.", 502, "qoder_no_environment");
  }
  return qoderRemember(qoderEnvironmentCache, cacheKey, id);
}

// An agent fixes the model, so one agent per (credential, model) is reused.
async function qoderAgentId(credentials, requestedModel, signal, context) {
  const base = credentials.businessBase;
  const model = await qoderResolveModelId(credentials, requestedModel, signal, context);
  const cacheKey = `${qoderCacheKey(credentials)}|${model}`;
  if (qoderAgentCache.has(cacheKey)) return qoderAgentCache.get(cacheKey);
  let page = "";
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const listUrl = new URL(qoderJoin(base, "agents"));
    listUrl.searchParams.set("limit", "100");
    if (page) listUrl.searchParams.set("page", page);
    const listed = await qoderRequest(listUrl.toString(), { credentials }, signal, context);
    const payload = await readJsonSafely(listed);
    const match = (Array.isArray(payload?.data) ? payload.data : [])
      .find(agent => agent?.archived_at === null && (agent?.model === model || agent?.model?.id === model));
    if (match?.id) return qoderRemember(qoderAgentCache, cacheKey, match.id);
    if (!payload?.has_more || !payload?.next_page) break;
    page = payload.next_page;
  }
  const created = await qoderRequest(qoderJoin(base, "agents"), {
    method: "POST",
    credentials,
    // Qoder documents `model` as string | { id, effort, context_window }. Only
    // the string form is sent: effort and context tiers are per-model choices
    // this product never asks for, and inventing one would change how a reply is
    // produced on the user's credit. The matcher above already reads both shapes
    // back, so an agent tuned in the Qoder console is still reused.
    body: { name: `VupsRouter ${model}`, model, system: "You are a helpful assistant." }
  }, signal, context);
  const id = (await readJsonSafely(created))?.id;
  if (typeof id !== "string" || !id) {
    throw new ProviderError("Qoder Cloud Agents created no agent for this model. Choose another model or create the agent in your Qoder console.", 502, "qoder_no_agent");
  }
  return qoderRemember(qoderAgentCache, cacheKey, id);
}

// Images use Qoder's documented base64/url source blocks, and each turn is one
// batch of events: a reused session receives only the newest user message, while
// a brand new session receives the whole conversation flattened into its first
// batch because it starts with no history of its own.
export function qoderEventContent(messages = []) {
  const blocks = [];
  for (const message of messages) {
    const label = QODER_ROLE_LABELS[message?.role] || "User";
    const text = typeof message?.content === "string"
      ? message.content
      : Array.isArray(message?.content)
        ? message.content.filter(part => part?.type === "text").map(part => part?.text || "").join("\n")
        : "";
    if (text.trim()) blocks.push({ type: "text", text: `[${label}]\n${text.trim()}` });
    for (const image of Array.isArray(message?.images) ? message.images : []) {
      if (typeof image?.url === "string" && image.url) {
        blocks.push({ type: "image", source: { type: "url", url: image.url } });
      } else if (typeof image?.data === "string" && image.data) {
        blocks.push({ type: "image", source: { type: "base64", media_type: image.mimeType, data: image.data } });
      }
    }
  }
  return blocks;
}

function qoderSessionCacheKey(credentials, conversationId, agentId) {
  return `${qoderCacheKey(credentials)}|${agentId}|${conversationId}`;
}

function qoderLiveSession(key) {
  const entry = qoderSessionCache.get(key);
  if (!entry) return "";
  if (entry.expiresAt <= Date.now()) {
    qoderSessionCache.delete(key);
    return "";
  }
  return entry.sessionId;
}

function qoderRememberSession(key, sessionId, posted) {
  if (qoderSessionCache.size > 500) {
    for (const [entryKey, entry] of qoderSessionCache) {
      if (entry.expiresAt <= Date.now()) qoderSessionCache.delete(entryKey);
    }
    while (qoderSessionCache.size > 500) qoderSessionCache.delete(qoderSessionCache.keys().next().value);
  }
  qoderSessionCache.set(key, { sessionId, posted, expiresAt: Date.now() + QODER_SESSION_TTL_MS });
}

async function qoderCreateSession(credentials, { agentId, environmentId }, signal, context) {
  const response = await qoderRequest(qoderJoin(credentials.businessBase, "sessions"), {
    method: "POST",
    credentials,
    body: { agent: agentId, environment_id: environmentId, title: "VupsRouter" }
  }, signal, context);
  const sessionId = (await readJsonSafely(response))?.id;
  if (typeof sessionId !== "string" || !sessionId.startsWith("sess_")) {
    throw new ProviderError("Qoder Cloud Agents returned a session without an ID.", 502, "qoder_no_session");
  }
  return sessionId;
}

// Qoder rejects a new message with 409 while the session is still working, and
// the only documented way to free it is an interrupt, so a cancelled request has
// to interrupt its own turn or the next message in that conversation is blocked.
async function qoderInterruptTurn(credentials, sessionId) {
  try {
    await qoderRequest(qoderJoin(credentials.businessBase, `sessions/${sessionId}/events`), {
      method: "POST",
      credentials,
      body: { events: [{ type: "user.interrupt" }] }
    }, AbortSignal.timeout(REQUEST_TIMEOUT_MS), { stage: "business_api", operation: "interrupt" });
  } catch {
    // The user is already walking away from this turn; nothing to report.
  }
}

// Only the newest user turn goes to a session that already holds the
// conversation: re-sending the flattened history would run the same turn twice.
function qoderLatestTurnContent(messages = []) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role !== "user") continue;
    const blocks = qoderEventContent([messages[index]]);
    if (blocks.length) return blocks;
  }
  return [];
}

async function qoderStartStream({ baseUrl, apiKey, authMode, openapiBaseUrl, model, messages, conversationId = null, clientSignal = null, requestId = null, attempt = null }, signal) {
  const credentials = qoderCredentials({ baseUrl, apiKey, authMode, openapiBaseUrl });
  const base = credentials.businessBase;
  const context = { requestId, attempt, model, authMode: credentials.authMode, region: credentials.region };
  const [environmentId, agentId] = await Promise.all([
    qoderEnvironmentId(credentials, signal, context),
    qoderAgentId(credentials, model, signal, context)
  ]);
  const streamUrl = sessionId => {
    const url = new URL(qoderJoin(base, `sessions/${sessionId}/events/stream`));
    url.searchParams.append("event_deltas[]", "agent.message");
    return url.toString();
  };
  const openStream = (sessionId, lastEventId) => qoderRequest(
    streamUrl(sessionId),
    { credentials, accept: "text/event-stream", extraHeaders: lastEventId ? { "Last-Event-ID": lastEventId } : null },
    signal ?? AbortSignal.timeout(STREAM_TIMEOUT_MS),
    context
  );
  const key = conversationId ? qoderSessionCacheKey(credentials, conversationId, agentId) : "";
  let sessionId = key ? qoderLiveSession(key) : "";
  // A brand new session starts with no history of its own, so its first batch
  // carries the whole conversation; a reused session already has it, so only the
  // newest user message is sent.
  let content = sessionId ? qoderLatestTurnContent(messages) : [];
  if (!sessionId || !content.length) content = qoderEventContent(messages);
  if (!content.length) {
    throw new ProviderError("There was no message to send to Qoder.", 400, "empty_request");
  }
  let signature = JSON.stringify(content);
  // The chat route retries a dropped turn with the same parameters. Re-sending
  // that same batch would run the turn twice, so an already-posted batch is
  // resumed by reading the stream instead.
  let alreadyPosted = Boolean(key) && qoderSessionCache.get(key)?.posted === signature;
  let stream = null;
  if (sessionId) {
    try {
      stream = await openStream(sessionId, "");
    } catch (error) {
      // A session archived or deleted since the last turn is recoverable: a new
      // one takes the whole transcript so the conversation still continues.
      if (error?.status !== 404) throw error;
      qoderSessionCache.delete(key);
      sessionId = "";
    }
  }
  if (!sessionId) {
    sessionId = await qoderCreateSession(credentials, { agentId, environmentId }, signal, context);
    content = qoderEventContent(messages);
    signature = JSON.stringify(content);
    alreadyPosted = false;
    stream = await openStream(sessionId, "");
  }
  if (!stream.body) {
    throw attachProviderDiagnostic(
      new ProviderError("Qoder Cloud Agents did not return an event stream.", stream.status, "empty_stream"),
      { url: streamUrl(sessionId), status: stream.status, context, headers: stream.headers, classification: { category: "empty_stream", classification: "permanent", retryable: false } }
    );
  }
  // Executing only after the stream is attached is what makes the first deltas
  // of this turn observable; since 2026-08-24 Qoder does not replay history.
  if (!alreadyPosted) {
    try {
      await qoderRequest(qoderJoin(base, `sessions/${sessionId}/events`), {
        method: "POST",
        credentials,
        body: { events: [{ type: "user.message", content }] }
      }, signal, context);
    } catch (error) {
      stream.body.cancel().catch(() => {});
      if (key && error?.status === 404) qoderSessionCache.delete(key);
      throw error;
    }
  }
  if (key) qoderRememberSession(key, sessionId, signature);
  const turn = { finished: false };
  // The route's own signal can abort while it deliberately retries a turn, so
  // only the caller's signal means "the user stopped waiting".
  const cancelSignal = clientSignal ?? null;
  if (key && cancelSignal && !cancelSignal.aborted) {
    const activeSession = sessionId;
    cancelSignal.addEventListener("abort", () => {
      if (!turn.finished) qoderInterruptTurn(credentials, activeSession);
    }, { once: true });
  }
  const body = qoderSSEToChatStream(stream.body, {
    turn,
    reopen: lastEventId => openStream(sessionId, lastEventId),
    aborted: () => Boolean(cancelSignal?.aborted),
    onTerminal: () => {
      if (key) qoderSessionCache.delete(key);
    }
  });
  const response = new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  });
  Object.defineProperty(response, "url", { value: streamUrl(sessionId), configurable: true });
  return response;
}

// Reads SSE frames until the turn finishes, the connection ends, or reading
// fails. `state.reader` is exposed so the outer stream can cancel whichever
// connection is live, including after a reconnect.
async function qoderReadFrames(body, state, onFrame) {
  const reader = body.getReader();
  state.reader = reader;
  const decoder = new TextDecoder();
  let pending = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      let boundary = pending.indexOf("\n\n");
      while (boundary !== -1) {
        const frame = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        onFrame(frame);
        if (state.closed) {
          reader.cancel().catch(() => {});
          return { kind: "stopped" };
        }
        boundary = pending.indexOf("\n\n");
      }
    }
    if (pending.trim()) {
      onFrame(pending);
      if (state.closed) {
        reader.cancel().catch(() => {});
        return { kind: "stopped" };
      }
    }
    return { kind: "ended" };
  } catch (error) {
    return { kind: "error", error };
  }
}

function qoderSSEToChatStream(sourceBody, { turn = null, reopen = null, aborted = null, onTerminal = null } = {}) {
  const encoder = new TextEncoder();
  const streamedByEvent = new Map();
  const deltaOnlyEvents = new Set();
  const foldedEvents = new Set();
  const state = { closed: false, reader: null, lastEventId: "" };
  const finished = turn || { finished: false };

  return new ReadableStream({
    async start(controller) {
      const push = data => {
        if (state.closed) return;
        controller.enqueue(encoder.encode(`data: ${data}\n\n`));
      };
      const sendText = text => push(JSON.stringify({ choices: [{ delta: { content: text } }] }));
      const finish = () => {
        if (state.closed) return;
        state.closed = true;
        finished.finished = true;
        // The terminal frames go out after the guard flips, so they are written
        // exactly once even when a reconnect races with the end of the turn.
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        } catch {
          // The reader cancelled mid-turn, so there is nobody left to notify.
        }
      };
      const handleFrame = frame => {
        let eventName = "";
        let data = "";
        for (const line of frame.split("\n")) {
          if (line.startsWith(":")) continue;
          if (line.startsWith("event:")) eventName = line.slice(6).trim();
          else if (line.startsWith("data:")) data += (data ? "\n" : "") + line.slice(5).trim();
          else if (line.startsWith("id:")) state.lastEventId = line.slice(3).trim() || state.lastEventId;
        }
        if (!data) {
          // ": heartbeat" keeps the connection open; forward an empty chunk so
          // the chat route's stream-idle watchdog does not fire mid-turn.
          push(JSON.stringify({ choices: [{ delta: {} }] }));
          return;
        }
        let payload;
        try {
          payload = JSON.parse(data);
        } catch {
          return;
        }
        const type = typeof payload?.type === "string" ? payload.type : eventName;
        if (type === "event_start") {
          const id = String(payload?.event?.id || "");
          if (id && payload?.event?.type !== "agent.message") deltaOnlyEvents.add(id);
          return;
        }
        if (type === "event_delta") {
          const id = String(payload?.event_id || "");
          if (deltaOnlyEvents.has(id) || foldedEvents.has(id)) return;
          const text = payload?.delta?.type === "content_delta" ? payload.delta.content?.text : "";
          if (typeof text !== "string" || !text) return;
          streamedByEvent.set(id, (streamedByEvent.get(id) || "") + text);
          sendText(text);
          return;
        }
        if (type === "agent.message") {
          const id = String(payload?.id || "");
          // A replayed buffered event after a reconnect is the same answer twice.
          if (id && foldedEvents.has(id)) return;
          const full = (Array.isArray(payload?.content) ? payload.content : [])
            .filter(block => block?.type === "text" && typeof block.text === "string")
            .map(block => block.text)
            .join("");
          if (full) {
            const already = streamedByEvent.get(id) || "";
            const rest = full.startsWith(already) ? full.slice(already.length) : "";
            if (rest) sendText(rest);
            streamedByEvent.set(id, full);
          }
          if (id) foldedEvents.add(id);
          return;
        }
        if (type === "session.status_idle") {
          finish();
        } else if (type === "session.status_terminated" || type === "session.deleted") {
          if (onTerminal) onTerminal();
          finish();
        }
      };

      let body = sourceBody;
      let outcome = { kind: "ended" };
      for (let connection = 0; !state.closed; connection += 1) {
        outcome = await qoderReadFrames(body, state, handleFrame);
        if (state.closed) break;
        // A cancelled turn must not come back as a new connection: the interrupt
        // already told Qoder to stop, and the reader is gone either way.
        if (aborted?.()) break;
        // Qoder resumes after the event id it last stamped on the wire, so a
        // dropped connection continues the same turn instead of losing it.
        if (!reopen || !state.lastEventId || connection >= QODER_STREAM_RECONNECTS) break;
        try {
          const next = await reopen(state.lastEventId);
          if (!next?.body) break;
          body = next.body;
        } catch (error) {
          if (!state.closed) {
            state.closed = true;
            finished.finished = true;
            controller.error(error);
          }
          return;
        }
      }
      if (outcome.kind === "error" && !state.closed && !aborted?.()) {
        state.closed = true;
        finished.finished = true;
        controller.error(outcome.error);
        return;
      }
      finish();
    },
    cancel(reason) {
      state.reader?.cancel(reason).catch(() => {});
    }
  });
}

async function qoderCompletion(params, signal) {
  const response = await qoderStartStream(params, signal);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let content = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const raw = trimmed.slice(5).trim();
      if (!raw || raw === "[DONE]") continue;
      try {
        content += extractStreamText(JSON.parse(raw));
      } catch {
        continue;
      }
    }
  }
  // Qoder has no tool channel, so an ordinary answer and a tool request both
  // arrive as text. The same validator and registry that guard every other
  // transport decide whether a block is a real call.
  const parsed = Array.isArray(params?.tools) && params.tools.length > 0
    ? parseTextToolCalls(content, params.tools)
    : { content, toolCalls: [] };
  if (!parsed.content && parsed.toolCalls.length === 0) {
    throw new ProviderError("Qoder Cloud Agents returned an empty response.", null, "empty_response");
  }
  return {
    content: parsed.content,
    toolTransport: "text",
    finishReason: parsed.toolCalls.length > 0 ? "tool_calls" : "stop",
    ...(parsed.toolCalls.length > 0
      ? {
        toolCalls: parsed.toolCalls,
        assistantMessage: {
          role: "assistant",
          content: parsed.content || null,
          tool_calls: parsed.toolCalls
        }
      }
      : {})
  };
}

// ─── end Qoder helpers ──────────────────────────────────────────────────────

// Every provider reaches the same tool registry through one of four
// transports. Native tool calling is used where the provider documents it;
// providers without it get the validated text protocol below, so the selected
// model never decides whether local tools exist.
export function resolveToolTransport(baseUrl, model, providerType = "openai_compatible") {
  const type = normalizeProviderType(providerType);
  if (type === "qoder_cloud_agents") return "text";
  if (type === "watsonx" && !isOpenCodeZenBase(baseUrl)) return "text";
  if (usesAnthropicApi(baseUrl, model, type)) return "anthropic";
  if (usesResponsesApi(baseUrl, model, type)) return "openai_responses";
  return "openai_chat";
}

export function toolTransportFor(provider, model) {
  try {
    return resolveToolTransport(provider?.baseUrl, model, provider?.providerType);
  } catch {
    return "openai_chat";
  }
}

export function usesResponsesApi(baseUrl, model, providerType = "openai_compatible") {
  if (isOpenCodeZenBase(baseUrl)) return opencodeZenProtocol(model) === "responses";
  const type = normalizeProviderType(providerType);
  if (type === "openai_responses") return true;
  if (type === "anthropic_compatible" || type === "azure_openai" || type === "watsonx" || type === "qoder_cloud_agents") return false;
  const normalized = normalizeBaseUrl(baseUrl);
  let host;
  try {
    host = new URL(normalized).hostname;
  } catch {
    return false;
  }
  return isAgentRouterHost(host) && /^gpt-/i.test(String(model ?? "").trim());
}

export function resolveChatEndpoint(baseUrl, model, providerType = "openai_compatible", { stream = false } = {}) {
  if (isOpenCodeZenBase(baseUrl)) return opencodeZenEndpoint(baseUrl, model);
  const type = normalizeProviderType(providerType);
  if (type === "anthropic_compatible") return `${anthropicBaseUrl(baseUrl)}/messages`;
  if (type === "watsonx") return `${watsonxBaseUrl(baseUrl)}/text/chat${stream ? "_stream" : ""}?version=${WATSONX_VERSION}`;
  // Qoder has no completions endpoint; a turn is created as a session and the
  // reply is read from that session's event stream.
  if (type === "qoder_cloud_agents") return `${qoderApiBase(baseUrl)}/sessions`;
  const normalized = normalizeBaseUrl(baseUrl);
  return `${normalized}${usesResponsesApi(normalized, model, type) ? "/responses" : "/chat/completions"}`;
}

// Classifies the host of a provider base URL so we can warn about endpoints
// the deployed backend can never reach (localhost, private ranges, metadata).
export function classifyProviderHost(hostname) {
  const rawHost = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  const host = rawHost.startsWith("::ffff:") ? rawHost.slice(7) : rawHost;
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

// Best-effort DNS rebinding guard: even a public hostname must not resolve to
// a loopback/private/link-local address when the deployment forbids private
// provider URLs. The initial hostname is also re-checked on every redirect.
async function assertResolvedProviderUrl(url) {
  assertAllowedProviderUrl(url);
  if (privateProviderUrlsAllowed()) return;
  let addresses;
  try {
    addresses = await dns.lookup(new URL(url).hostname, { all: true, verbatim: true });
  } catch {
    // Let fetch report DNS failures with its own specific error code.
    return;
  }
  if (addresses.some(entry => classifyProviderHost(entry.address) !== "public")) {
    throw new ProviderError(
      "The provider hostname resolves to a private, loopback, or link-local address. Use a publicly routable HTTPS endpoint or set ALLOW_PRIVATE_PROVIDER_URLS=true only on a trusted private deployment.",
      400,
      "private_endpoint"
    );
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// Manual redirect handling prevents a public URL from redirecting the server
// into an internal destination and never forwards credentials cross-origin.
async function guardedProviderFetch(url, options) {
  let current = url;
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    await assertResolvedProviderUrl(current);
    const response = await fetch(current, { ...options, redirect: "manual" });
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) return response;
    const next = new URL(location, current);
    if (next.protocol !== "https:" && next.protocol !== "http:") {
      throw new ProviderError("The provider redirected to a non-HTTP endpoint.", 400, "unsafe_redirect");
    }
    if (next.origin !== new URL(current).origin) {
      throw new ProviderError("The provider redirected to a different origin. Update the base URL to the final endpoint instead.", 400, "unsafe_redirect");
    }
    try {
      await response.body?.cancel();
    } catch {
      /* redirect body already closed */
    }
    current = next.toString();
  }
  throw new ProviderError("The provider redirected too many times.", 400, "unsafe_redirect");
}

function safeHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "the provider";
  }
}

function networkError(error, url, context = {}) {
  const host = safeHost(url);
  const causeCode = error?.cause?.code || error?.code || "";
  let providerError;
  if (causeCode === "ENOTFOUND" || causeCode === "EAI_AGAIN") {
    providerError = new ProviderError(`DNS lookup failed for "${host}". Check the API base URL hostname and that the provider is online.`, null, "dns_error");
  } else if (causeCode === "ECONNREFUSED") {
    providerError = new ProviderError(`Connection refused by "${host}". The endpoint may be offline, the port closed, or the URL wrong.`, null, "connection_refused");
  } else if (causeCode === "ECONNRESET" || causeCode === "EPIPE") {
    providerError = new ProviderError(`The connection to "${host}" was reset before a response arrived. Try again.`, null, "network_error");
  } else {
    providerError = new ProviderError(`Could not reach "${host}". Check the API base URL and your network.`, null, "network_error");
  }
  return attachProviderDiagnostic(providerError, {
    url,
    context,
    classification: {
      category: "network_error",
      classification: "transient",
      retryable: true
    }
  });
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

function truncate(value, limit = MAX_ERROR_LENGTH) {
  if (typeof value !== "string") return "";
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > limit ? `${clean.slice(0, limit)}…` : clean;
}

export function redactSecrets(value) {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\boc_sk_[A-Za-z0-9_-]{6,}/g, "[redacted]")
    .replace(/\b(?:sk|ak)-[A-Za-z0-9_-]{6,}/g, "[redacted]")
    .replace(/("?(?:api[_-]?key|token|authorization|secret)"?\s*[:=]\s*)"[^"]*"/gi, '$1"[redacted]"');
}

export function buildProviderFailureLog({ url, method = "POST", status, contentType, payload, maxBodyLength = 2000 }) {
  let target = "unresolved";
  try {
    const parsed = new URL(url);
    target = parsed.origin + parsed.pathname;
  } catch {
    target = String(url).replace(/[?#].*$/, "");
  }
  let body = "";
  if (typeof payload === "string") {
    body = payload;
  } else if (payload !== null && payload !== undefined) {
    try {
      body = JSON.stringify(payload);
    } catch {
      body = String(payload);
    }
  }
  body = redactSecrets(body).replace(/\s+/g, " ").trim().slice(0, maxBodyLength);
  return `Provider request failed: ${method} ${target} -> HTTP ${status}; content-type=${contentType || "unknown"}; body=${body || "(empty)"}`;
}

// Upstream error bodies are third-party data. Never surface HTML error pages or
// markup: summarize them instead, and keep JSON/message details short.
// Providers wrap failures differently: {error:{message}}, {error:{error:{...}}},
// {cause:{...}}, or a raw string. Walk a few nested levels so a wrapped
// context-window error is not replaced by the outer generic envelope.
function providerErrorLevels(payload) {
  const levels = [];
  let current = payload;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (typeof current === "string") {
      levels.push({ message: current });
      break;
    }
    if (typeof current !== "object" || Array.isArray(current)) break;
    levels.push(current);
    const child =
      (typeof current.error === "string" ? current.error : diagnosticObject(current.error)) ??
      (typeof current.cause === "string" ? current.cause : diagnosticObject(current.cause));
    if (!child) break;
    current = child;
  }
  return levels;
}

function firstErrorField(levels, names, limit = 120) {
  for (const level of levels) {
    for (const name of names) {
      const value = diagnosticText(level?.[name], limit);
      if (value) return value;
    }
  }
  return "";
}

function firstErrorMetadata(levels, names, limit = 120) {
  for (const level of levels) {
    const metadata = diagnosticObject(level?.metadata);
    if (!metadata) continue;
    for (const name of names) {
      const value = diagnosticText(metadata?.[name], limit);
      if (value) return value;
    }
  }
  return "";
}

// OpenRouter and some OpenAI-compatible providers put the reset hint in
// error.metadata instead of a Retry-After header. Accept both placements and
// only keep a bounded, non-negative number of seconds.
function firstErrorNumber(levels, names) {
  for (const level of levels) {
    for (const source of [level, diagnosticObject(level?.metadata)]) {
      if (!source) continue;
      for (const name of names) {
        const raw = source?.[name];
        const value = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
        if (Number.isFinite(value) && value >= 0) return Math.min(Math.floor(value), 86400);
      }
    }
  }
  return null;
}

function sanitizedErrorDetail(payload) {
  let raw = typeof payload === "string" ? payload : "";
  if (!raw) {
    for (const level of providerErrorLevels(payload)) {
      const value = level?.message ?? level?.detail ?? level?.reason;
      if (typeof value === "string" && value.trim()) {
        raw = value;
        break;
      }
    }
  }
  if (typeof raw !== "string") return "";
  const text = raw.trim();
  if (!text) return "";
  if (/<(?:!doctype|html|head|body|title|h1)\b/i.test(text) || /<\/?(?:html|head|body|div|p|pre|code|title)\b/i.test(text)) {
    return "The provider returned an HTML error page instead of an API response. Check the API base URL and try again.";
  }
  return redactSecrets(truncate(text));
}

function diagnosticObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function diagnosticText(value, limit = 120) {
  if (typeof value === "number" && Number.isFinite(value)) value = String(value);
  return typeof value === "string" ? redactSecrets(truncate(value, limit)) : "";
}

export function providerErrorFields(payload) {
  const levels = providerErrorLevels(payload);
  const root = diagnosticObject(payload) || {};
  const details = levels
    .map(level => (Array.isArray(level?.details) ? level.details : null))
    .find(Boolean) || [];
  const reasons = details
    .map(entry => diagnosticText(diagnosticObject(entry)?.reason, 80))
    .filter(Boolean)
    .slice(0, 5);
  return {
    code: firstErrorField(levels, ["code", "error_code"], 80),
    type: firstErrorField(levels, ["type", "error_type"], 80),
    status: firstErrorField(levels, ["status", "error_status"], 80),
    providerName:
      firstErrorMetadata(levels, ["provider_name", "provider"], 80) ||
      diagnosticText(root.provider_name, 80),
    providerCode: firstErrorMetadata(levels, ["provider_error_code"], 80),
    limitSource: firstErrorMetadata(levels, ["limit_source"], 80),
    retryAfterSeconds: firstErrorNumber(levels, [
      "retry_after_seconds",
      "retryAfterSeconds",
      "retry_after",
      "retryAfter",
      "reset_after_seconds",
      "resetAfterSeconds"
    ]),
    remedyHint: firstErrorMetadata(levels, ["remedy_hint"], 240),
    detail: firstErrorMetadata(levels, ["raw"], 300),
    reasons,
    message: sanitizedErrorDetail(payload)
  };
}

const QUOTA_ERROR_CODE = /insufficient_quota|billing_hard_limit|credit_balance|insufficient_credits|payment_required|quota_exceeded/i;
// Only exhaustion wording counts. A 429 that says "rate limit or quota" is a
// rate limit unless the payload actually reports an exhausted balance.
const QUOTA_ERROR_TEXT = /insufficient (?:quota|credits?)|credit balance|billing (?:hard )?limit|payment required|exceeded (?:your|the) (?:current )?quota|quota (?:is )?(?:exhausted|depleted)|out of quota|spend(?:ing)? limit|free-models-per-day|free models per day|per[- ]day|daily limit|requests per day|tokens per day|\bRPD\b|\bTPD\b|monthly limit/i;
const CONCURRENCY_ERROR_TEXT = /concurren|parallel|simultaneous|in.?flight/i;
const TOKEN_RATE_ERROR_TEXT = /tokens? per min|\bTPM\b|token[- ]rate|tokens?.*(?:minute|min\b)/i;
const REQUEST_RATE_ERROR_TEXT = /requests? per min|\bRPM\b|too many requests|rate.?limit|request rate/i;
const INVALID_MODEL_ERROR_TEXT = /model.*(?:not found|does not exist|not available|invalid)|invalid model|unknown model|no endpoints found|must reference an available model/i;
const CREDENTIAL_ERROR_TEXT = /invalid.*(?:api.?key|token|credential)|unauthorized|authentication|api key.*(?:invalid|expired|disabled)/i;
// Context-window failures arrive as HTTP 400 from most providers. They must be
// classified before credential heuristics, because a bare 400 message often
// lists the API key as something to check even when the key is fine.
const CONTEXT_LIMIT_ERROR_CODE = /context[_-]?(?:length|window)|context_limit|string_above_max_length|prompt_too_long|input_too_long|too_many_tokens|model_context_window_exceeded|conversation_too_long|chat_too_long/i;
const CONTEXT_LIMIT_ERROR_TEXT = /context (?:length|window)[^.\n]{0,60}(?:exceed|too (?:long|large|small)|maximum|max|limit)|(?:maximum|max)[^.\n]{0,20}context (?:length|window)|(?:prompt|input|messages?|conversation|chat)[^.\n]{0,80}\btoo (?:long|large|big)\b|conversation is too large|input length exceeds (?:the )?context|too many tokens|exceed(?:s|ed)? (?:the )?(?:model'?s )?(?:maximum|max|available) (?:context|tokens|input)|string too long for/i;
export const CONTEXT_LIMIT_MESSAGE =
  "This conversation is too long for this model. Continue in a new chat to keep going.";

export function classifyProviderFailure({ status = null, payload = null, message = "" } = {}) {
  const fields = providerErrorFields(payload);
  const signal = [
    fields.code,
    fields.type,
    fields.status,
    fields.providerCode,
    fields.providerName,
    fields.limitSource,
    fields.detail,
    fields.reasons.join(" "),
    message || fields.message
  ].filter(Boolean).join(" ");
  const statusCode = Number(status ?? fields.status ?? fields.code);
  const hasStatus = Number.isFinite(statusCode) && statusCode >= 100 && statusCode <= 599;
  const quota = QUOTA_ERROR_CODE.test(`${fields.code} ${fields.type} ${fields.providerCode}`)
    || QUOTA_ERROR_TEXT.test(signal);
  const concurrency = CONCURRENCY_ERROR_TEXT.test(signal);
  const tokenRate = TOKEN_RATE_ERROR_TEXT.test(signal);
  const requestRate = REQUEST_RATE_ERROR_TEXT.test(signal);
  const invalidModel = INVALID_MODEL_ERROR_TEXT.test(signal);
  const credentials = CREDENTIAL_ERROR_TEXT.test(signal);
  const contextLimit = CONTEXT_LIMIT_ERROR_CODE.test(
    `${fields.code} ${fields.type} ${fields.providerCode}`
  ) || CONTEXT_LIMIT_ERROR_TEXT.test(signal);

  const result = (category, classification, retryable) => ({
    category,
    classification,
    retryable,
    providerCode: fields.code,
    providerType: fields.type,
    providerStatus: fields.status,
    providerName: fields.providerName,
    providerErrorCode: fields.providerCode,
    limitSource: fields.limitSource
  });

  if (contextLimit) return result("context_limit", "permanent", false);
  if (statusCode === 401 || (statusCode === 403 && credentials && !quota)) return result("invalid_credentials", "permanent", false);
  if (statusCode === 402 || quota) return result("quota_exhausted", "permanent", false);
  if (statusCode === 403) return result("forbidden", "permanent", false);
  if (statusCode === 404 || (statusCode === 400 && invalidModel)) return result("invalid_model", "permanent", false);
  if (statusCode === 400 && credentials) return result("invalid_credentials", "permanent", false);
  if ((statusCode === 429 || fields.code === "429" || fields.status === "429")) {
    if (concurrency) return result("concurrency_limit", "transient", true);
    if (tokenRate) return result("rate_limit_tokens", "transient", true);
    if (requestRate) return result("rate_limit_requests", "transient", true);
    return result("ambiguous_rate_limit", "ambiguous", true);
  }
  if (statusCode === 409 && concurrency) return result("concurrency_limit", "transient", true);
  if (statusCode === 408) return result("timeout", "transient", true);
  if (statusCode >= 500) {
    if (/overload|capacity|temporar/i.test(signal)) return result("overloaded", "transient", true);
    return result("upstream_unavailable", "transient", true);
  }
  if (statusCode === 413) return result("request_too_large", "permanent", false);
  if (statusCode === 400 || statusCode === 422) return result("invalid_request", "permanent", false);
  return result("unknown", hasStatus ? "permanent" : "ambiguous", false);
}

function responseHeader(headers, name) {
  if (!headers) return "";
  if (typeof headers.get === "function") return headers.get(name) || "";
  const match = Object.keys(headers).find(key => key.toLowerCase() === name.toLowerCase());
  return match ? String(headers[match] ?? "") : "";
}

function responseDiagnostics(headers) {
  if (!headers) return {};
  const selected = [
    "server",
    "cf-ray",
    "x-request-id",
    "request-id",
    "via",
    "x-envoy-upstream-service-time",
    "x-ratelimit-limit",
    "x-ratelimit-remaining",
    "x-ratelimit-reset",
    "x-ratelimit-limit-requests",
    "x-ratelimit-remaining-requests",
    "x-ratelimit-reset-requests",
    "x-ratelimit-limit-tokens",
    "x-ratelimit-remaining-tokens",
    "x-ratelimit-reset-tokens"
  ];
  const result = {};
  for (const name of selected) {
    const value = diagnosticText(responseHeader(headers, name), 120);
    if (value) result[name] = value;
  }
  return result;
}

function diagnosticTarget(url) {
  try {
    const parsed = new URL(url);
    return { providerHost: parsed.hostname, endpoint: parsed.pathname };
  } catch {
    return { providerHost: "unresolved", endpoint: "unresolved" };
  }
}

export function buildProviderFailureDiagnostic({
  url,
  status = null,
  payload = null,
  headers = null,
  retryAfter = null,
  retryAfterRaw = "",
  context = {},
  classification = null
} = {}) {
  const target = diagnosticTarget(url);
  const fields = providerErrorFields(payload);
  const classified = classification ?? classifyProviderFailure({ status, payload, message: fields.message });
  const effectiveRetryAfter = Number.isFinite(retryAfter) ? retryAfter : fields.retryAfterSeconds;
  return {
    event: "provider_upstream_failure",
    timestamp: new Date().toISOString(),
    requestId: diagnosticText(context.requestId, 80) || null,
    attempt: Number.isInteger(context.attempt) ? context.attempt : null,
    providerHost: target.providerHost,
    endpoint: target.endpoint,
    model: diagnosticText(context.model, 200) || null,
    httpStatus: Number.isInteger(status) ? status : null,
    providerCode: fields.code || null,
    providerType: fields.type || null,
    providerStatus: fields.status || null,
    providerName: fields.providerName || null,
    providerErrorCode: fields.providerCode || null,
    limitSource: fields.limitSource || null,
    providerReasons: fields.reasons,
    providerMessage: fields.message || fields.detail || null,
    providerDetail: fields.detail || null,
    remedyHint: fields.remedyHint || null,
    category: classified.category,
    classification: classified.classification,
    retryable: classified.retryable,
    retryAfter: Number.isFinite(effectiveRetryAfter) ? effectiveRetryAfter : null,
    retryAfterRaw: diagnosticText(retryAfterRaw, 80) || null,
    responseHeaders: responseDiagnostics(headers)
  };
}

function attachProviderDiagnostic(error, options) {
  const diagnostic = buildProviderFailureDiagnostic(options);
  error.category = diagnostic.category;
  error.classification = diagnostic.classification;
  error.retryable = diagnostic.retryable;
  error.diagnostics = diagnostic;
  // A context-window decision is authoritative. Do not let a generic 401/403
  // wrapper keep its credential code or raw upstream wording.
  if (diagnostic.category === "context_limit") {
    error.code = "context_limit";
    error.message = CONTEXT_LIMIT_MESSAGE;
  }
  if (
    diagnostic.category === "quota_exhausted" &&
    ["rate_limited", "forbidden", "bad_request"].includes(error.code)
  ) {
    error.code = "quota_exhausted";
  }
  if (diagnostic.category === "invalid_model" && error.code === "bad_request") error.code = "invalid_model";
  if (diagnostic.category === "invalid_credentials" && error.code === "bad_request") error.code = "invalid_api_key";
  if (Number.isFinite(diagnostic.retryAfter) && diagnostic.retryAfter >= 0) {
    error.retryAfter = diagnostic.retryAfter;
    error.resetSource = error.resetSource || (diagnostic.retryAfterRaw ? "retry-after" : "provider-metadata");
  }
  console.warn(JSON.stringify(diagnostic));
  return error;
}

export function describeProviderError(status, payload) {
  // Context overflow can arrive with 400, 401, 403, 413, or 422 depending on
  // the provider. Structured codes or explicit context wording win, but a
  // bare credential rejection is never inferred to be a context limit.
  const classification = classifyProviderFailure({ status, payload });
  if (classification.category === "context_limit") {
    return new ProviderError(CONTEXT_LIMIT_MESSAGE, status, "context_limit");
  }
  const detail = sanitizedErrorDetail(payload);
  const suffix = detail ? ` Provider said: ${detail}` : "";
  if (status === 400) {
    // Do not suggest an API key here. A generic 400 is not evidence of a
    // credential failure and used to be mislabeled as one in the client.
    return new ProviderError(`The provider rejected the request (HTTP 400)${detail ? "." : " and did not include details. Check the model ID and API base URL, then try again."}${suffix}`, status, "bad_request");
  }
  if (status === 401) {
    // AgentRouter's agentrouter.org host rejects anything that is not one of its
    // own coding CLIs before it looks at the key, so "check the key" would send
    // the user after a problem that does not exist. Its documented host for
    // third-party agents is co.agentrouter.org.
    if (payload?.type === "unauthorized_client_error" || payload?.error?.type === "unauthorized_client_error") {
      return new ProviderError(
        "AgentRouter rejected this client (HTTP 401) before checking the API key: agentrouter.org only accepts requests from its own coding CLIs. Reconfigure the provider with the documented API host — https://co.agentrouter.org/v1 for OpenAI-compatible models, or https://co.agentrouter.org for Anthropic models — then test again.",
        status,
        "unauthorized_client"
      );
    }
    return new ProviderError(`The provider rejected your API key (HTTP 401). Check the key in Settings.${suffix}`, status, "invalid_api_key");
  }
  if (status === 402) return new ProviderError(`Your provider account has insufficient credits (HTTP 402).${suffix}`, status, "insufficient_credits");
  if (status === 403) return new ProviderError(`The provider denied access (HTTP 403). Your key may lack permission for this model.${suffix}`, status, "forbidden");
  if (status === 404) return new ProviderError(`The provider returned HTTP 404. The API base URL or model ID is likely wrong.${suffix}`, status, "not_found");
  if (status === 405) return new ProviderError(`The provider rejected the request method or endpoint (HTTP 405). Check the API base URL, and in Settings choose OpenAI-compatible for /chat/completions or OpenAI Responses for /responses.${suffix}`, status, "method_not_allowed");
  if (status === 408) return new ProviderError(`The provider timed out (HTTP 408).${suffix}`, status, "timeout");
  if (status === 413) return new ProviderError(`The conversation is too large for this provider (HTTP 413).${suffix}`, status, "too_large");
  if (status === 422) return new ProviderError(`The provider could not process the request (HTTP 422). Check the model ID.${suffix}`, status, "unprocessable");
  if (status === 429) {
    if (classification.category === "quota_exhausted") {
      return new ProviderError(`The provider account has reached its usage limit (HTTP 429).${suffix}`, status, "quota_exhausted");
    }
    if (classification.category === "concurrency_limit") {
      return new ProviderError(`The provider is at its concurrency limit (HTTP 429). Wait a moment and try again.${suffix}`, status, "rate_limited");
    }
    return new ProviderError(`The provider is rate-limiting requests (HTTP 429). Wait a moment and try again.${suffix}`, status, "rate_limited");
  }
  if (typeof status === "number" && status >= 500) return new ProviderError(`The provider is temporarily unavailable (HTTP ${status}).${suffix}`, status, "provider_unavailable");
  return new ProviderError(`The provider returned an unexpected error${status ? ` (HTTP ${status})` : ""}.${suffix}`, status ?? null, "provider_error");
}

// Gemini uses Google-style error envelopes and separates free-tier quota
// failures from ordinary HTTP 429s. Keep the message actionable and do not
// imply that switching models resets a project-wide quota.
function googleGeminiError(status, payload) {
  const detail = sanitizedErrorDetail(payload);
  const suffix = detail ? ` Provider said: ${detail}` : "";
  if (status === 400 && /api[- ]?key|credential|API_KEY_INVALID/i.test(detail)) {
    return new ProviderError(`Google Gemini rejected your API key (HTTP 400). Create a key in Google AI Studio and paste it in Settings.${suffix}`, 401, "invalid_api_key");
  }
  if (status === 403) {
    if (/country|region|location|not available|unsupported/i.test(detail)) {
      return new ProviderError(`Google Gemini is not available for this project's region. Free-tier Gemini API use is not offered in the EEA, Switzerland, or the UK; those regions require a paid Google Cloud project.${suffix}`, 403, "region_restricted");
    }
    if (/api[- ]?key|credential|permission|unregistered/i.test(detail)) {
      return new ProviderError(`Google Gemini denied access (HTTP 403). Check that the key belongs to the intended project and that the Generative Language API is enabled in Google AI Studio.${suffix}`, 403, "forbidden");
    }
    return new ProviderError(`Google Gemini denied the request (HTTP 403). Enable the Gemini API for this project and check its regional availability.${suffix}`, 403, "forbidden");
  }
  if (status === 429) {
    const daily = /per day|daily|\bRPD\b|requests per day/i.test(detail);
    const freeTier = /free[- ]tier/i.test(detail);
    const reset = daily ? "Daily quotas reset at midnight Pacific time." : "Wait a moment before retrying.";
    return new ProviderError(`Google Gemini's ${daily ? "daily " : ""}${freeTier ? "free-tier " : ""}quota is exhausted (HTTP 429). ${reset} Quotas are enforced per Google Cloud project, so changing models may not help; check AI Studio or Google Cloud for current limits and billing.${suffix}`, 429, freeTier ? "free_quota_exhausted" : "rate_limited");
  }
  return describeProviderError(status, payload);
}

export function parseRetryAfter(value, now = Date.now()) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) {
    const seconds = Number(text);
    return Number.isFinite(seconds) ? Math.min(Math.max(Math.floor(seconds), 0), 86400) : null;
  }
  if (!/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(text)) return null;
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) return null;
  return Math.min(Math.max(Math.ceil((timestamp - now) / 1000), 0), 86400);
}

const QUOTA_EXHAUSTED_PATTERN =
  /free-models-per-day|free models per day|per[- ]day|daily limit|requests per day|tokens per day|\bRPD\b|\bTPD\b|quota is exhausted|quota (?:is )?depleted|insufficient credits|credit balance|exceeded (?:your|the) (?:current )?quota|billing hard limit|payment required/i;

export function isQuotaExhaustedError(error) {
  if (!(error instanceof ProviderError)) return false;
  if (error.category === "quota_exhausted") return true;
  if (["free_quota_exhausted", "quota_exhausted", "insufficient_credits"].includes(error.code)) return true;
  return error.code === "rate_limited" && QUOTA_EXHAUSTED_PATTERN.test(String(error.message || ""));
}

export function isRetryableProviderError(error) {
  if (!(error instanceof ProviderError)) return false;
  if (typeof error.retryable === "boolean") return error.retryable;
  if (error.code === "cancelled" || error.code === "free_quota_exhausted" || error.code === "quota_exhausted") return false;
  if (isQuotaExhaustedError(error)) return false;
  if (error.code === "rate_limited") return true;
  if (error.code === "timeout") return true;
  if (["network_error", "connection_refused", "provider_unavailable"].includes(error.code)) return true;
  if (error.status === 408 || error.status === 429) return true;
  return typeof error.status === "number" && [500, 502, 503, 504].includes(error.status);
}

export function retryDelayMs(error, attempt, options = {}) {
  const baseDelayMs = Math.max(1, Number(options.baseDelayMs) || 500);
  const maxDelayMs = Math.max(baseDelayMs, Number(options.maxDelayMs) || 8000);
  const configuredRetryAfterCap = Number(options.maxRetryAfterMs);
  const maxRetryAfterMs = Number.isFinite(configuredRetryAfterCap) && configuredRetryAfterCap >= 0
    ? configuredRetryAfterCap
    : 15000;
  const random = typeof options.random === "function" ? options.random : Math.random;
  const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, Math.floor(attempt)));
  const jitter = Math.floor(random() * Math.max(1, Math.floor(exponential * 0.25)));
  const backoff = Math.min(maxDelayMs, exponential + jitter);
  if (Number.isFinite(error?.retryAfter) && error.retryAfter >= 0) {
    const retryAfterMs = Math.floor(error.retryAfter * 1000);
    if (retryAfterMs > maxRetryAfterMs) return null;
    return Math.min(maxRetryAfterMs, Math.max(backoff, retryAfterMs));
  }
  return backoff;
}

function waitForRetry(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ProviderError("Request cancelled.", null, "cancelled"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", cancel);
      resolve();
    }, ms);
    function cancel() {
      clearTimeout(timer);
      reject(new ProviderError("Request cancelled.", null, "cancelled"));
    }
    signal?.addEventListener("abort", cancel, { once: true });
  });
}

export async function withProviderRetry(operation, options = {}) {
  const requested = Number(options.maxRetries);
  const maxRetries = Number.isFinite(requested) ? Math.min(Math.max(Math.floor(requested), 0), 5) : 0;
  const sleep = typeof options.sleep === "function" ? options.sleep : waitForRetry;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (!isRetryableProviderError(error) || attempt >= maxRetries) throw error;
      const delay = retryDelayMs(error, attempt, options);
      if (delay === null) throw error;
      if (options.signal?.aborted) throw new ProviderError("Request cancelled.", null, "cancelled");
      options.onRetry?.({ attempt: attempt + 1, delay, error });
      await sleep(delay, options.signal);
    }
  }
}

function providerHttpError(url, status, payload, retryAfter = null, headers = null, context = {}) {
  const classification = classifyProviderFailure({ status, payload });
  let error;
  if (classification.category === "context_limit") {
    // Run the shared classification before provider-specific adapters so a
    // credential or generic mapping can never replace a proven context limit.
    error = new ProviderError(CONTEXT_LIMIT_MESSAGE, status, "context_limit");
  } else {
    try {
      if (isGoogleGeminiHost(new URL(url).hostname)) error = googleGeminiError(status, payload);
    } catch {
      /* fall through to the generic mapping */
    }
    if (!error) error = describeProviderError(status, payload);
  }
  const fields = providerErrorFields(payload);
  const effectiveRetryAfter = Number.isFinite(retryAfter) ? retryAfter : fields.retryAfterSeconds;
  if (Number.isFinite(effectiveRetryAfter) && effectiveRetryAfter >= 0) {
    error.retryAfter = effectiveRetryAfter;
    error.resetSource = Number.isFinite(retryAfter) ? "retry-after" : "provider-metadata";
  }
  return attachProviderDiagnostic(error, {
    url,
    status,
    payload,
    headers,
    retryAfter: effectiveRetryAfter,
    retryAfterRaw: responseHeader(headers, "retry-after"),
    context,
    classification
  });
}

const MAX_PROVIDER_RESPONSE_BYTES = 4 * 1024 * 1024;

async function readResponseTextLimited(response) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_PROVIDER_RESPONSE_BYTES) {
      try {
        await reader.cancel();
      } catch {
        /* already closed */
      }
      throw new ProviderError("The provider response was too large to process safely.", 413, "response_too_large");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

async function readJsonSafely(response) {
  let text;
  try {
    text = await readResponseTextLimited(response);
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    return null;
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function buildWatsonxRequestBody({ model, messages, temperature, maxTokens, stream, projectId }) {
  const body = {
    model_id: model,
    project_id: projectId,
    messages: serializeMessages(messages),
    stream
  };
  if (typeof temperature === "number" && Number.isFinite(temperature)) body.temperature = Math.min(2, Math.max(0, temperature));
  if (typeof maxTokens === "number" && Number.isFinite(maxTokens) && maxTokens > 0) body.max_tokens = Math.floor(maxTokens);
  return body;
}

const iamTokenCache = new Map();

// watsonx.ai authenticates with a short-lived IAM bearer token derived from the
// IBM Cloud API key. Tokens are cached in memory and refreshed a minute early.
async function watsonxAccessToken(apiKey) {
  const cached = iamTokenCache.get(apiKey);
  if (cached && cached.expiresAt > Date.now() + 60000) return cached.token;
  let response;
  try {
    response = await fetch(WATSONX_IAM_URL(), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: `grant_type=urn:ibm:params:oauth:grant-type:apikey&apikey=${encodeURIComponent(apiKey)}`,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw new ProviderError("Timed out while exchanging your IBM Cloud API key for an IAM token.", null, "timeout");
    }
    throw new ProviderError("Could not reach the IBM Cloud IAM token service. Check your network.", null, "network_error");
  }
  const payload = await readJsonSafely(response);
  if (!response.ok) {
    if (response.status === 400 || response.status === 401) {
      throw new ProviderError(`IBM Cloud rejected your API key (HTTP ${response.status}). Create a new key and check it in Settings.`, response.status, "invalid_api_key");
    }
    if (response.status === 429) {
      throw new ProviderError("IBM Cloud is rate limiting IAM token requests (HTTP 429). Wait a moment and try again.", response.status, "rate_limited");
    }
    throw describeProviderError(response.status, payload);
  }
  const token = typeof payload?.access_token === "string" ? payload.access_token : "";
  if (!token) throw new ProviderError("IBM Cloud IAM did not return an access token.", null, "provider_error");
  const expiresIn = Number(payload?.expires_in);
  iamTokenCache.set(apiKey, {
    token,
    expiresAt: Date.now() + (Number.isFinite(expiresIn) && expiresIn > 60 ? expiresIn - 30 : 3300) * 1000
  });
  if (iamTokenCache.size > 100) {
    const now = Date.now();
    for (const [key, entry] of iamTokenCache) if (entry.expiresAt <= now) iamTokenCache.delete(key);
  }
  return token;
}

async function authHeaders(apiKey, providerType = "openai_compatible", baseUrl = "") {
  const type = normalizeProviderType(providerType);
  if (isOpenCodeZenBase(baseUrl)) {
    return {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`
    };
  }
  if (type === "anthropic_compatible") {
    return {
      "Content-Type": "application/json",
      Accept: "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    };
  }
  if (type === "azure_openai") {
    return {
      "Content-Type": "application/json",
      Accept: "application/json",
      "api-key": apiKey
    };
  }
  if (type === "watsonx") {
    return {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${await watsonxAccessToken(apiKey)}`
    };
  }
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: `Bearer ${apiKey}`
  };
}

export async function listProviderModels({ baseUrl, apiKey, providerType = "openai_compatible", authMode = "pat", openapiBaseUrl = "" }, signal) {
  const type = normalizeProviderType(providerType);
  if (type === "qoder_cloud_agents") return qoderListModels(qoderCredentials({ baseUrl, apiKey, authMode, openapiBaseUrl }), signal);
  const zen = isOpenCodeZenBase(baseUrl);
  const google = isGoogleGeminiBase(baseUrl);
  let url;
  if (zen) {
    url = `${new URL(normalizeBaseUrl(baseUrl)).origin}/zen/v1/models`;
  } else if (google) {
    url = googleGeminiModelsUrl(baseUrl);
  } else if (type === "anthropic_compatible") {
    url = `${anthropicBaseUrl(baseUrl)}/models`;
  } else if (type === "watsonx") {
    const projectId = watsonxProjectId(baseUrl);
    url = `${watsonxBaseUrl(baseUrl)}/foundation_model_specs?version=${WATSONX_LISTING_VERSION}&filters=function_text_chat&limit=200${projectId ? `&project_id=${encodeURIComponent(projectId)}` : ""}`;
  } else {
    url = `${normalizeBaseUrl(baseUrl)}/models`;
  }
  let response;
  try {
    response = await guardedProviderFetch(url, {
      method: "GET",
      headers: google
        ? { Accept: "application/json", "x-goog-api-key": apiKey }
        : await authHeaders(apiKey, type, baseUrl),
      signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw new ProviderError("Timed out while contacting the provider's model list endpoint.", null, "timeout");
    }
    if (error instanceof ProviderError) throw error;
    throw networkError(error, url);
  }
  if (!response.ok) {
    const host = (() => {
      try {
        return new URL(url).hostname;
      } catch {
        return "";
      }
    })();
    if (isBedrockHost(host) && [403, 404, 405].includes(response.status)) {
      throw new ProviderError(
        "Amazon Bedrock Runtime does not expose an OpenAI-compatible model list. The endpoint is reachable; use Test model to verify credentials and enter the model ID manually.",
        response.status,
        "unsupported_listing"
      );
    }
    const payload = await readJsonSafely(response);
    throw providerHttpError(
      url,
      response.status,
      payload,
      parseRetryAfter(response.headers.get("retry-after")),
      response.headers
    );
  }
  const payload = await readJsonSafely(response);
  if (google) {
    const models = Array.isArray(payload?.models) ? payload.models : null;
    if (!models) {
      throw new ProviderError("Google Gemini did not return a model list. Enter a Gemini model ID manually or check the API key.", response.status, "unsupported_listing");
    }
    return models
      .map(entry => {
        const rawName = typeof entry?.name === "string" ? entry.name : "";
        const id = rawName.replace(/^models\//i, "");
        if (!id) return null;
        const methods = Array.isArray(entry?.supportedGenerationMethods) ? entry.supportedGenerationMethods : null;
        if (methods && !methods.includes("generateContent")) return null;
        if (isGoogleNonChatModel(id)) return null;
        const capabilities = geminiCapabilities(entry, id);
        return {
          id,
          ownedBy: "Google Gemini",
          vision: visionFromCapabilities(capabilities),
          capabilities,
          contextLength: capabilities.contextLength ?? null,
          maxOutputTokens: capabilities.maxOutputTokens ?? null
        };
      })
      .filter(Boolean)
      .slice(0, 1000);
  }
  const entries = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.models)
      ? payload.models
      : Array.isArray(payload?.resources)
        ? payload.resources.map(entry => ({ id: entry?.model_id, owned_by: entry?.provider }))
        : null;
  if (!entries) {
    throw new ProviderError("The provider's response did not contain a model list. Enter the model ID manually.", response.status, "unsupported_listing");
  }
  return entries
    .map(entry => {
      const id = typeof entry?.id === "string" ? entry.id : typeof entry?.name === "string" ? entry.name : null;
      if (!id) return null;
      const capabilities = normalizeCapabilities(entry);
      const free = freeFromPricing(entry);
      return {
        id,
        ownedBy: typeof entry?.owned_by === "string" ? entry.owned_by : typeof entry?.display_name === "string" ? entry.display_name : undefined,
        vision: visionFromCapabilities(capabilities),
        capabilities,
        contextLength: capabilities.contextLength ?? null,
        maxOutputTokens: capabilities.maxOutputTokens ?? null,
        ...(free !== null ? { free } : {}),
        ...(zen ? { free: isOpenCodeZenFreeModel(id), restrictedProvider: isOpenCodeZenFreeModel(id) } : {})
      };
    })
    .filter(Boolean)
    .slice(0, 1000);
}

// Converts normalized messages into the OpenAI chat format used by every
// provider we support (OpenRouter, personal OpenAI-compatible APIs, and the
// shared Ollama server's /v1 compatibility layer). Messages carrying images
// become content-parts arrays with base64 data URLs or remote https URLs;
// everything else is passed through untouched.
export function serializeMessages(messages) {
  return messages.map(message => {
    if (message.role === "tool") {
      return {
        role: "tool",
        tool_call_id: message.tool_call_id,
        content: message.content
      };
    }
    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      return {
        role: message.role,
        content: message.content ?? null,
        tool_calls: message.tool_calls
      };
    }
    const images = Array.isArray(message?.images) ? message.images : [];
    if (images.length === 0) return { role: message.role, content: message.content };
    const parts = [];
    if (typeof message.content === "string" && message.content.trim().length > 0) {
      parts.push({ type: "text", text: message.content });
    }
    for (const image of images) {
      parts.push({ type: "image_url", image_url: { url: imageSourceUrl(image) } });
    }
    return { role: message.role, content: parts };
  });
}

function serializeResponsesMessages(messages) {
  const items = [];
  for (const message of messages) {
    if (message.role === "tool") {
      items.push({
        type: "function_call_output",
        call_id: String(message.tool_call_id || ""),
        output: typeof message.content === "string" ? message.content : ""
      });
      continue;
    }
    if (message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      if (typeof message.content === "string" && message.content.trim()) {
        items.push({ role: "assistant", content: [{ type: "output_text", text: message.content }] });
      }
      message.tool_calls.forEach((call, index) => {
        const name = call?.function?.name;
        if (typeof name !== "string" || !name) return;
        items.push({
          type: "function_call",
          call_id: typeof call.id === "string" && call.id ? call.id : `call_${index}`,
          name,
          arguments: typeof call.function.arguments === "string" ? call.function.arguments : "{}"
        });
      });
      continue;
    }
    const images = Array.isArray(message.images) ? message.images : [];
    if (images.length === 0 && typeof message.content === "string") {
      items.push({ role: message.role, content: message.content });
      continue;
    }
    // The Responses API only accepts output_text parts on assistant turns;
    // input_text is a request-side type and is rejected in history.
    const textType = message.role === "assistant" ? "output_text" : "input_text";
    const parts = [];
    if (typeof message.content === "string" && message.content.length > 0) {
      parts.push({ type: textType, text: message.content });
    } else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part?.type === "image_url") parts.push({ type: "input_image", image_url: part.image_url?.url ?? "" });
        else parts.push({ type: textType, text: part?.text ?? "" });
      }
    }
    for (const image of images) parts.push({ type: "input_image", image_url: imageSourceUrl(image) });
    items.push({ role: message.role, content: parts.length > 0 ? parts : "" });
  }
  return items;
}

function parseImageDataUrl(value) {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(value || ""));
  if (!match) return null;
  return { mediaType: match[1], data: match[2].replace(/\s+/g, "") };
}

function anthropicText(message) {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .filter(part => part?.type === "text")
      .map(part => (typeof part.text === "string" ? part.text : ""))
      .join("");
  }
  return "";
}

function anthropicToolUseBlocks(toolCalls) {
  return (Array.isArray(toolCalls) ? toolCalls : [])
    .filter(call => typeof call?.function?.name === "string" && call.function.name)
    .map((call, index) => {
      let input = {};
      const raw = call.function.arguments;
      if (raw && typeof raw === "object" && !Array.isArray(raw)) input = raw;
      else if (typeof raw === "string") {
        try {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) input = parsed;
        } catch {
          input = {};
        }
      }
      return {
        type: "tool_use",
        id: typeof call.id === "string" && call.id ? call.id : `call_${index}`,
        name: call.function.name,
        input
      };
    });
}

// Anthropic requires alternating turns and answers a tool_use block with a
// tool_result block in the next user turn, so consecutive same-role messages
// are merged instead of dropped. Images and text keep their documented blocks.
function serializeAnthropicMessages(messages) {
  const turns = [];
  const push = (role, blocks) => {
    if (blocks.length === 0) return;
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else turns.push({ role, content: blocks });
  };
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      push("user", [{
        type: "tool_result",
        tool_use_id: String(message.tool_call_id || ""),
        content: typeof message.content === "string" ? message.content : ""
      }]);
      continue;
    }
    const blocks = [];
    const text = anthropicText(message);
    if (text.length > 0) blocks.push({ type: "text", text });
    for (const image of Array.isArray(message.images) ? message.images : []) {
      const sourceUrl = imageSourceUrl(image);
      const parsed = parseImageDataUrl(sourceUrl);
      if (parsed) blocks.push({ type: "image", source: { type: "base64", media_type: parsed.mediaType, data: parsed.data } });
      else if (/^https:\/\//i.test(sourceUrl)) blocks.push({ type: "image", source: { type: "url", url: sourceUrl } });
    }
    if (message.role === "assistant") blocks.push(...anthropicToolUseBlocks(message.tool_calls));
    if (blocks.length === 0) {
      // An assistant turn that only carried a now-empty tool call is skipped;
      // an empty user turn still has to exist for the alternation to hold.
      if (message.role !== "assistant") push("user", [{ type: "text", text: "(empty message)" }]);
      continue;
    }
    push(message.role === "assistant" ? "assistant" : "user", blocks);
  }
  return turns;
}

export function buildAnthropicRequestBody({ model, messages, temperature, maxTokens, stream, tools = null, toolChoice = null }) {
  const system = messages
    .filter(message => message.role === "system" && typeof message.content === "string")
    .map(message => message.content)
    .filter(Boolean)
    .join("\n\n");
  const body = {
    model,
    messages: serializeAnthropicMessages(messages),
    max_tokens: typeof maxTokens === "number" && Number.isFinite(maxTokens) && maxTokens > 0 ? Math.floor(maxTokens) : 4096,
    stream
  };
  if (system) body.system = system;
  if (typeof temperature === "number" && Number.isFinite(temperature)) body.temperature = Math.min(1, Math.max(0, temperature));
  if (Array.isArray(tools) && tools.length > 0) {
    body.tools = tools
      .map(tool => {
        const fn = tool?.function || tool;
        if (typeof fn?.name !== "string" || !fn.name) return null;
        return {
          name: fn.name,
          description: typeof fn.description === "string" ? fn.description : "",
          input_schema: fn.parameters && typeof fn.parameters === "object" ? fn.parameters : { type: "object", properties: {} }
        };
      })
      .filter(Boolean);
    if (body.tools.length > 0 && typeof toolChoice === "string") {
      body.tool_choice = { type: toolChoice === "required" ? "any" : toolChoice === "none" ? "none" : "auto" };
    }
  }
  return body;
}

export function extractAnthropicText(payload) {
  if (!Array.isArray(payload?.content)) return "";
  return payload.content
    .filter(part => part?.type === "text" && typeof part.text === "string")
    .map(part => part.text)
    .join("");
}

function anthropicFinishReason(payload) {
  const reason = payload?.stop_reason;
  if (reason === "max_tokens") return "length";
  if (reason === "end_turn" || reason === "stop_sequence") return "stop";
  return typeof reason === "string" ? reason : null;
}

// ─── text tool protocol ─────────────────────────────────────────────────────
// Providers without a documented tool-calling format still reach the same
// tools through an explicit, validated text block. Only names from the
// registry supplied with this request are accepted; everything else stays
// plain text and is never executed.
const TEXT_TOOL_OPEN = "<vups_tool_call>";
const TEXT_TOOL_CLOSE = "</vups_tool_call>";
const TEXT_TOOL_BLOCK = /<vups_tool_call>\s*([\s\S]*?)\s*<\/vups_tool_call>/g;
const TEXT_TOOL_MAX_CALLS = 5;
let textToolCallSeq = 0;

function toolNameSet(tools) {
  const names = new Set();
  for (const tool of Array.isArray(tools) ? tools : []) {
    const name = tool?.function?.name ?? tool?.name;
    if (typeof name === "string" && name) names.add(name);
  }
  return names;
}

function toolProtocolPrompt(tools) {
  const signatures = (Array.isArray(tools) ? tools : [])
    .map(tool => {
      const fn = tool?.function || tool;
      if (typeof fn?.name !== "string" || !fn.name) return "";
      const properties = fn?.parameters?.properties && typeof fn.parameters.properties === "object" ? fn.parameters.properties : {};
      const required = new Set(Array.isArray(fn?.parameters?.required) ? fn.parameters.required : []);
      const fields = Object.keys(properties)
        .map(key => `${key}${required.has(key) ? "" : "?"}:${properties[key]?.type || "value"}`)
        .join(", ");
      return `- ${fn.name}(${fields})`;
    })
    .filter(Boolean)
    .join("\n");
  return [
    "Tool calls",
    "This model connection has no native function-calling channel, so request a local tool by writing one block, exactly:",
    `${TEXT_TOOL_OPEN}{"name":"read_file","arguments":{"path":"C:/Users/you/file.txt"}}${TEXT_TOOL_CLOSE}`,
    `Write at most ${TEXT_TOOL_MAX_CALLS} blocks per reply, each on its own line, with no prose inside a block. The host validates the name against its registry, asks for permission the same way for every model, executes the call, and sends the result back as a [Tool result] message. Never invent a tool result, and never write a block for a tool outside this list:`,
    signatures || "(no local tools are available in this request)"
  ].join("\n");
}

// Tool history arrives in OpenAI shape. A text-only provider cannot read
// tool_calls or a tool role, so prior calls are replayed as protocol blocks
// and prior results as user-visible [Tool result] turns.
function flattenToolHistory(messages) {
  const namesById = new Map();
  return (Array.isArray(messages) ? messages : []).map(message => {
    if (message?.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      const blocks = message.tool_calls
        .filter(call => typeof call?.function?.name === "string" && call.function.name)
        .map(call => {
          if (typeof call.id === "string" && call.id) namesById.set(call.id, call.function.name);
          let args = call.function.arguments;
          if (typeof args === "string") {
            try {
              args = JSON.parse(args);
            } catch {
              args = {};
            }
          }
          if (!args || typeof args !== "object" || Array.isArray(args)) args = {};
          return `${TEXT_TOOL_OPEN}${JSON.stringify({ name: call.function.name, arguments: args })}${TEXT_TOOL_CLOSE}`;
        });
      const content = [
        typeof message.content === "string" ? message.content.trim() : "",
        ...blocks
      ].filter(Boolean).join("\n");
      return { role: "assistant", content };
    }
    if (message?.role === "tool") {
      const name = namesById.get(message.tool_call_id) || "tool";
      return {
        role: "user",
        content: `[Tool result: ${name}]\n${typeof message.content === "string" ? message.content : ""}`
      };
    }
    const { tool_calls, ...rest } = message || {};
    return rest;
  });
}

function withTextToolProtocol(messages, tools) {
  if (!Array.isArray(tools) || tools.length === 0) return messages;
  const prompt = toolProtocolPrompt(tools);
  let attached = false;
  const next = messages.map(message => {
    if (!attached && message?.role === "system" && typeof message.content === "string") {
      attached = true;
      return { ...message, content: `${message.content}\n\n${prompt}` };
    }
    return message;
  });
  if (!attached) next.unshift({ role: "system", content: prompt });
  return next;
}

export function parseTextToolCalls(content, tools) {
  const text = typeof content === "string" ? content : "";
  const names = toolNameSet(tools);
  if (!text || names.size === 0) return { content: text, toolCalls: [] };
  const toolCalls = [];
  let stripped = text.replace(TEXT_TOOL_BLOCK, (block, body) => {
    if (toolCalls.length >= TEXT_TOOL_MAX_CALLS) return block;
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      return block;
    }
    const name = typeof parsed?.name === "string" ? parsed.name.trim() : "";
    // A name outside the tools supplied with this request stays visible text
    // and is never executed.
    if (!names.has(name)) return block;
    let args = parsed?.arguments ?? {};
    const argsText = typeof args === "string" ? args : JSON.stringify(args);
    if (typeof argsText !== "string" || argsText.length > 200000) return block;
    textToolCallSeq += 1;
    toolCalls.push({
      id: `text_call_${textToolCallSeq}`,
      type: "function",
      function: { name, arguments: argsText }
    });
    return "";
  });
  return {
    content: stripped.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim(),
    toolCalls
  };
}

export function buildChatRequestBody({ model, messages, temperature, maxTokens, stream, responses = false, reasoning, tools = null, toolChoice = null, streamUsage = false }) {
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
    if (Array.isArray(tools) && tools.length > 0) {
      const flattened = tools
        .map(tool => {
          const fn = tool?.function || tool;
          if (typeof fn?.name !== "string" || !fn.name) return null;
          return {
            type: "function",
            name: fn.name,
            description: typeof fn.description === "string" ? fn.description : "",
            parameters: fn.parameters && typeof fn.parameters === "object" ? fn.parameters : { type: "object", properties: {} },
            strict: false
          };
        })
        .filter(Boolean);
      if (flattened.length > 0) {
        body.tools = flattened;
        if (typeof toolChoice === "string") body.tool_choice = toolChoice;
      }
    }
    return body;
  }
  const body = { model, messages: serializeMessages(messages), stream };
  if (typeof temperature === "number" && Number.isFinite(temperature)) body.temperature = temperature;
  if (typeof maxTokens === "number" && Number.isFinite(maxTokens)) body.max_tokens = maxTokens;
  if (reasoning && typeof reasoning === "object") body.reasoning = reasoning;
  if (Array.isArray(tools) && tools.length > 0) body.tools = tools;
  if (toolChoice && body.tools) body.tool_choice = toolChoice;
  if (stream && streamUsage) body.usage = { include: true };
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
  const anthropic = extractAnthropicText(payload);
  if (anthropic.length > 0) return anthropic;
  const content = payload?.choices?.[0]?.message?.content;
  return typeof content === "string" ? content : "";
}

function responsesFinishReason(payload) {
  if (typeof payload?.incomplete_details?.reason === "string") {
    return payload.incomplete_details.reason === "max_output_tokens" ? "length" : payload.incomplete_details.reason;
  }
  return payload?.status === "completed" ? "stop" : null;
}

function anthropicToolCalls(payload) {
  if (!Array.isArray(payload?.content)) return [];
  return payload.content
    .filter(part => part?.type === "tool_use" && typeof part.name === "string" && part.name)
    .map((part, index) => ({
      id: typeof part.id === "string" && part.id ? part.id : `anthropic_call_${index}`,
      type: "function",
      function: {
        name: part.name,
        arguments: JSON.stringify(part.input && typeof part.input === "object" ? part.input : {})
      }
    }));
}

function responsesToolCalls(payload) {
  if (!Array.isArray(payload?.output)) return [];
  return payload.output
    .filter(item => item?.type === "function_call" && typeof item.name === "string" && item.name)
    .map((item, index) => ({
      id: typeof item.call_id === "string" && item.call_id
        ? item.call_id
        : typeof item.id === "string" && item.id ? item.id : `responses_call_${index}`,
      type: "function",
      function: {
        name: item.name,
        arguments: typeof item.arguments === "string"
          ? item.arguments
          : JSON.stringify(item.arguments ?? {})
      }
    }));
}

function openAiToolCalls(payload) {
  const calls = payload?.choices?.[0]?.message?.tool_calls;
  if (!Array.isArray(calls)) return [];
  return calls
    .filter(call => call?.type === "function" && call?.function?.name)
    .map(call => ({
      id: typeof call.id === "string" ? call.id : "",
      type: "function",
      function: {
        name: String(call.function.name),
        arguments: typeof call.function.arguments === "string" ? call.function.arguments : "{}"
      }
    }));
}

// A model documented as tool-capable can still reject the tool fields — an
// older snapshot, a proxy that strips them, or a model retired upstream. Only
// that exact rejection switches the same turn to the text protocol; any other
// 400 keeps its own honest message and is never retried as a tool request.
function toolsTransportRejected(status, payload) {
  if (status !== 400 && status !== 404 && status !== 422) return false;
  const parts = [
    payload?.error?.message,
    payload?.message,
    typeof payload?.error === "string" ? payload.error : "",
    typeof payload === "string" ? payload : ""
  ].filter(part => typeof part === "string");
  return /\btools?\b|tool_choice|function[_ ]?calling|tool_use|unsupported/i.test(parts.join(" "));
}

export async function chatCompletion({ baseUrl, apiKey, model, messages, temperature, maxTokens, providerType = "openai_compatible", authMode = "pat", openapiBaseUrl = "", reasoning, requestId = null, attempt = null, tools = null, toolChoice = null, conversationId = null }, signal) {
  const type = normalizeProviderType(providerType);
  const hasTools = Array.isArray(tools) && tools.length > 0;
  if (type === "qoder_cloud_agents") {
    const qoderMessages = hasTools ? withTextToolProtocol(flattenToolHistory(messages), tools) : messages;
    return qoderCompletion(
      { baseUrl, apiKey, authMode, openapiBaseUrl, model, messages: qoderMessages, conversationId, requestId, attempt, tools: hasTools ? tools : null },
      signal
    );
  }
  const anthropic = usesAnthropicApi(baseUrl, model, type);
  const watsonx = !isOpenCodeZenBase(baseUrl) && type === "watsonx";
  const responses = !anthropic && !watsonx && usesResponsesApi(baseUrl, model, type);
  const url = resolveChatEndpoint(baseUrl, model, type);
  const context = { requestId, attempt, model };
  const transport = resolveToolTransport(baseUrl, model, type);
  // Text-only transports get the protocol prompt plus a flattened history;
  // every other transport receives the native tool contract.
  const textMessages = withTextToolProtocol(flattenToolHistory(messages), hasTools ? tools : null);
  const buildBody = mode => {
    const nativeTools = mode === "text" ? null : hasTools ? tools : null;
    const outgoing = mode === "text" ? textMessages : messages;
    if (anthropic) {
      return buildAnthropicRequestBody({ model, messages: outgoing, temperature, maxTokens, stream: false, tools: nativeTools, toolChoice });
    }
    if (watsonx) {
      return buildWatsonxRequestBody({ model, messages: outgoing, temperature, maxTokens, stream: false, projectId: requireWatsonxProjectId(baseUrl) });
    }
    return buildChatRequestBody({
      model,
      messages: outgoing,
      temperature,
      maxTokens,
      stream: false,
      responses,
      reasoning,
      tools: nativeTools,
      toolChoice
    });
  };
  const send = async requestBody => {
    try {
      return await guardedProviderFetch(url, {
        method: "POST",
        headers: await authHeaders(apiKey, type, baseUrl),
        body: JSON.stringify(requestBody),
        signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
    } catch (error) {
      if (error?.name === "TimeoutError" || error?.name === "AbortError") {
        // A caller stop is an outcome, not a slow provider: classifying it as a
        // retryable timeout makes every retry loop try again after Stop. A
        // composed deadline signal still aborts with the TimeoutError reason, so
        // it keeps its retryable timeout meaning.
        if (signal?.aborted && error?.name !== "TimeoutError") {
          throw new ProviderError("Request cancelled.", null, "cancelled");
        }
        throw attachProviderDiagnostic(
          new ProviderError("Timed out while waiting for the provider.", null, "timeout"),
          { url, context, classification: { category: "timeout", classification: "transient", retryable: true } }
        );
      }
      if (error instanceof ProviderError) throw error;
      throw networkError(error, url, context);
    }
  };

  let activeTransport = transport;
  let response = await send(buildBody(activeTransport));
  if (!response.ok) {
    const failure = await readJsonSafely(response);
    const error = providerHttpError(
      url,
      response.status,
      failure,
      parseRetryAfter(response.headers.get("retry-after")),
      response.headers,
      context
    );
    if (!hasTools || activeTransport === "text" || !toolsTransportRejected(error.status, failure)) {
      throw error;
    }
    activeTransport = "text";
    response = await send(buildBody("text"));
    if (!response.ok) {
      const retryFailure = await readJsonSafely(response);
      throw providerHttpError(
        url,
        response.status,
        retryFailure,
        parseRetryAfter(response.headers.get("retry-after")),
        response.headers,
        context
      );
    }
  }
  const payload = await readJsonSafely(response);
  const providerContent = anthropic ? extractAnthropicText(payload) : extractResponseText(payload);
  let content = providerContent;
  let nativeToolCalls = [];
  if (activeTransport === "anthropic" && anthropic) nativeToolCalls = anthropicToolCalls(payload);
  else if (activeTransport === "openai_responses" && responses) nativeToolCalls = responsesToolCalls(payload);
  else if (activeTransport === "openai_chat" && !anthropic && !responses) nativeToolCalls = openAiToolCalls(payload);
  let toolCalls = nativeToolCalls;
  if (activeTransport === "text" && hasTools) {
    const parsed = parseTextToolCalls(providerContent, tools);
    content = parsed.content;
    toolCalls = parsed.toolCalls;
  }
  if (content.length === 0 && toolCalls.length === 0) {
    const message = payload?.choices?.[0]?.message;
    const reasoned =
      Number(payload?.usage?.completion_tokens_details?.reasoning_tokens) > 0 ||
      (typeof message?.reasoning === "string" && message.reasoning.length > 0) ||
      (Array.isArray(message?.reasoning_details) && message.reasoning_details.length > 0);
    if (reasoned && payload?.choices?.[0]?.finish_reason === "length") {
      throw attachProviderDiagnostic(
        new ProviderError(
          "The model spent its whole output budget on reasoning before writing an answer. Raise the maximum output tokens, or choose a model that reasons less.",
          response.status,
          "output_limit"
        ),
        { url, status: response.status, context, headers: response.headers, classification: { category: "output_limit", classification: "permanent", retryable: false } }
      );
    }
    throw attachProviderDiagnostic(
      new ProviderError("The provider returned an empty or unexpected response.", response.status, "empty_response"),
      { url, status: response.status, context, headers: response.headers, classification: { category: "empty_response", classification: "permanent", retryable: false } }
    );
  }
  return {
    content,
    toolTransport: activeTransport,
    finishReason: anthropic
      ? anthropicFinishReason(payload)
      : responses ? responsesFinishReason(payload) : (typeof payload?.choices?.[0]?.finish_reason === "string" ? payload.choices[0].finish_reason : null),
    ...(toolCalls.length > 0 ? {
      toolCalls,
      assistantMessage: {
        role: "assistant",
        content: content || null,
        tool_calls: toolCalls
      }
    } : {})
  };
}

export async function startChatCompletionStream({ baseUrl, apiKey, model, messages, temperature, maxTokens, providerType = "openai_compatible", authMode = "pat", openapiBaseUrl = "", reasoning, requestId = null, attempt = null, responseTimeoutMs = null, conversationId = null }, signal) {
  const type = normalizeProviderType(providerType);
  const anthropic = usesAnthropicApi(baseUrl, model, type);
  const watsonx = !isOpenCodeZenBase(baseUrl) && type === "watsonx";
  const responses = !anthropic && !watsonx && usesResponsesApi(baseUrl, model, type);
  const url = resolveChatEndpoint(baseUrl, model, type, { stream: true });
  const context = { requestId, attempt, model };

  let responseTimer = null;
  let responseTimedOut = false;
  let requestSignal = signal;
  if (Number.isFinite(responseTimeoutMs) && responseTimeoutMs >= 1000) {
    const timeoutController = new AbortController();
    responseTimer = setTimeout(() => {
      responseTimedOut = true;
      timeoutController.abort();
    }, responseTimeoutMs);
    responseTimer.unref?.();
    requestSignal = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal;
  }

  if (type === "qoder_cloud_agents") {
    try {
      return await qoderStartStream(
        { baseUrl, apiKey, authMode, openapiBaseUrl, model, messages, conversationId, clientSignal: signal ?? null, requestId, attempt },
        requestSignal ?? AbortSignal.timeout(STREAM_TIMEOUT_MS)
      );
    } catch (error) {
      if (responseTimedOut) {
        throw attachProviderDiagnostic(
          new ProviderError("Timed out while waiting for Qoder to start its event stream.", null, "timeout"),
          { url, context, classification: { category: "timeout", classification: "transient", retryable: true } }
        );
      }
      throw error;
    } finally {
      if (responseTimer) clearTimeout(responseTimer);
    }
  }

  const body = anthropic
    ? buildAnthropicRequestBody({ model, messages, temperature, maxTokens, stream: true })
    : watsonx
      ? buildWatsonxRequestBody({ model, messages, temperature, maxTokens, stream: true, projectId: requireWatsonxProjectId(baseUrl) })
      : buildChatRequestBody({ model, messages, temperature, maxTokens, stream: true, responses, reasoning, streamUsage: isOpenRouterBase(baseUrl) });

  let response;
  try {
    response = await guardedProviderFetch(url, {
      method: "POST",
      headers: { ...(await authHeaders(apiKey, type, baseUrl)), Accept: "text/event-stream" },
      body: JSON.stringify(body),
      signal: requestSignal ?? AbortSignal.timeout(STREAM_TIMEOUT_MS)
    });
  } catch (error) {
    if (responseTimedOut) {
      throw attachProviderDiagnostic(
        new ProviderError("Timed out while waiting for the provider to start its stream.", null, "timeout"),
        { url, context, classification: { category: "timeout", classification: "transient", retryable: true } }
      );
    }
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      if (signal?.aborted && error?.name !== "TimeoutError") {
        throw new ProviderError("Request cancelled.", null, "cancelled");
      }
      throw attachProviderDiagnostic(
        new ProviderError("Timed out while waiting for the provider's stream.", null, "timeout"),
        { url, context, classification: { category: "timeout", classification: "transient", retryable: true } }
      );
    }
    if (error instanceof ProviderError) throw error;
    throw networkError(error, url, context);
  } finally {
    if (responseTimer) clearTimeout(responseTimer);
  }
  if (!response.ok) {
    const failure = await readJsonSafely(response);
    throw providerHttpError(
      url,
      response.status,
      failure,
      parseRetryAfter(response.headers.get("retry-after")),
      response.headers,
      context
    );
  }
  if (!response.body) {
    throw attachProviderDiagnostic(
      new ProviderError("The provider did not return a response stream.", response.status, "empty_stream"),
      { url, status: response.status, context, headers: response.headers, classification: { category: "empty_stream", classification: "permanent", retryable: false } }
    );
  }
  return response;
}

export function extractStreamText(payload) {
  if (payload?.type === "response.output_text.delta" && typeof payload.delta === "string") return payload.delta;
  if (payload?.type === "content_block_delta" && typeof payload?.delta?.text === "string") return payload.delta.text;
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

// Reasoning travels beside the answer, never inside it: OpenRouter sends it as
// delta.reasoning and delta.reasoning_details (same increment twice), Anthropic
// as a thinking content block.
export function extractStreamReasoning(payload) {
  if (payload?.type === "content_block_delta" && payload?.delta?.type === "thinking") {
    return typeof payload.delta.thinking === "string" ? payload.delta.thinking : "";
  }
  const delta = payload?.choices?.[0]?.delta;
  if (!delta || typeof delta !== "object") return "";
  if (Array.isArray(delta.reasoning_details)) {
    const structured = delta.reasoning_details
      .filter(part => part?.type === "reasoning.text" && typeof part.text === "string")
      .map(part => part.text)
      .join("");
    if (structured) return structured;
  }
  return typeof delta.reasoning === "string" ? delta.reasoning : "";
}

const UNSUPPORTED_LISTING_CODES = new Set(["not_found", "method_not_allowed", "unsupported_listing", "bad_request"]);

// Qoder only. A 400 from the business API means the request itself was rejected
// (wrong mode, unexpected parameters, malformed base path) — not that the model
// endpoint is absent. Reusing UNSUPPORTED_LISTING_CODES here turned a real
// failure into a green "connected" result with zero models, so the picker lost
// every Qoder row. Authentication, rate-limit, server and timeout errors were
// already rethrown; this set only removes bad_request.
const QODER_UNSUPPORTED_LISTING_CODES = new Set(["not_found", "method_not_allowed", "unsupported_listing"]);

async function discoverModels({ baseUrl, apiKey, providerType, authMode, openapiBaseUrl }, signal) {
  try {
    return { availableModels: await listProviderModels({ baseUrl, apiKey, providerType, authMode, openapiBaseUrl }, signal), listingSupported: true, listError: null };
  } catch (error) {
    if (error instanceof ProviderError && UNSUPPORTED_LISTING_CODES.has(error.code)) {
      return { availableModels: [], listingSupported: false, listError: error };
    }
    throw error;
  }
}

// Qoder's documented read-only endpoints are the model list and agents?limit=1.
// For service accounts the exchange runs first so a failure can be attributed to
// the exchange or to the business API, never to "connected" after only stage 1.
async function testQoderConnection({ baseUrl, apiKey, authMode, openapiBaseUrl }, signal) {
  const credentials = qoderCredentials({ baseUrl, apiKey, authMode, openapiBaseUrl });
  if (credentials.authMode === "service_account") await qoderAccessToken(credentials);
  const metadata = {
    authMode: credentials.authMode,
    region: credentials.region,
    businessHost: credentials.businessHost,
    openapiHost: credentials.openapiRoot ? new URL(credentials.openapiRoot).hostname : null
  };
  try {
    const availableModels = await qoderListModels(credentials, signal);
    return {
      availableModels,
      modelChecked: false,
      sample: null,
      listingSupported: true,
      warning: availableModels.length > 0
        ? null
        : "Qoder answered the model list successfully, but it contains no enabled models. Enable the models you need in Qoder, then use Test model with an exact model ID.",
      ...metadata
    };
  } catch (error) {
    if (!(error instanceof ProviderError) || !QODER_UNSUPPORTED_LISTING_CODES.has(error.code)) throw error;
    // The model list is documented but an account may not expose it. A real
    // read-only agents request still proves the business API works.
    await qoderProbeAgents(credentials, signal);
    return {
      availableModels: [],
      modelChecked: false,
      sample: null,
      listingSupported: false,
      warning: "Connected to the Qoder business API, but the model list endpoint was not available. Use Test model to verify the saved model and credentials.",
      ...metadata
    };
  }
}

// Connection checks are deliberately zero-inference: they contact the
// documented read-only endpoint only. Some providers do not expose a model list,
// in which case we report that the endpoint was reached but credentials still
// need an explicit model test.
export async function testProviderConnection({ baseUrl, apiKey, providerType = "openai_compatible", authMode = "pat", openapiBaseUrl = "" }, signal) {
  if (normalizeProviderType(providerType) === "qoder_cloud_agents") {
    return testQoderConnection({ baseUrl, apiKey, authMode, openapiBaseUrl }, signal);
  }
  const discovery = await discoverModels({ baseUrl, apiKey, providerType }, signal);
  return {
    availableModels: discovery.availableModels,
    modelChecked: false,
    sample: null,
    listingSupported: discovery.listingSupported,
    warning: discovery.listingSupported
      ? null
      : "The endpoint was reached, but its model list could not be verified" +
        (discovery.listError?.message ? ": " + discovery.listError.message : ".") +
        " Use Test model to verify the saved model and credentials."
  };
}

export const checkProviderConnection = testProviderConnection;

// Explicit, user-triggered inference used by the separate "Test model" action.
export async function testProviderModel({ baseUrl, apiKey, model, providerType = "openai_compatible", authMode = "pat", openapiBaseUrl = "" }, signal) {
  if (typeof model !== "string" || model.trim().length === 0) {
    throw new ProviderError("Enter the exact model ID from your provider before testing a model.", 400, "missing_model");
  }
  const selectedModel = model.trim();
  if (selectedModel.length > 200) {
    throw new ProviderError("Model ID must be 200 characters or fewer.", 400, "invalid_model");
  }
  if (isOpenCodeZenBase(baseUrl)) rejectFreeZenModel(selectedModel);
  let availableModels = [];
  try {
    const discovery = await discoverModels({ baseUrl, apiKey, providerType, authMode, openapiBaseUrl }, signal);
    availableModels = discovery.availableModels;
  } catch (error) {
    // Authentication/network failures are authoritative even if listing is not
    // supported; only the unsupported-listing cases fall through to inference.
    if (!(error instanceof ProviderError) || !UNSUPPORTED_LISTING_CODES.has(error.code)) throw error;
  }
  if (availableModels.length > 0 && !availableModels.some(entry => entry.id === selectedModel)) {
    throw new ProviderError(`The provider does not list a model named "${selectedModel}". Refresh the model list and choose an available model.`, null, "model_unavailable");
  }
  const result = await chatCompletion(
    { baseUrl, apiKey, providerType, authMode, openapiBaseUrl, model: selectedModel, messages: [{ role: "user", content: "Reply with OK." }], maxTokens: 64 },
    signal
  );
  return { availableModels, modelChecked: true, sample: result.content.slice(0, 40), listingSupported: availableModels.length > 0 };
}

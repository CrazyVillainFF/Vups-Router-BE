import dns from "node:dns/promises";
import { PluginError } from "./errors.js";

const USER_AGENT = "VupsRouter/1.0 (plugin marketplace; +https://vups-router-three.vercel.app)";
const DEFAULT_TIMEOUT_MS = 12000;
const DEFAULT_MAX_BYTES = 1024 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function timeoutSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function retryAfterMs(headers) {
  const raw = headers?.get?.("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 5000);
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.max(0, Math.min(date - Date.now(), 5000));
  return null;
}

function safeMessage(text, status) {
  const trimmed = String(text || "").replace(/\s+/g, " ").trim().slice(0, 300);
  return trimmed || `The service returned HTTP ${status}.`;
}

function isRetryableStatus(status) {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (!signal) return;
    if (signal.aborted) {
      clearTimeout(timer);
      reject(new PluginError("The plugin request was cancelled.", 499, "cancelled"));
      return;
    }
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new PluginError("The plugin request was cancelled.", 499, "cancelled"));
    }, { once: true });
  });
}

async function assertPublicHost(value, label = "The plugin service") {
  const url = value instanceof URL ? value : new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new PluginError(`${label} requests can only use http or https.`, 400, "invalid_url");
  }
  if (isPrivateHostname(url.hostname)) {
    throw new PluginError(`${label} cannot be pointed at a private or local address.`, 400, "private_endpoint");
  }
  let addresses;
  try {
    addresses = await dns.lookup(url.hostname, { all: true, verbatim: true });
  } catch {
    throw new PluginError(`${label} hostname could not be resolved.`, 502, "dns_error");
  }
  if (addresses.length === 0 || addresses.some(entry => isPrivateAddress(entry.address))) {
    throw new PluginError(`${label} cannot be pointed at a private or local address.`, 400, "private_endpoint");
  }
  return url;
}

// Redirects are followed manually so every hop is re-validated: a trusted provider
// that 302s to 169.254.169.254 must not turn a plugin call into SSRF.
async function fetchFollowingValidatedRedirects(url, init, maxRedirects = 3) {
  let current = await assertPublicHost(url);
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const response = await fetch(current, { ...init, redirect: "manual" });
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) {
      throw new PluginError("The plugin service redirected without a destination.", 502, "unsafe_redirect");
    }
    try {
      await response.body?.cancel();
    } catch {
      /* redirect body already closed */
    }
    current = await assertPublicHost(new URL(location, current));
  }
  throw new PluginError("The plugin service redirected too many times.", 502, "unsafe_redirect");
}

export async function requestText(url, {
  method = "GET",
  headers = {},
  body,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = DEFAULT_MAX_BYTES,
  retries = method === "GET" ? 1 : 0,
  signal
} = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let response;
    try {
      response = await fetchFollowingValidatedRedirects(url, {
        method,
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "application/json, text/plain, application/xml;q=0.8, */*;q=0.5",
          ...headers
        },
        ...(body === undefined ? {} : { body }),
        signal: timeoutSignal(signal, timeoutMs)
      });
    } catch (error) {
      if (error instanceof PluginError) throw error;
      if (signal?.aborted || error?.name === "AbortError" || error?.name === "TimeoutError") {
        throw new PluginError("The plugin service took too long to respond.", 504, "timeout");
      }
      lastError = new PluginError("Could not reach the plugin service.", 502, "network_error", { cause: error });
      if (attempt < retries) {
        await sleep(250 * (attempt + 1), signal);
        continue;
      }
      throw lastError;
    }

    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > maxBytes) {
      throw new PluginError("The plugin service returned more data than allowed.", 502, "response_too_large");
    }
    const text = await response.text();
    if (text.length > maxBytes) {
      throw new PluginError("The plugin service returned more data than allowed.", 502, "response_too_large");
    }
    if (response.ok) return text;

    const retryAfter = retryAfterMs(response.headers);
    const message = safeMessage(text, response.status);
    lastError = new PluginError(message, response.status, "upstream_error", { retryAfter });
    if (isRetryableStatus(response.status) && attempt < retries) {
      await sleep(retryAfter ?? 350 * (attempt + 1), signal);
      continue;
    }
    throw lastError;
  }
  throw lastError || new PluginError("The plugin request failed.", 502, "upstream_error");
}

export async function requestJson(url, options = {}) {
  const text = await requestText(url, options);
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new PluginError("The plugin service returned an invalid JSON response.", 502, "invalid_response");
  }
}

export function queryString(values) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values || {})) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  return params.toString();
}

export function boundedText(value, max = 20000) {
  const text = String(value ?? "").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function decodeEntities(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

export function htmlToText(html) {
  return boundedText(
    decodeEntities(
      String(html || "")
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
        .replace(/<[^>]+>/g, " ")
    ).replace(/\s+/g, " "),
    20000
  );
}

function isPrivateHostname(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/\.$/, "");
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  return false;
}

function isPrivateAddress(address) {
  const value = String(address || "").toLowerCase();
  if (value === "::1" || value === "::" || value === "0.0.0.0") return true;
  if (value.startsWith("fc") || value.startsWith("fd") || value.startsWith("fe80:")) return true;
  if (value.startsWith("::ffff:")) return isPrivateAddress(value.slice(7));
  const parts = value.split(".").map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [first, second] = parts;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    first >= 224
  );
}

async function assertPublicUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new PluginError("Enter a valid http or https URL.", 400, "invalid_url");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new PluginError("Only http and https URLs can be read.", 400, "invalid_url");
  }
  if (isPrivateHostname(url.hostname)) {
    throw new PluginError("Private and local addresses cannot be read by the URL plugin.", 400, "private_endpoint");
  }
  let addresses;
  try {
    addresses = await dns.lookup(url.hostname, { all: true, verbatim: true });
  } catch {
    throw new PluginError("The URL hostname could not be resolved.", 502, "dns_error");
  }
  if (addresses.some(entry => isPrivateAddress(entry.address))) {
    throw new PluginError("Private and local addresses cannot be read by the URL plugin.", 400, "private_endpoint");
  }
  return url;
}

export async function readPublicUrl(value, { maxChars = 12000, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
  let current = await assertPublicUrl(value);
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const response = await fetch(current, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html, text/plain, application/json, application/xml;q=0.9, */*;q=0.5" },
      redirect: "manual",
      signal: timeoutSignal(signal, timeoutMs)
    });
    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new PluginError("The URL redirected without a destination.", 502, "unsafe_redirect");
      const next = new URL(location, current);
      try {
        await response.body?.cancel();
      } catch {
        /* redirect body already closed */
      }
      current = await assertPublicUrl(next.toString());
      continue;
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new PluginError(safeMessage(text, response.status), response.status, "upstream_error");
    }
    const type = String(response.headers.get("content-type") || "").toLowerCase();
    if (!/(text\/|application\/(json|xml|xhtml\+xml|rss\+xml|atom\+xml))/.test(type)) {
      try {
        await response.body?.cancel();
      } catch {
        /* body already closed */
      }
      throw new PluginError("This URL does not return readable text, HTML, JSON, or XML.", 415, "unsupported_content");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new PluginError("The URL returned no readable content.", 502, "empty_response");
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      total += chunk.byteLength;
      if (total > DEFAULT_MAX_BYTES) {
        await reader.cancel().catch(() => {});
        throw new PluginError("The page is larger than the URL plugin can safely read.", 413, "response_too_large");
      }
      chunks.push(chunk);
    }
    const text = new TextDecoder().decode(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))));
    const isHtml = /html/.test(type);
    const titleMatch = isHtml ? text.match(/<title[^>]*>([\s\S]*?)<\/title>/i) : null;
    const content = isHtml ? htmlToText(text) : boundedText(text, maxChars);
    return {
      url: current.toString(),
      title: titleMatch ? boundedText(decodeEntities(titleMatch[1]), 300) : "",
      contentType: type.split(";")[0],
      text: boundedText(content, maxChars)
    };
  }
  throw new PluginError("The URL redirected too many times.", 502, "unsafe_redirect");
}

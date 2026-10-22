const CLOUDFLARE_AI_BASE_URL = "https://api.cloudflare.com/client/v4";
const DEFAULT_TIMEOUT_MS = 45000;
const MAX_PROMPT_LENGTH = 2048;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_RESPONSE_CHARS = 16 * 1024 * 1024;

export const IMAGE_GENERATION_MODEL = "@cf/black-forest-labs/flux-1-schnell";

export class ImageGenerationError extends Error {
  constructor(message, status = 502, code = "image_generation_failed") {
    super(message);
    this.name = "ImageGenerationError";
    this.status = status;
    this.code = code;
  }
}

function envText(name) {
  return typeof process.env[name] === "string" ? process.env[name].trim() : "";
}

function timeoutMs() {
  const value = Number(process.env.IMAGE_GENERATION_TIMEOUT_MS);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(120000, Math.max(5000, Math.floor(value)));
}

function dataUrl(base64, mimeType) {
  return `data:${mimeType};base64,${base64}`;
}

function detectImageMime(bytes) {
  if (bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 6) {
    const header = bytes.subarray(0, 6).toString("ascii");
    if (header === "GIF87a" || header === "GIF89a") return "image/gif";
  }
  if (bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  return "";
}

function cleanBase64(value) {
  return String(value || "")
    .replace(/^data:image\/[a-z0-9.+-]+(?:;charset=[^;,]+)?;base64,/i, "")
    .replace(/\s+/g, "");
}

function decodeImage(base64) {
  const cleaned = cleanBase64(base64).replace(/-/g, "+").replace(/_/g, "/");
  if (cleaned.length === 0 || cleaned.length % 4 === 1 || !/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned)) {
    throw new ImageGenerationError("Cloudflare returned an invalid image payload.", 502, "image_generation_invalid_response");
  }
  const padded = cleaned.padEnd(cleaned.length + ((4 - (cleaned.length % 4)) % 4), "=");
  const bytes = Buffer.from(padded, "base64");
  if (bytes.length === 0) {
    throw new ImageGenerationError("Cloudflare returned an empty image.", 502, "image_generation_empty");
  }
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new ImageGenerationError("The generated image is too large to return safely.", 502, "image_generation_too_large");
  }
  const detectedMime = detectImageMime(bytes);
  if (!detectedMime) {
    throw new ImageGenerationError("Cloudflare returned data that is not a supported image.", 502, "image_generation_invalid_response");
  }
  return {
    image: dataUrl(bytes.toString("base64"), detectedMime),
    mimeType: detectedMime,
    bytes: bytes.length
  };
}

export function validateImagePrompt(value) {
  if (typeof value !== "string") return { error: "Enter an image prompt." };
  const prompt = value.trim();
  if (prompt.length === 0) return { error: "Enter an image prompt." };
  if (prompt.length > MAX_PROMPT_LENGTH) {
    return { error: `Image prompts must be ${MAX_PROMPT_LENGTH} characters or fewer.` };
  }
  return { prompt };
}

function providerError(status) {
  if (status === 401 || status === 403) {
    return new ImageGenerationError(
      "Cloudflare rejected the server's Workers AI credentials. Ask the administrator to verify CLOUDFLARE_API_TOKEN.",
      503,
      "image_generation_auth_failed"
    );
  }
  if (status === 429) {
    return new ImageGenerationError(
      "Cloudflare Workers AI is rate-limiting image generation right now. Try again later.",
      429,
      "image_generation_rate_limited"
    );
  }
  if (status === 400 || status === 422) {
    return new ImageGenerationError(
      "Cloudflare rejected that image prompt. Try a clearer or shorter prompt.",
      400,
      "image_generation_rejected"
    );
  }
  if (status === 404) {
    return new ImageGenerationError(
      "The configured Cloudflare image model is unavailable. Ask the administrator to verify the Workers AI model.",
      502,
      "image_generation_model_unavailable"
    );
  }
  return new ImageGenerationError(
    "Cloudflare Workers AI could not generate that image. Try again later.",
    502,
    "image_generation_failed"
  );
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (text.length > MAX_RESPONSE_CHARS) {
    throw new ImageGenerationError("Cloudflare returned an oversized response.", 502, "image_generation_too_large");
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function readBinaryResponse(response) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
    throw new ImageGenerationError("The generated image is too large to return safely.", 502, "image_generation_too_large");
  }
  if (!response.body) return Buffer.from(await response.arrayBuffer());

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_IMAGE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new ImageGenerationError("The generated image is too large to return safely.", 502, "image_generation_too_large");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

async function parseSuccessfulResponse(response) {
  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  if (contentType.startsWith("image/")) {
    const buffer = await readBinaryResponse(response);
    if (buffer.length === 0) {
      throw new ImageGenerationError("Cloudflare returned an empty image.", 502, "image_generation_empty");
    }
    const mimeType = detectImageMime(buffer);
    if (!mimeType) {
      throw new ImageGenerationError("Cloudflare returned data that is not a supported image.", 502, "image_generation_invalid_response");
    }
    return {
      image: dataUrl(buffer.toString("base64"), mimeType),
      mimeType,
      model: IMAGE_GENERATION_MODEL
    };
  }

  const payload = await readJsonResponse(response);
  if (!payload || payload.success === false) {
    throw new ImageGenerationError("Cloudflare returned an invalid response.", 502, "image_generation_invalid_response");
  }
  const rawImage = payload?.result?.image ?? payload?.image;
  if (typeof rawImage !== "string") {
    throw new ImageGenerationError("Cloudflare returned no image data.", 502, "image_generation_empty");
  }
  const decoded = decodeImage(rawImage);
  return {
    image: decoded.image,
    mimeType: decoded.mimeType,
    model: IMAGE_GENERATION_MODEL
  };
}

export function assertImageGenerationConfigured() {
  if (!envText("CLOUDFLARE_ACCOUNT_ID") || !envText("CLOUDFLARE_API_TOKEN")) {
    throw new ImageGenerationError(
      "Image generation is not configured on this server. Ask the administrator to set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.",
      503,
      "image_generation_not_configured"
    );
  }
}

export async function generateImage(prompt) {
  assertImageGenerationConfigured();
  const accountId = envText("CLOUDFLARE_ACCOUNT_ID");
  const apiToken = envText("CLOUDFLARE_API_TOKEN");
  const baseUrl = (envText("CLOUDFLARE_AI_BASE_URL") || CLOUDFLARE_AI_BASE_URL).replace(/\/+$/, "");
  let url;
  try {
    url = `${new URL(baseUrl).toString().replace(/\/+$/, "")}/accounts/${encodeURIComponent(accountId)}/ai/run/${IMAGE_GENERATION_MODEL}`;
  } catch {
    throw new ImageGenerationError(
      "The server's Cloudflare Workers AI endpoint is invalid. Ask the administrator to verify CLOUDFLARE_AI_BASE_URL.",
      503,
      "image_generation_not_configured"
    );
  }

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
        Accept: "application/json, image/*"
      },
      body: JSON.stringify({ prompt }),
      signal: AbortSignal.timeout(timeoutMs())
    });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw new ImageGenerationError("Image generation timed out. Try again.", 504, "image_generation_timeout");
    }
    throw new ImageGenerationError(
      "The VupsRouter server could not reach Cloudflare Workers AI. Try again later.",
      502,
      "image_generation_unreachable"
    );
  }

  if (!response.ok) {
    await readJsonResponse(response).catch(() => null);
    console.error("Cloudflare image generation rejected request:", response.status);
    throw providerError(response.status);
  }

  try {
    return await parseSuccessfulResponse(response);
  } catch (error) {
    if (error instanceof ImageGenerationError) throw error;
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw new ImageGenerationError("Image generation timed out. Try again.", 504, "image_generation_timeout");
    }
    throw new ImageGenerationError(
      "The connection to Cloudflare Workers AI was interrupted. Try again later.",
      502,
      "image_generation_unreachable"
    );
  }
}

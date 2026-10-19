import { Buffer } from "node:buffer";

// Image attachment validation for chat requests.
//
// The wire format from the client is the smallest possible representation:
//   { name?, mimeType: "image/png", data: "<base64 without data-url prefix>" }
//
// Limits are configurable (see .env.example):
//   CHAT_IMAGE_MAX_COUNT        default 4    (images per message)
//   CHAT_IMAGE_MAX_BYTES        default 4 MB (per image, decoded)
//   CHAT_IMAGE_MAX_TOTAL_BYTES  default 8 MB (per message, decoded)
//
// The declared MIME type is never trusted: the first bytes of every decoded
// buffer must match a known image signature. Image bytes are never logged.

const envInt = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
};

export const MAX_IMAGES_PER_MESSAGE = envInt("CHAT_IMAGE_MAX_COUNT", 4);
export const MAX_IMAGE_BYTES = envInt("CHAT_IMAGE_MAX_BYTES", 4 * 1024 * 1024);
export const MAX_TOTAL_IMAGE_BYTES = envInt("CHAT_IMAGE_MAX_TOTAL_BYTES", 8 * 1024 * 1024);

export const ALLOWED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const ALLOWED = new Set(ALLOWED_IMAGE_TYPES);
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const MAX_NAME_LENGTH = 120;
const TEXT_OVERHEAD_BYTES = 2 * 1024 * 1024;

// JSON body limit that fits the largest allowed valid request (base64 inflates
// decoded bytes by ~4/3) plus headroom for the text conversation.
export function chatJsonBodyLimit() {
  return TEXT_OVERHEAD_BYTES + Math.ceil((MAX_TOTAL_IMAGE_BYTES * 4) / 3);
}

function mb(bytes) {
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

function sniffImageMime(buffer) {
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
    buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a
  ) {
    return "image/png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buffer.length >= 6 &&
    buffer.toString("ascii", 0, 4) === "GIF8" &&
    (buffer[4] === 0x37 || buffer[4] === 0x39) &&
    buffer[5] === 0x61
  ) {
    return "image/gif";
  }
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    return "image/webp";
  }
  return null;
}

function cleanName(value) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_NAME_LENGTH);
}

/**
 * Validates a client-supplied `images` array.
 * Returns { images } with normalized entries ({ name, mimeType, data, bytes })
 * or { error } with a safe, user-facing message.
 */
export function validateImages(value) {
  if (value === undefined || value === null) return { images: [] };
  if (!Array.isArray(value)) return { error: "images must be an array." };
  if (value.length === 0) return { images: [] };
  if (value.length > MAX_IMAGES_PER_MESSAGE) {
    return { error: `A message can include at most ${MAX_IMAGES_PER_MESSAGE} images.` };
  }
  const images = [];
  let totalBytes = 0;
  for (const entry of value) {
    const mimeType = typeof entry?.mimeType === "string" ? entry.mimeType.trim().toLowerCase() : "";
    if (!ALLOWED.has(mimeType)) {
      return { error: `Images must be ${ALLOWED_IMAGE_TYPES.map(type => type.replace("image/", "").toUpperCase()).join(", ")}.` };
    }
    const data = typeof entry?.data === "string" ? entry.data.trim() : "";
    if (!data || data.length % 4 !== 0 || !BASE64_PATTERN.test(data)) {
      return { error: "An attached image is not valid base64 image data." };
    }
    if (data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) {
      return { error: `Each image must be ${mb(MAX_IMAGE_BYTES)} or smaller.` };
    }
    const bytes = Buffer.from(data, "base64");
    if (bytes.length === 0) return { error: "An attached image is empty." };
    if (bytes.length > MAX_IMAGE_BYTES) {
      return { error: `Each image must be ${mb(MAX_IMAGE_BYTES)} or smaller.` };
    }
    if (sniffImageMime(bytes) !== mimeType) {
      return { error: "An attached image did not contain valid image data for its type." };
    }
    totalBytes += bytes.length;
    if (totalBytes > MAX_TOTAL_IMAGE_BYTES) {
      return { error: `Attached images must total ${mb(MAX_TOTAL_IMAGE_BYTES)} or less per message.` };
    }
    images.push({ name: cleanName(entry?.name), mimeType, data, bytes: bytes.length });
  }
  return { images };
}

export function imageDataUrl(image) {
  return `data:${image.mimeType};base64,${image.data}`;
}

// What gets persisted with a stored message: metadata only, never pixels.
export function attachmentMetadata(images) {
  return images.map(({ name, mimeType, bytes }) => ({ name: name || "", mimeType, bytes }));
}

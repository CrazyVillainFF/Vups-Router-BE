import { isValidEmail } from "./auth.js";
import { isSixDigitCode } from "./resetCode.js";

// Brevo transactional email service for password-reset codes.
//
// Configuration is read from the environment (see .env.example):
//   BREVO_API_KEY - private Brevo API key (never logged or returned)
//   SENDER_EMAIL  - verified Brevo sender address
//   BREVO_API_URL - optional override, defaults to https://api.brevo.com
//                   (used by tests; never point this at an untrusted host)
//
// This module never logs API keys, OTP codes, or email bodies. When Brevo
// rejects a request, the HTTP status and the provider's response body are
// logged on the server so delivery problems are diagnosable, then a safe
// error is thrown for the caller to handle.

const BREVO_API_BASE = "https://api.brevo.com";
export const SENDER_NAME = "VupsRouter";
export const OTP_SUBJECT = "Your password reset code";
export const OTP_TTL_MINUTES = 10;
const REQUEST_TIMEOUT_MS = 10000;

export class EmailDeliveryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "EmailDeliveryError";
    this.code = code;
  }
}

export function brevoApiUrl() {
  const raw = (process.env.BREVO_API_URL || "").trim() || BREVO_API_BASE;
  return raw.replace(/\/+$/, "");
}

export function brevoConfigError() {
  if (!process.env.BREVO_API_KEY || !process.env.BREVO_API_KEY.trim()) {
    return "BREVO_API_KEY is not configured.";
  }
  if (!isValidEmail(process.env.SENDER_EMAIL)) {
    return "SENDER_EMAIL is not a valid email address.";
  }
  return null;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function otpEmailHtml(code, { appName = "VupsRouter" } = {}) {
  return `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:0;background:#0b0e0d;font-family:Arial,Helvetica,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0b0e0d;padding:32px 16px;">
      <tr><td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#111416;border:1px solid rgba(242,244,239,0.12);border-radius:14px;padding:36px 32px;">
          <tr><td>
            <p style="margin:0 0 8px;font-size:13px;letter-spacing:2px;color:#9ca39c;">${escapeHtml(appName)}</p>
            <h1 style="margin:0 0 16px;font-size:24px;color:#f2f4ef;">Your password reset code</h1>
            <p style="margin:0 0 20px;font-size:14px;line-height:1.7;color:#c2c7c0;">
              Enter this six-digit code on the ${escapeHtml(appName)} password reset page:
            </p>
            <div style="margin:0 0 20px;background:#d4ff3f;border-radius:12px;padding:20px 12px;text-align:center;">
              <span style="font-size:40px;line-height:1;font-weight:bold;letter-spacing:12px;color:#11140a;font-family:Arial,Helvetica,sans-serif;">${code}</span>
            </div>
            <p style="margin:0 0 10px;font-size:14px;line-height:1.7;color:#f2f4ef;">
              <b>This code expires in ${OTP_TTL_MINUTES} minutes.</b>
            </p>
            <p style="margin:0 0 10px;font-size:13px;line-height:1.7;color:#9ca39c;">
              If you did not request a password reset, you can safely ignore this email — your password will not change.
            </p>
            <p style="margin:0;font-size:12px;line-height:1.7;color:#6f786e;">
              For your security, never share this code with anyone.
            </p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

export function otpEmailText(code, { appName = "VupsRouter" } = {}) {
  return [
    `${appName} — Your password reset code`,
    "",
    `Enter this six-digit code on the ${appName} password reset page:`,
    "",
    `    ${code}`,
    "",
    `This code expires in ${OTP_TTL_MINUTES} minutes.`,
    "If you did not request a password reset, you can ignore this email — your password will not change.",
    "For your security, never share this code with anyone."
  ].join("\n");
}

function mapStatusToCode(status) {
  if (status === 401 || status === 403) return "invalid_api_key";
  if (status === 429) return "rate_limited";
  if (status === 400) return "bad_request";
  return "provider_unavailable";
}

/**
 * Sends the six-digit password-reset code through Brevo.
 * Resolves with the Brevo message id only when Brevo accepts the request.
 * Throws EmailDeliveryError with a safe `code` otherwise.
 */
export async function sendOtpEmail(toEmail, code) {
  if (!isValidEmail(toEmail)) {
    throw new EmailDeliveryError("bad_request", "A valid recipient email address is required.");
  }
  if (!isSixDigitCode(code)) {
    throw new EmailDeliveryError("bad_request", "A six-digit reset code is required.");
  }
  const configError = brevoConfigError();
  if (configError) {
    throw new EmailDeliveryError("config_missing", "Password recovery email is not configured on the server.");
  }

  const payload = {
    sender: { name: SENDER_NAME, email: process.env.SENDER_EMAIL.trim() },
    to: [{ email: toEmail.trim() }],
    subject: OTP_SUBJECT,
    htmlContent: otpEmailHtml(code.trim()),
    textContent: otpEmailText(code.trim())
  };

  let response;
  try {
    response = await fetch(`${brevoApiUrl()}/v3/smtp/email`, {
      method: "POST",
      headers: {
        "api-key": process.env.BREVO_API_KEY.trim(),
        "content-type": "application/json",
        accept: "application/json"
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch (error) {
    // Never include the payload (which contains the code) in logs.
    console.error("Brevo OTP email network failure:", error?.name || "unknown error");
    const code2 = error?.name === "TimeoutError" ? "timeout" : "network_error";
    throw new EmailDeliveryError(code2, "Could not reach the email provider.");
  }

  if (!response.ok) {
    let detail = "";
    try {
      detail = await response.text();
    } catch {
      detail = "(unreadable response body)";
    }
    // Log the real provider response so misconfiguration (invalid key,
    // unverified sender, quota) is visible in the server logs. The response
    // body describes the request, not the credentials.
    console.error(`Brevo OTP email rejected with HTTP ${response.status}: ${detail.slice(0, 1000)}`);
    throw new EmailDeliveryError(
      mapStatusToCode(response.status),
      `Email provider rejected the request (HTTP ${response.status}).`
    );
  }

  let messageId = null;
  try {
    const body = await response.json();
    messageId = typeof body?.messageId === "string" ? body.messageId : null;
  } catch {
    messageId = null;
  }
  return { messageId };
}

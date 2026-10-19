import { isValidEmail } from "./auth.js";

// Brevo transactional email service.
//
// Configuration is read from the environment (see .env.example):
//   BREVO_API_KEY - private Brevo API key (never logged or returned)
//   SENDER_EMAIL  - verified Brevo sender address
//   BREVO_API_URL - optional override, defaults to https://api.brevo.com
//                   (used by tests; never point this at an untrusted host)
//
// This module never logs API keys, reset tokens, reset links, or email bodies.

const BREVO_API_BASE = "https://api.brevo.com";
export const SENDER_NAME = "Vups";
export const RESET_SUBJECT = "Reset your password";
export const RESET_TOKEN_TTL_MINUTES = 30;
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

export function resetEmailHtml(resetLink, { appName = "VupsRouter" } = {}) {
  const href = escapeHtml(resetLink);
  return `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:0;background:#0b0e0d;font-family:Arial,Helvetica,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0b0e0d;padding:32px 16px;">
      <tr><td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#111416;border:1px solid rgba(242,244,239,0.12);border-radius:14px;padding:36px 32px;">
          <tr><td>
            <p style="margin:0 0 8px;font-size:13px;letter-spacing:2px;color:#9ca39c;">${escapeHtml(appName)}</p>
            <h1 style="margin:0 0 16px;font-size:24px;color:#f2f4ef;">Reset your password</h1>
            <p style="margin:0 0 24px;font-size:14px;line-height:1.7;color:#c2c7c0;">
              We received a request to reset the password for your ${escapeHtml(appName)} account.
              Click the button below to choose a new password.
            </p>
            <p style="margin:0 0 28px;">
              <a href="${href}" style="display:inline-block;background:#d4ff3f;color:#11140a;text-decoration:none;font-weight:bold;font-size:15px;padding:14px 28px;border-radius:999px;">Reset Password</a>
            </p>
            <p style="margin:0 0 10px;font-size:13px;line-height:1.7;color:#9ca39c;">
              This link expires in ${RESET_TOKEN_TTL_MINUTES} minutes and can be used once.
            </p>
            <p style="margin:0 0 10px;font-size:13px;line-height:1.7;color:#9ca39c;">
              If you did not request a password reset, you can safely ignore this email — your password will not change.
            </p>
            <p style="margin:0;font-size:12px;line-height:1.7;color:#6f786e;word-break:break-all;">
              If the button does not work, copy this address into your browser:<br>${href}
            </p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

export function resetEmailText(resetLink, { appName = "VupsRouter" } = {}) {
  return [
    `${appName} — Reset your password`,
    "",
    `We received a request to reset the password for your ${appName} account.`,
    `Open this link to choose a new password:`,
    resetLink,
    "",
    `This link expires in ${RESET_TOKEN_TTL_MINUTES} minutes and can be used once.`,
    "If you did not request a password reset, you can ignore this email — your password will not change."
  ].join("\n");
}

function mapStatusToCode(status) {
  if (status === 401 || status === 403) return "invalid_api_key";
  if (status === 429) return "rate_limited";
  if (status === 400) return "bad_request";
  return "provider_unavailable";
}

/**
 * Sends the password-reset email through Brevo.
 * Resolves with the Brevo message id only when Brevo accepts the request.
 * Throws EmailDeliveryError with a safe `code` otherwise.
 */
export async function sendResetEmail(toEmail, resetLink) {
  if (!isValidEmail(toEmail)) {
    throw new EmailDeliveryError("bad_request", "A valid recipient email address is required.");
  }
  if (typeof resetLink !== "string" || !/^https?:\/\//i.test(resetLink)) {
    throw new EmailDeliveryError("bad_request", "A valid reset link is required.");
  }
  const configError = brevoConfigError();
  if (configError) {
    throw new EmailDeliveryError("config_missing", "Password recovery email is not configured on the server.");
  }

  const payload = {
    sender: { name: SENDER_NAME, email: process.env.SENDER_EMAIL.trim() },
    to: [{ email: toEmail.trim() }],
    subject: RESET_SUBJECT,
    htmlContent: resetEmailHtml(resetLink),
    textContent: resetEmailText(resetLink)
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
    const code = error?.name === "TimeoutError" ? "timeout" : "network_error";
    throw new EmailDeliveryError(code, "Could not reach the email provider.");
  }

  if (!response.ok) {
    throw new EmailDeliveryError(mapStatusToCode(response.status), `Email provider rejected the request (HTTP ${response.status}).`);
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

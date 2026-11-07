import { Router } from "express";
import { hashPassword, isValidEmail, passwordMatches } from "../auth.js";
import connectToDatabase from "../db.js";
import User from "../user.js";
import { brevoConfigError, sendOtpEmail } from "../email.js";
import {
  RESET_DELIVERY_FAILING_WINDOW_MS,
  recordResetDeliveryAttempt,
  resetEmailDeliveryState
} from "../resetDeliveryHealth.js";
import { forgotPasswordRateLimiter, resetPasswordRateLimiter, verifyCodeRateLimiter } from "../middleware.js";
import { RESET_SEND_LIMIT, recordResetSend } from "../resetThrottle.js";
import {
  RESET_AUTH_TTL_MS,
  RESET_CODE_TTL_MS,
  RESET_MAX_ATTEMPTS,
  generateOtp,
  generateResetAuthToken,
  hashResetAuthToken,
  isResetAuthTokenFormat,
  isSixDigitCode
} from "../resetCode.js";

const router = Router();

const SENT_RESPONSE = "If that email exists, we sent a 6-digit code.";
const INVALID_CODE_RESPONSE = "That code is invalid or has expired.";
// Returned whenever the provider is not delivering, for every address. It says
// nothing about whether the address has an account, and it never claims a code
// was sent when one was not.
const DELIVERY_FAILED_RESPONSE =
  "We could not send the reset email just now, so no code was sent. Please try again in a few minutes.";

// `state` describes how the server handled the request — never a hope and never
// a quota. `delivery_pending` is the honest ceiling for a successful request:
// Brevo acknowledges acceptance for sending, it does not confirm an inbox, and
// for an address with no account nothing is sent at all. That value is
// deliberately returned for every address, because any field that differed by
// account would turn the response into an account-existence oracle.
const STATE_DELIVERY_PENDING = "delivery_pending";
const STATE_DELIVERY_FAILED = "delivery_failed";
const STATE_RATE_LIMITED = "rate_limited";
const STATE_INVALID_REQUEST = "invalid_request";
const STATE_INVALID_CODE = "invalid_or_expired_code";
const STATE_CODE_VERIFIED = "code_verified";
const STATE_RESET_COMPLETED = "reset_completed";

// Fields hidden by `select: false` must be requested explicitly.
const RESET_FIELDS = "+resetCodeHash +resetCodeExpires +resetAttempts +resetAuthHash +resetAuthExpires";

function normalizeEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function passwordValidationError(newPassword) {
  if (typeof newPassword !== "string" || newPassword.length < 8 || newPassword.length > 128) {
    return "Password must be between 8 and 128 characters.";
  }
  return null;
}

// Hashes the new password, then performs the single-use consume atomically in
// one document operation. Concurrent requests can never both match the same
// code or authorization, and a hashing failure cannot burn the credential.
async function consumeResetAndSetPassword(filter, newPassword) {
  const passwordHash = await hashPassword(newPassword);
  return User.findOneAndUpdate(
    filter,
    {
      $set: { passwordHash, passwordChangedAt: new Date(), resetAttempts: 0 },
      $unset: { resetCodeHash: 1, resetCodeExpires: 1, resetAuthHash: 1, resetAuthExpires: 1 }
    },
    { returnDocument: "before" }
  );
}

router.post("/forgot-password", forgotPasswordRateLimiter, async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body?.email);
    if (!isValidEmail(email)) {
      return res.status(400).json({ message: "Enter a valid email address.", state: STATE_INVALID_REQUEST });
    }

    // Never report a fake success for unconfigured delivery: fail loudly here
    // and record the configuration problem on the server.
    const configError = brevoConfigError();
    if (configError) {
      console.error("Password reset code email is not configured:", configError);
      return res.status(503).json({
        message: "Email delivery is not configured on the server.",
        state: STATE_DELIVERY_FAILED,
        code: "reset_email_not_configured"
      });
    }

    await connectToDatabase();

    // The provider's recent behaviour is checked before any account is read:
    // while the email service is known to be failing, every address gets the
    // same answer, so the reply cannot reveal whether an address is registered,
    // no code is created that nobody could receive, and the 24-hour send quota
    // is not spent on a request the server refused up front.
    const delivery = await resetEmailDeliveryState();
    if (delivery.failing) {
      res.setHeader("Retry-After", String(Math.max(1, Math.ceil(delivery.retryAfterMs / 1000))));
      return res.status(503).json({
        message: DELIVERY_FAILED_RESPONSE,
        state: STATE_DELIVERY_FAILED,
        code: "reset_email_delivery_failed"
      });
    }

    // Rolling 24-hour send limit, keyed by the normalized email itself — not
    // by an existing account — so known and unknown addresses behave
    // identically (no enumeration oracle) and failed deliveries still count.
    const throttle = await recordResetSend(email);
    if (!throttle.allowed) {
      const minutes = Math.max(1, Math.ceil((throttle.retryAfterMs || 0) / 60000));
      res.setHeader("Retry-After", String(Math.ceil((throttle.retryAfterMs || 0) / 1000)));
      return res.status(429).json({
        message: `Too many reset codes were requested for this email. For security, we send at most ${RESET_SEND_LIMIT} codes per 24 hours — try again in about ${minutes} minute${minutes === 1 ? "" : "s"}.`,
        state: STATE_RATE_LIMITED,
        code: "reset_send_limit"
      });
    }

    let deliveryFailed = false;
    const user = await User.findOne({ email }).select("_id email");
    if (user) {
      const code = generateOtp();
      const codeHash = await hashPassword(code);
      // A fresh code invalidates any previously issued reset authorization.
      await User.updateOne(
        { _id: user._id },
        {
          $set: { resetCodeHash: codeHash, resetCodeExpires: new Date(Date.now() + RESET_CODE_TTL_MS), resetAttempts: 0 },
          $unset: { resetAuthHash: 1, resetAuthExpires: 1 }
        }
      );
      try {
        const receipt = await sendOtpEmail(email, code);
        await recordResetDeliveryAttempt({ ok: true, messageId: receipt?.messageId });
      } catch (error) {
        // The code never reached the user: invalidate it so it cannot be
        // used, and log only the safe error code (never the OTP).
        deliveryFailed = true;
        await User.updateOne({ _id: user._id }, { $unset: { resetCodeHash: 1, resetCodeExpires: 1 } });
        await recordResetDeliveryAttempt({ ok: false, code: error?.code });
        console.error("Password reset code email delivery failed:", error?.code || "unknown");
      }
    }

    if (deliveryFailed) {
      res.setHeader("Retry-After", String(Math.ceil(RESET_DELIVERY_FAILING_WINDOW_MS / 1000)));
      return res.status(503).json({
        message: DELIVERY_FAILED_RESPONSE,
        state: STATE_DELIVERY_FAILED,
        code: "reset_email_delivery_failed"
      });
    }

    return res.json({
      message: SENT_RESPONSE,
      state: STATE_DELIVERY_PENDING,
      remaining: throttle.remaining,
      limit: RESET_SEND_LIMIT
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/verify-code", verifyCodeRateLimiter, async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const code = typeof req.body?.code === "string" ? req.body.code.trim() : "";
    if (!isValidEmail(email) || !isSixDigitCode(code)) {
      return res.status(400).json({ message: INVALID_CODE_RESPONSE, state: STATE_INVALID_REQUEST });
    }

    await connectToDatabase();
    const user = await User.findOne({ email }).select(RESET_FIELDS);
    // No account, no code, an expired code and a spent attempt budget all get
    // the same answer: this response cannot say whether the email is registered.
    if (!user || !user.resetCodeHash || !user.resetCodeExpires || user.resetCodeExpires.getTime() <= Date.now()) {
      return res.status(400).json({ message: INVALID_CODE_RESPONSE, state: STATE_INVALID_CODE });
    }
    if ((user.resetAttempts || 0) >= RESET_MAX_ATTEMPTS) {
      return res.status(400).json({ message: INVALID_CODE_RESPONSE, state: STATE_INVALID_CODE });
    }

    const matches = await passwordMatches(code, user.resetCodeHash);
    if (!matches) {
      // Atomic increment so concurrent wrong guesses are all counted.
      await User.updateOne({ _id: user._id }, { $inc: { resetAttempts: 1 } });
      return res.status(400).json({ message: INVALID_CODE_RESPONSE, state: STATE_INVALID_CODE });
    }

    const rawAuth = generateResetAuthToken();
    // Issue a single-use, short-lived authorization bound to this account.
    // Issuing a new authorization revokes the previous one; the guarded
    // update cannot succeed for a concurrently invalidated code.
    const updated = await User.findOneAndUpdate(
      {
        _id: user._id,
        resetCodeHash: user.resetCodeHash,
        resetCodeExpires: { $gt: new Date() },
        resetAttempts: { $lt: RESET_MAX_ATTEMPTS }
      },
      {
        $set: {
          resetAuthHash: hashResetAuthToken(rawAuth),
          resetAuthExpires: new Date(Date.now() + RESET_AUTH_TTL_MS),
          resetAttempts: 0
        }
      },
      { returnDocument: "after" }
    );
    if (!updated) return res.status(400).json({ message: INVALID_CODE_RESPONSE, state: STATE_INVALID_CODE });

    return res.json({
      success: true,
      message: "Code verified successfully.",
      state: STATE_CODE_VERIFIED,
      resetAuthorization: rawAuth,
      expiresInSeconds: Math.floor(RESET_AUTH_TTL_MS / 1000)
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/reset-password", resetPasswordRateLimiter, async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const code = typeof req.body?.code === "string" ? req.body.code.trim() : "";
    const rawAuth = typeof req.body?.resetAuthorization === "string" ? req.body.resetAuthorization.trim() : "";
    const newPassword = req.body?.newPassword;
    const confirmPassword = req.body?.confirmPassword;

    if (!isValidEmail(email)) {
      return res.status(400).json({ message: "Enter a valid email address.", state: STATE_INVALID_REQUEST });
    }
    const hasAuth = isResetAuthTokenFormat(rawAuth);
    if (!hasAuth && !isSixDigitCode(code)) {
      return res.status(400).json({ message: INVALID_CODE_RESPONSE, state: STATE_INVALID_REQUEST });
    }
    const passwordError = passwordValidationError(newPassword);
    if (passwordError) {
      return res.status(400).json({ message: passwordError, state: STATE_INVALID_REQUEST });
    }
    if (confirmPassword !== undefined && newPassword !== confirmPassword) {
      return res.status(400).json({ message: "Passwords do not match.", state: STATE_INVALID_REQUEST });
    }

    await connectToDatabase();

    if (hasAuth) {
      // The authorization is bound to the account and consumed atomically,
      // so it cannot be replayed or used for a different email.
      const consumed = await consumeResetAndSetPassword(
        { email, resetAuthHash: hashResetAuthToken(rawAuth), resetAuthExpires: { $gt: new Date() } },
        newPassword
      );
      if (!consumed) return res.status(400).json({ message: INVALID_CODE_RESPONSE, state: STATE_INVALID_CODE });
      return res.json({ success: true, message: "Password updated successfully.", state: STATE_RESET_COMPLETED });
    }

    const user = await User.findOne({ email }).select(RESET_FIELDS);
    if (
      !user ||
      !user.resetCodeHash ||
      !user.resetCodeExpires ||
      user.resetCodeExpires.getTime() <= Date.now() ||
      (user.resetAttempts || 0) >= RESET_MAX_ATTEMPTS
    ) {
      return res.status(400).json({ message: INVALID_CODE_RESPONSE, state: STATE_INVALID_CODE });
    }

    const matches = await passwordMatches(code, user.resetCodeHash);
    if (!matches) {
      await User.updateOne({ _id: user._id }, { $inc: { resetAttempts: 1 } });
      return res.status(400).json({ message: INVALID_CODE_RESPONSE, state: STATE_INVALID_CODE });
    }

    const consumed = await consumeResetAndSetPassword(
      { _id: user._id, resetCodeHash: user.resetCodeHash, resetCodeExpires: { $gt: new Date() } },
      newPassword
    );
    if (!consumed) return res.status(400).json({ message: INVALID_CODE_RESPONSE, state: STATE_INVALID_CODE });

    return res.json({ success: true, message: "Password updated successfully.", state: STATE_RESET_COMPLETED });
  } catch (error) {
    return next(error);
  }
});

export default router;

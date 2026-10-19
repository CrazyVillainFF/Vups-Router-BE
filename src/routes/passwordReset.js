import { Router } from "express";
import { hashPassword, isValidEmail, passwordMatches } from "../auth.js";
import connectToDatabase from "../db.js";
import User from "../user.js";
import { brevoConfigError, sendOtpEmail } from "../email.js";
import { forgotPasswordRateLimiter, resetPasswordRateLimiter, verifyCodeRateLimiter } from "../middleware.js";
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
    if (!isValidEmail(email)) return res.status(400).json({ message: "Enter a valid email address." });

    // Never report a fake success for unconfigured delivery: fail loudly here
    // and record the configuration problem on the server.
    const configError = brevoConfigError();
    if (configError) {
      console.error("Password reset code email is not configured:", configError);
      return res.status(503).json({ message: "Email delivery is not configured on the server." });
    }

    await connectToDatabase();
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
        await sendOtpEmail(email, code);
      } catch (error) {
        // The code never reached the user: invalidate it so it cannot be
        // used, and log only the safe error code (never the OTP).
        await User.updateOne({ _id: user._id }, { $unset: { resetCodeHash: 1, resetCodeExpires: 1 } });
        console.error("Password reset code email delivery failed:", error?.code || "unknown");
      }
    }

    return res.json({ message: SENT_RESPONSE });
  } catch (error) {
    return next(error);
  }
});

router.post("/verify-code", verifyCodeRateLimiter, async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const code = typeof req.body?.code === "string" ? req.body.code.trim() : "";
    if (!isValidEmail(email) || !isSixDigitCode(code)) {
      return res.status(400).json({ message: INVALID_CODE_RESPONSE });
    }

    await connectToDatabase();
    const user = await User.findOne({ email }).select(RESET_FIELDS);
    if (!user || !user.resetCodeHash || !user.resetCodeExpires || user.resetCodeExpires.getTime() <= Date.now()) {
      return res.status(400).json({ message: INVALID_CODE_RESPONSE });
    }
    if ((user.resetAttempts || 0) >= RESET_MAX_ATTEMPTS) {
      return res.status(400).json({ message: INVALID_CODE_RESPONSE });
    }

    const matches = await passwordMatches(code, user.resetCodeHash);
    if (!matches) {
      // Atomic increment so concurrent wrong guesses are all counted.
      await User.updateOne({ _id: user._id }, { $inc: { resetAttempts: 1 } });
      return res.status(400).json({ message: INVALID_CODE_RESPONSE });
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
    if (!updated) return res.status(400).json({ message: INVALID_CODE_RESPONSE });

    return res.json({
      success: true,
      message: "Code verified successfully.",
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

    if (!isValidEmail(email)) return res.status(400).json({ message: "Enter a valid email address." });
    const hasAuth = isResetAuthTokenFormat(rawAuth);
    if (!hasAuth && !isSixDigitCode(code)) {
      return res.status(400).json({ message: INVALID_CODE_RESPONSE });
    }
    const passwordError = passwordValidationError(newPassword);
    if (passwordError) return res.status(400).json({ message: passwordError });
    if (confirmPassword !== undefined && newPassword !== confirmPassword) {
      return res.status(400).json({ message: "Passwords do not match." });
    }

    await connectToDatabase();

    if (hasAuth) {
      // The authorization is bound to the account and consumed atomically,
      // so it cannot be replayed or used for a different email.
      const consumed = await consumeResetAndSetPassword(
        { email, resetAuthHash: hashResetAuthToken(rawAuth), resetAuthExpires: { $gt: new Date() } },
        newPassword
      );
      if (!consumed) return res.status(400).json({ message: INVALID_CODE_RESPONSE });
      return res.json({ success: true, message: "Password updated successfully." });
    }

    const user = await User.findOne({ email }).select(RESET_FIELDS);
    if (
      !user ||
      !user.resetCodeHash ||
      !user.resetCodeExpires ||
      user.resetCodeExpires.getTime() <= Date.now() ||
      (user.resetAttempts || 0) >= RESET_MAX_ATTEMPTS
    ) {
      return res.status(400).json({ message: INVALID_CODE_RESPONSE });
    }

    const matches = await passwordMatches(code, user.resetCodeHash);
    if (!matches) {
      await User.updateOne({ _id: user._id }, { $inc: { resetAttempts: 1 } });
      return res.status(400).json({ message: INVALID_CODE_RESPONSE });
    }

    const consumed = await consumeResetAndSetPassword(
      { _id: user._id, resetCodeHash: user.resetCodeHash, resetCodeExpires: { $gt: new Date() } },
      newPassword
    );
    if (!consumed) return res.status(400).json({ message: INVALID_CODE_RESPONSE });

    return res.json({ success: true, message: "Password updated successfully." });
  } catch (error) {
    return next(error);
  }
});

export default router;

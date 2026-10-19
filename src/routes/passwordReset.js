import { Router } from "express";
import { hashPassword, isValidEmail } from "../auth.js";
import connectToDatabase from "../db.js";
import User from "../user.js";
import { brevoConfigError, sendResetEmail } from "../email.js";
import { forgotPasswordRateLimiter, resetPasswordRateLimiter } from "../middleware.js";
import {
  RESET_TOKEN_TTL_MS,
  generateResetToken,
  hashResetToken,
  isValidResetTokenFormat,
  passwordResetPepper
} from "../resetToken.js";

const router = Router();

const GENERIC_RESPONSE = "If that email exists, we sent a reset link.";
const INVALID_TOKEN_RESPONSE = "This password reset link is invalid or has expired.";

function recoveryConfigError() {
  if (!passwordResetPepper()) return "Password recovery is not configured on the server.";
  return brevoConfigError();
}

// The reset link always targets a fixed frontend path on the configured origin.
function clientOrigin() {
  const raw = (process.env.CLIENT_URL || "").trim();
  try {
    const url = new URL(raw);
    if (url.protocol === "http:" || url.protocol === "https:") return url.origin;
  } catch {
    // fall through to the development default
  }
  return "http://localhost:5173";
}

router.post("/forgot-password", forgotPasswordRateLimiter, async (req, res, next) => {
  try {
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    if (!isValidEmail(email)) return res.status(400).json({ message: "Enter a valid email address." });

    const configError = recoveryConfigError();
    if (configError) return res.status(503).json({ message: configError });

    await connectToDatabase();
    const user = await User.findOne({ email }).select("_id email");
    if (user) {
      const rawToken = generateResetToken();
      user.passwordResetTokenHash = hashResetToken(rawToken);
      user.passwordResetExpiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);
      await user.save();

      const resetLink = `${clientOrigin()}/reset-password?token=${encodeURIComponent(rawToken)}`;
      try {
        await sendResetEmail(user.email, resetLink);
      } catch (error) {
        // Do not leave a usable token behind when the email never went out.
        await User.updateOne(
          { _id: user._id },
          { $set: { passwordResetTokenHash: null, passwordResetExpiresAt: null } }
        );
        console.error("Password reset email delivery failed:", error?.code || "unknown");
      }
    }

    return res.json({ message: GENERIC_RESPONSE });
  } catch (error) {
    return next(error);
  }
});

router.post("/reset-password", resetPasswordRateLimiter, async (req, res, next) => {
  try {
    const token = typeof req.body?.token === "string" ? req.body.token.trim() : "";
    const newPassword = req.body?.newPassword;
    const confirmPassword = req.body?.confirmPassword;

    if (!isValidResetTokenFormat(token)) {
      return res.status(400).json({ message: INVALID_TOKEN_RESPONSE });
    }
    if (typeof newPassword !== "string" || newPassword.length < 8 || newPassword.length > 128) {
      return res.status(400).json({ message: "Password must be between 8 and 128 characters." });
    }
    if (newPassword !== confirmPassword) {
      return res.status(400).json({ message: "Passwords do not match." });
    }

    const configError = recoveryConfigError();
    if (configError) return res.status(503).json({ message: configError });

    const tokenHash = hashResetToken(token);
    // Hash before consuming the token so a hashing failure cannot burn it.
    const passwordHash = await hashPassword(newPassword);

    await connectToDatabase();

    // Atomic single-use consume + password update in one document operation:
    // concurrent requests can never both match, and a failure here leaves the
    // token intact so the user can retry.
    const user = await User.findOneAndUpdate(
      { passwordResetTokenHash: tokenHash, passwordResetExpiresAt: { $gt: new Date() } },
      {
        $set: { passwordHash, passwordChangedAt: new Date() },
        $unset: { passwordResetTokenHash: 1, passwordResetExpiresAt: 1 }
      },
      { returnDocument: "before" }
    );
    if (!user) return res.status(400).json({ message: INVALID_TOKEN_RESPONSE });

    return res.json({ message: "Your password has been reset. You can now sign in with your new password." });
  } catch (error) {
    return next(error);
  }
});

export default router;

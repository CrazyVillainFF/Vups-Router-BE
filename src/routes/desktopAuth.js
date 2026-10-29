import { Router } from "express";
import { createToken } from "../auth.js";
import connectToDatabase from "../db.js";
import DesktopAuthRequest, {
  challengeForVerifier,
  DESKTOP_AUTH_CLIENTS,
  DESKTOP_AUTH_TTL_MS,
  hashToken,
  isToken,
  randomToken,
  safeEqual
} from "../desktopAuth.js";
import User from "../user.js";
import {
  authRateLimiter,
  desktopAuthPollRateLimiter,
  getJwtSecret,
  requireAuth,
  setSessionCookie
} from "../middleware.js";

const router = Router();

function publicUser(user) {
  return { id: String(user._id), name: user.name, email: user.email };
}

function normalizeClient(value) {
  const candidate = typeof value === "string" ? value.trim().toLowerCase() : "";
  return DESKTOP_AUTH_CLIENTS.includes(candidate) ? candidate : "windows";
}

// The desktop app starts a transaction and keeps `verifier` locally. Only the
// SHA-256 challenge travels to the server and the browser, so an intercepted
// ticket cannot be exchanged for a session without the verifier (PKCE).
router.post("/start", desktopAuthPollRateLimiter, async (req, res, next) => {
  try {
    const challenge = req.body?.challenge;
    if (!isToken(challenge)) {
      return res.status(400).json({ message: "The sign-in request was malformed. Start again from the app." });
    }
    await connectToDatabase();
    const ticket = randomToken();
    const expiresAt = new Date(Date.now() + DESKTOP_AUTH_TTL_MS);
    await DesktopAuthRequest.create({
      ticketHash: hashToken(ticket),
      challenge,
      client: normalizeClient(req.body?.client),
      status: "pending",
      expiresAt
    });
    return res.status(201).json({
      ticket,
      expiresIn: Math.floor(DESKTOP_AUTH_TTL_MS / 1000),
      expiresAt: expiresAt.toISOString()
    });
  } catch (error) {
    return next(error);
  }
});

// Called by the website after the user signs in there. The browser session
// proves who is approving; the ticket only says which app asked.
router.post("/approve", authRateLimiter, requireAuth, async (req, res, next) => {
  try {
    const ticket = req.body?.ticket;
    if (!isToken(ticket)) {
      return res.status(400).json({ message: "This sign-in link is incomplete. Start again from the app." });
    }
    await connectToDatabase();
    const request = await DesktopAuthRequest.findOne({ ticketHash: hashToken(ticket) });
    if (!request || request.expiresAt.getTime() <= Date.now()) {
      return res.status(410).json({ message: "This sign-in request expired. Start again from the app." });
    }
    if (request.status === "pending") {
      request.status = "approved";
      request.userId = req.userId;
      await request.save();
    } else if (request.status !== "approved" || String(request.userId) !== String(req.userId)) {
      return res.status(409).json({ message: "This sign-in request was already used. Start again from the app." });
    }
    return res.json({ status: "approved" });
  } catch (error) {
    return next(error);
  }
});

// The app polls with the verifier. A successful poll consumes the approval
// exactly once and installs the normal session cookie on the app's origin.
router.post("/poll", desktopAuthPollRateLimiter, async (req, res, next) => {
  try {
    const ticket = req.body?.ticket;
    const verifier = req.body?.verifier;
    if (!isToken(ticket) || !isToken(verifier)) {
      return res.status(400).json({ status: "invalid", message: "The sign-in request was malformed. Start again from the app." });
    }
    await connectToDatabase();
    const request = await DesktopAuthRequest.findOne({ ticketHash: hashToken(ticket) });
    if (!request || request.expiresAt.getTime() <= Date.now() || request.status === "consumed") {
      return res.status(410).json({ status: "expired", message: "This sign-in request expired. Start again from the app." });
    }
    if (request.status === "pending") {
      return res.status(202).json({ status: "pending" });
    }
    if (!safeEqual(challengeForVerifier(verifier), request.challenge)) {
      return res.status(400).json({ status: "invalid", message: "The sign-in request could not be verified. Start again from the app." });
    }
    const consumed = await DesktopAuthRequest.findOneAndUpdate(
      { _id: request._id, status: "approved" },
      { status: "consumed" },
      { returnDocument: "before" }
    );
    if (!consumed) {
      return res.status(410).json({ status: "expired", message: "This sign-in request was already used. Start again from the app." });
    }
    const user = await User.findById(consumed.userId).select("name email");
    if (!user) {
      return res.status(401).json({ status: "invalid", message: "The approving account no longer exists. Sign in again." });
    }
    const secret = getJwtSecret();
    if (!secret) {
      return res.status(500).json({ status: "invalid", message: "Authentication is not configured on the server." });
    }
    const token = createToken(user, secret);
    setSessionCookie(res, token);
    return res.json({ status: "approved", user: publicUser(user) });
  } catch (error) {
    return next(error);
  }
});

export default router;

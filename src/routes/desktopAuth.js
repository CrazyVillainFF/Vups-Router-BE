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

// One answer for "that ticket does not exist" and "you are not the app that
// asked", so a poll cannot be used to learn which tickets are live.
const UNVERIFIABLE_POLL_MESSAGE = "The sign-in request could not be verified. Start again from the app.";

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
      return res.status(400).json({ status: "invalid", message: "This sign-in link is incomplete. Start again from the app." });
    }
    await connectToDatabase();
    const request = await DesktopAuthRequest.findOne({ ticketHash: hashToken(ticket) });
    if (!request) {
      // Never confirm that a ticket is unknown: the same shape is returned for
      // an unverifiable link so this endpoint cannot be used to probe tickets.
      return res.status(400).json({ status: "invalid", message: "This sign-in link is not recognized. Start again from the app." });
    }
    if (request.status === "consumed") {
      return res.status(409).json({ status: "consumed", message: "This sign-in was already completed in the app. Start again from the app." });
    }
    if (request.expiresAt.getTime() <= Date.now()) {
      return res.status(410).json({ status: "expired", message: "This sign-in request expired. Start again from the app." });
    }
    if (request.status === "pending") {
      request.status = "approved";
      request.userId = req.userId;
      await request.save();
    } else if (request.status !== "approved" || String(request.userId) !== String(req.userId)) {
      return res.status(409).json({ status: "consumed", message: "This sign-in request was already used. Start again from the app." });
    }
    return res.json({ status: "approved" });
  } catch (error) {
    return next(error);
  }
});

// The app polls with the verifier. A successful poll consumes the approval
// exactly once and installs the normal session cookie on the app's origin.
//
// Disclosure is verifier-first: an unknown ticket and a wrong verifier return
// one indistinguishable answer, so no caller who lacks the verifier learns
// anything about the transaction behind a ticket.
router.post("/poll", desktopAuthPollRateLimiter, async (req, res, next) => {
  try {
    const ticket = req.body?.ticket;
    const verifier = req.body?.verifier;
    if (!isToken(ticket) || !isToken(verifier)) {
      return res.status(400).json({ status: "invalid", message: UNVERIFIABLE_POLL_MESSAGE });
    }
    await connectToDatabase();
    const request = await DesktopAuthRequest.findOne({ ticketHash: hashToken(ticket) });
    if (!request || !safeEqual(challengeForVerifier(verifier), request.challenge)) {
      return res.status(400).json({ status: "invalid", message: UNVERIFIABLE_POLL_MESSAGE });
    }
    // A consumed transaction is a completed sign-in, never an expired one, so
    // this branch has to precede the expiry check. It answers idempotently so a
    // duplicate poll cannot be mistaken for failure, and it withholds both a
    // fresh cookie and the account identity because the single issuance already
    // happened.
    if (request.status === "consumed") {
      return res.json({ status: "completed" });
    }
    // A ticket that expired while still pending, or while approved but never
    // redeemed, stays rejected instead of reporting pending forever.
    if (request.expiresAt.getTime() <= Date.now()) {
      return res.status(410).json({ status: "expired", message: "This sign-in request expired. Start again from the app." });
    }
    if (request.status === "pending") {
      return res.status(202).json({ status: "pending" });
    }
    const consumed = await DesktopAuthRequest.findOneAndUpdate(
      { _id: request._id, status: "approved" },
      { status: "consumed" },
      { returnDocument: "before" }
    );
    if (!consumed) {
      return res.json({ status: "completed" });
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

import { Router } from "express";
import { createToken, hashPassword, passwordMatches, validateSignin, validateSignup } from "../auth.js";
import connectToDatabase from "../db.js";
import User from "../user.js";
import {
  authRateLimiter,
  clearSessionCookie,
  getJwtSecret,
  requireAuth,
  setSessionCookie
} from "../middleware.js";

const router = Router();

function publicUser(user) {
  return { id: String(user._id), name: user.name, email: user.email };
}

router.post("/signup", authRateLimiter, async (req, res, next) => {
  try {
    const input = req.body || {};
    const validationError = validateSignup(input);
    if (validationError) return res.status(400).json({ message: validationError });
    await connectToDatabase();
    const email = input.email.trim().toLowerCase();
    const existing = await User.findOne({ email }).select("_id");
    if (existing) return res.status(409).json({ message: "An account with that email already exists." });
    const user = new User({ name: input.name.trim(), email, passwordHash: await hashPassword(input.password) });
    await user.save();
    const secret = getJwtSecret();
    if (!secret) return res.status(500).json({ message: "Authentication is not configured on the server." });
    const token = createToken(user, secret);
    setSessionCookie(res, token);
    return res.status(201).json({ message: "Account created.", token, user: publicUser(user) });
  } catch (error) {
    if (error?.code === 11000) return res.status(409).json({ message: "An account with that email already exists." });
    return next(error);
  }
});

router.post("/signin", authRateLimiter, async (req, res, next) => {
  try {
    const input = req.body || {};
    const validationError = validateSignin(input);
    if (validationError) return res.status(400).json({ message: validationError });
    await connectToDatabase();
    const email = input.email.trim().toLowerCase();
    const user = await User.findOne({ email }).select("+passwordHash");
    if (!user || !(await passwordMatches(input.password, user.passwordHash))) {
      return res.status(401).json({ message: "Email or password is incorrect." });
    }
    const secret = getJwtSecret();
    if (!secret) return res.status(500).json({ message: "Authentication is not configured on the server." });
    const token = createToken(user, secret);
    setSessionCookie(res, token);
    return res.json({ message: "Signed in.", token, user: publicUser(user) });
  } catch (error) {
    return next(error);
  }
});

router.post("/logout", (req, res) => {
  clearSessionCookie(res);
  return res.json({ message: "Signed out." });
});

router.get("/me", requireAuth, (req, res) => {
  return res.json({ user: publicUser(req.user) });
});

export default router;

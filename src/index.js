import "dotenv/config";
import express from "express";
import cors from "cors";
import { randomUUID } from "node:crypto";
import { createToken, hashPassword, passwordMatches, validateSignin, validateSignup } from "./auth.js";

const app = express();
const port = Number(process.env.PORT || 4000);
const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret || jwtSecret.length < 32) {
  console.error("JWT_SECRET must be set to a random secret of at least 32 characters.");
  process.exit(1);
}
app.use(cors({ origin: process.env.CLIENT_ORIGIN || "http://localhost:5173" }));
app.use(express.json({ limit: "20kb" }));

// Demo storage only. Replace with a persistent database before deploying.
const usersByEmail = new Map();

app.get("/api/health", (_req, res) => res.json({ status: "ok", service: "VupsRouter API" }));

app.post("/api/auth/signup", async (req, res, next) => {
  try {
    const input = req.body || {};
    const validationError = validateSignup(input);
    if (validationError) return res.status(400).json({ message: validationError });
    const email = input.email.trim().toLowerCase();
    if (usersByEmail.has(email)) return res.status(409).json({ message: "An account with that email already exists." });
    const user = { id: randomUUID(), name: input.name.trim(), email, passwordHash: await hashPassword(input.password) };
    usersByEmail.set(email, user);
    const token = createToken(user, jwtSecret);
    return res.status(201).json({ message: "Account created.", token, user: { id: user.id, name: user.name, email: user.email } });
  } catch (error) { return next(error); }
});

app.post("/api/auth/signin", async (req, res, next) => {
  try {
    const input = req.body || {};
    const validationError = validateSignin(input);
    if (validationError) return res.status(400).json({ message: validationError });
    const email = input.email.trim().toLowerCase();
    const user = usersByEmail.get(email);
    if (!user || !(await passwordMatches(input.password, user.passwordHash))) {
      return res.status(401).json({ message: "Email or password is incorrect." });
    }
    const token = createToken(user, jwtSecret);
    return res.json({ message: "Signed in.", token, user: { id: user.id, name: user.name, email: user.email } });
  } catch (error) { return next(error); }
});

app.use((error, _req, res, _next) => {
  console.error(error);
  return res.status(500).json({ message: "Something went wrong. Please try again." });
});

app.listen(port, () => console.log(`VupsRouter API listening on http://localhost:${port}`));
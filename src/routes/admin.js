import { Router } from "express";
import connectToDatabase from "../db.js";
import User from "../user.js";
import { requireAdmin, requireAuth, settingsRateLimiter } from "../middleware.js";
import { usageForEmail } from "../usage.js";
import { setSharedModelEnabled, sharedModelStatus } from "../sharedModel.js";

const router = Router();

router.use(requireAuth, requireAdmin, settingsRateLimiter);

router.get("/shared-model", async (req, res, next) => {
  try {
    await connectToDatabase();
    return res.json({ shared: await sharedModelStatus() });
  } catch (error) {
    return next(error);
  }
});

router.post("/shared-model", async (req, res, next) => {
  try {
    const enabled = req.body?.enabled;
    if (typeof enabled !== "boolean") return res.status(400).json({ message: "enabled must be true or false." });
    await connectToDatabase();
    await setSharedModelEnabled(enabled);
    const shared = await sharedModelStatus();
    return res.json({
      message: enabled ? "The shared AI model is enabled." : "The shared AI model is disabled.",
      shared
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/ai-access", async (req, res, next) => {
  try {
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const enabled = req.body?.enabled;
    if (!email) return res.status(400).json({ message: "An account email is required." });
    if (typeof enabled !== "boolean") return res.status(400).json({ message: "enabled must be true or false." });
    await connectToDatabase();
    const user = await User.findOneAndUpdate(
      { email },
      { $set: { aiEnabled: enabled } },
      { returnDocument: "after", projection: "name email aiEnabled aiUsage" }
    );
    if (!user) return res.status(404).json({ message: "No account exists with that email." });
    return res.json({
      message: enabled ? `AI access enabled for ${user.email}.` : `AI access disabled for ${user.email}.`,
      user: { name: user.name, email: user.email, aiEnabled: user.aiEnabled }
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/user", async (req, res, next) => {
  try {
    const email = typeof req.query.email === "string" ? req.query.email.trim().toLowerCase() : "";
    if (!email) return res.status(400).json({ message: "Provide ?email= to look up a user." });
    await connectToDatabase();
    const usage = await usageForEmail(email);
    if (!usage) return res.status(404).json({ message: "No account exists with that email." });
    return res.json({ user: usage });
  } catch (error) {
    return next(error);
  }
});

export default router;

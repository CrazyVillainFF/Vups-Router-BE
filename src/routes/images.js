import { Router } from "express";
import { imageGenerationRateLimiter, requireAuth } from "../middleware.js";
import { UsageError, acquireSlot, consumeDailyQuota, releaseSlot } from "../usage.js";
import { ImageGenerationError, assertImageGenerationConfigured, generateImage, validateImagePrompt } from "../imageGeneration.js";

const router = Router();

router.post("/generate", requireAuth, imageGenerationRateLimiter, async (req, res) => {
  if (req.user?.aiEnabled === false) {
    return res.status(403).json({
      message: "AI features have been disabled for your account by an administrator.",
      code: "ai_disabled"
    });
  }

  const promptCheck = validateImagePrompt(req.body?.prompt);
  if (promptCheck.error) {
    return res.status(400).json({ message: promptCheck.error, code: "image_prompt_invalid" });
  }

  try {
    assertImageGenerationConfigured();
  } catch (error) {
    return res.status(error.status || 503).json({ message: error.message, code: error.code || "image_generation_not_configured" });
  }

  if (!acquireSlot(req.userId)) {
    return res.status(429).json({
      message: "Too many AI requests are already in flight for your account. Wait for them to finish and try again.",
      code: "concurrency_limit"
    });
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    releaseSlot(req.userId);
  };
  res.on("close", release);

  const halted = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) halted.abort();
  });

  try {
    await consumeDailyQuota(req.userId);
  } catch (error) {
    release();
    if (error instanceof UsageError) {
      return res.status(429).json({ message: error.message, code: error.code });
    }
    throw error;
  }

  try {
    const result = await generateImage(promptCheck.prompt, halted.signal);
    // The caller stopped waiting; a late image must not be written to a closed
    // response, and the turn that asked for it is already cancelled.
    if (halted.signal.aborted) return;
    return res.json({
      success: true,
      image: result.image,
      mimeType: result.mimeType,
      model: result.model
    });
  } catch (error) {
    if (halted.signal.aborted) return;
    const status = Number.isInteger(error?.status) ? error.status : 502;
    const code = typeof error?.code === "string" ? error.code : "image_generation_failed";
    if (status >= 500) console.error("Image generation failed:", code);
    return res.status(status).json({
      message: error instanceof ImageGenerationError ? error.message : "Image generation failed. Try again later.",
      code
    });
  } finally {
    release();
  }
});

export default router;

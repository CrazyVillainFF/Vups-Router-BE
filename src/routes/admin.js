import { Router } from "express";
import connectToDatabase from "../db.js";
import User from "../user.js";
import { requireAdmin, requireAuth, settingsRateLimiter } from "../middleware.js";
import { usageForEmail } from "../usage.js";
import { setSharedModelEnabled, sharedModelStatus } from "../sharedModel.js";
import { checkOpenRouter, checkOpenRouterKey, openRouterProviderForChat } from "../openrouter.js";
import { ProviderError, chatCompletion } from "../providerClient.js";

const router = Router();

function openRouterEndpoint() {
  const provider = openRouterProviderForChat();
  return provider ? { provider, chatEndpoint: `${provider.baseUrl}/chat/completions` } : { provider: null, chatEndpoint: null };
}

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

router.get("/openrouter/diagnostics", async (req, res, next) => {
  try {
    const { provider, chatEndpoint } = openRouterEndpoint();
    const [authentication, catalog] = await Promise.all([
      checkOpenRouterKey(),
      checkOpenRouter({ forceRefresh: true })
    ]);
    const authenticated = authentication.authenticated;
    return res.status(authenticated ? 200 : 503).json({
      provider: "openrouter",
      configured: Boolean(provider),
      baseUrl: provider?.baseUrl ?? null,
      chatEndpoint,
      authentication,
      catalog: {
        status: catalog.status,
        available: catalog.available ?? false,
        freeOnly: catalog.freeOnly ?? false,
        defaultModel: catalog.model ?? null,
        fallbackModel: catalog.fallbackModel ?? null,
        total: catalog.models?.length ?? 0,
        free: (catalog.models ?? []).filter(model => model.free === true).length,
        paid: (catalog.models ?? []).filter(model => model.free === false).length
      }
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/openrouter/test-model", async (req, res, next) => {
  try {
    const model = typeof req.body?.model === "string" ? req.body.model.trim() : "";
    if (!model) return res.status(400).json({ message: "Provide the exact OpenRouter model ID to test." });
    if (model.length > 200) return res.status(400).json({ message: "Model IDs must be 200 characters or fewer." });

    const authentication = await checkOpenRouterKey();
    if (!authentication.authenticated) {
      return res.status(503).json({
        ok: false,
        provider: "openrouter",
        model,
        authentication,
        message: "OpenRouter authentication failed. Verify OPENROUTER_API_KEY on the server before testing a model."
      });
    }
    const catalog = await checkOpenRouter({ forceRefresh: true });
    const selected = (catalog.models ?? []).find(candidate => candidate.id === model);
    if (!selected) {
      return res.status(400).json({
        ok: false,
        provider: "openrouter",
        model,
        message: "That exact model ID is not available in the OpenRouter catalog. Refresh the catalog and copy the model ID again."
      });
    }
    if (!selected.available) {
      return res.status(409).json({
        ok: false,
        provider: "openrouter",
        model,
        free: selected.free,
        paid: selected.paid,
        reason: selected.reason,
        message: selected.reason === "not_free"
          ? "This paid model is not explicitly enabled. Add its exact ID to OPENROUTER_MODELS to opt in."
          : "This model is not currently available for chat."
      });
    }
    const { provider, chatEndpoint } = openRouterEndpoint();
    if (!provider) {
      return res.status(503).json({
        ok: false,
        provider: "openrouter",
        model,
        message: "OpenRouter is not configured correctly on the server."
      });
    }
    try {
      const result = await chatCompletion({
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        model,
        messages: [{ role: "user", content: "Reply with OK." }],
        maxTokens: 16,
        reasoning: provider.reasoning
      });
      return res.json({
        ok: true,
        provider: "openrouter",
        model,
        free: selected.free,
        paid: selected.paid,
        chatEndpoint,
        upstreamStatus: 200,
        finishReason: result.finishReason,
        reply: result.content.slice(0, 100)
      });
    } catch (error) {
      if (!(error instanceof ProviderError)) return next(error);
      return res.status(error.status && error.status >= 400 && error.status < 600 ? error.status : 502).json({
        ok: false,
        provider: "openrouter",
        model,
        free: selected.free,
        paid: selected.paid,
        chatEndpoint,
        upstreamStatus: error.status ?? null,
        code: error.code,
        message: error.message
      });
    }
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

import express from "express";
import { rateLimit } from "express-rate-limit";
import { requireAuth } from "../middleware.js";
import { getPlugin } from "../plugins/catalog.js";
import { buildOAuthAuthorizeUrl, verifyOAuthState } from "../plugins/oauth.js";
import { PluginError, pluginErrorPayload } from "../plugins/errors.js";
import {
  executePluginTool,
  getPluginDetail,
  installPlugin,
  listPlugins,
  recentActivity,
  testPlugin,
  toolDefinitionsForUser,
  uninstallPlugin,
  updatePlugin
} from "../plugins/service.js";

const router = express.Router();

const pluginRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.PLUGIN_RATE_LIMIT_MAX || 180),
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many plugin requests. Wait a moment and try again.", code: "plugin_rate_limited" }
});

function fail(res, error) {
  const payload = pluginErrorPayload(error);
  if (payload) return res.status(error.status).json(payload);
  console.error("Plugin route failed:", error?.name || "UnknownError");
  return res.status(500).json({ message: "The plugin request failed. Please try again.", code: "plugin_error" });
}

router.use(requireAuth);
router.use(pluginRateLimiter);

router.get("/", async (req, res, next) => {
  try {
    return res.json(await listPlugins(req.userId));
  } catch (error) {
    if (error instanceof PluginError) return fail(res, error);
    return next(error);
  }
});

router.get("/tools", async (req, res, next) => {
  try {
    const tools = await toolDefinitionsForUser(req.userId);
    return res.json({ tools, count: tools.length });
  } catch (error) {
    if (error instanceof PluginError) return fail(res, error);
    return next(error);
  }
});

router.get("/activity", async (req, res, next) => {
  try {
    const activity = await recentActivity(req.userId, req.query.limit);
    return res.json({ activity });
  } catch (error) {
    if (error instanceof PluginError) return fail(res, error);
    return next(error);
  }
});

router.get("/:pluginId", async (req, res, next) => {
  try {
    return res.json({ plugin: await getPluginDetail(req.userId, req.params.pluginId) });
  } catch (error) {
    if (error instanceof PluginError) return fail(res, error);
    return next(error);
  }
});

router.post("/:pluginId/install", async (req, res, next) => {
  try {
    const result = await installPlugin(req.userId, req.params.pluginId, req.body || {}, {
      requestId: req.requestId
    });
    return res.status(201).json(result);
  } catch (error) {
    if (error instanceof PluginError) return fail(res, error);
    return next(error);
  }
});

router.patch("/:pluginId", async (req, res, next) => {
  try {
    const result = await updatePlugin(req.userId, req.params.pluginId, req.body || {}, {
      requestId: req.requestId
    });
    return res.json(result);
  } catch (error) {
    if (error instanceof PluginError) return fail(res, error);
    return next(error);
  }
});

router.post("/:pluginId/test", async (req, res, next) => {
  try {
    const result = await testPlugin(req.userId, req.params.pluginId, { requestId: req.requestId });
    return res.json(result);
  } catch (error) {
    if (error instanceof PluginError) return fail(res, error);
    return next(error);
  }
});

router.delete("/:pluginId", async (req, res, next) => {
  try {
    return res.json(await uninstallPlugin(req.userId, req.params.pluginId, { requestId: req.requestId }));
  } catch (error) {
    if (error instanceof PluginError) return fail(res, error);
    return next(error);
  }
});

router.post("/:pluginId/tools/:toolName", async (req, res, next) => {
  try {
    const body = req.body || {};
    const result = await executePluginTool(
      req.userId,
      req.params.pluginId,
      req.params.toolName,
      body.args && typeof body.args === "object" ? body.args : {},
      {
        confirm: body.confirm === true,
        source: "ui",
        requestId: req.requestId
      }
    );
    return res.json(result);
  } catch (error) {
    if (error instanceof PluginError) return fail(res, error);
    return next(error);
  }
});

router.get("/:pluginId/oauth/start", async (req, res, next) => {
  try {
    const plugin = getPlugin(req.params.pluginId);
    if (!plugin) throw new PluginError("That plugin does not exist in the catalog.", 404, "plugin_not_found");
    if (plugin.auth.type !== "oauth") {
      throw new PluginError("This plugin does not use OAuth.", 400, "oauth_not_supported");
    }
    const base = process.env.PLUGIN_OAUTH_REDIRECT_BASE
      || `${req.protocol}://${req.get("host")}/api/plugins/${encodeURIComponent(plugin.id)}/oauth/callback`;
    const result = buildOAuthAuthorizeUrl({
      pluginId: plugin.id,
      userId: req.userId,
      redirectUri: base
    });
    return res.json(result);
  } catch (error) {
    if (error instanceof PluginError) return fail(res, error);
    return next(error);
  }
});

router.post("/:pluginId/oauth/callback", async (req, res, next) => {
  try {
    const plugin = getPlugin(req.params.pluginId);
    if (!plugin) throw new PluginError("That plugin does not exist in the catalog.", 404, "plugin_not_found");
    const state = verifyOAuthState(req.body?.state);
    if (String(state.sub) !== String(req.userId) || state.pluginId !== plugin.id) {
      throw new PluginError("The OAuth state does not belong to this account or plugin.", 400, "invalid_oauth_state");
    }
    throw new PluginError(
      "The OAuth callback was verified, but token exchange for this provider has not been implemented yet.",
      501,
      "oauth_exchange_not_implemented"
    );
  } catch (error) {
    if (error instanceof PluginError) return fail(res, error);
    return next(error);
  }
});

export default router;

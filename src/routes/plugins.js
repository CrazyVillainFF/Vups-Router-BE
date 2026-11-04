import express from "express";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import { requireAuth } from "../middleware.js";
import { getPlugin, oauthCallbackPathId, oauthPluginForCallback } from "../plugins/catalog.js";
import { consumeOAuthState, oauthClientAppBase } from "../plugins/oauth.js";
import { PluginError, pluginErrorPayload } from "../plugins/errors.js";
import {
  beginOAuthConnection,
  completeOAuthConnection,
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

// The provider redirects the browser here, so this is a plain cross-site GET with
// no session dependency: the signed, single-use state carried in the query is what
// identifies the account. It is registered before requireAuth on purpose.
const oauthCallbackRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.OAUTH_CALLBACK_RATE_LIMIT_MAX || 40),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKeyGenerator,
  message: { message: "Too many sign-in callbacks. Start the connection again in a moment." }
});

function fail(res, error) {
  const payload = pluginErrorPayload(error);
  if (payload) return res.status(error.status).json(payload);
  console.error("Plugin route failed:", error?.name || "UnknownError");
  return res.status(500).json({ message: "The plugin request failed. Please try again.", code: "plugin_error" });
}

function oauthCallbackUri(pluginId, req) {
  return process.env.PLUGIN_OAUTH_REDIRECT_BASE
    || `${req.protocol}://${req.get("host")}/api/plugins/${encodeURIComponent(oauthCallbackPathId(pluginId))}/oauth/callback`;
}

// The app is told only which connection finished and why it failed. No code,
// state, token, or provider text is put in the browser URL.
function returnToApp(res, pluginId, outcome, reason = "") {
  const target = new URL(`${oauthClientAppBase()}/plugins`);
  target.searchParams.set("plugin", pluginId);
  target.searchParams.set("oauth", outcome);
  if (reason) target.searchParams.set("reason", reason);
  return res.redirect(302, target.toString());
}

const OAUTH_CANCELLED = "access_denied";

function reasonFor(error) {
  if (error?.code === "oauth_state_replayed") return "replayed_state";
  if (error?.code === "invalid_oauth_state") return "invalid_state";
  if (error?.code === "token_exchange_failed") return "exchange_failed";
  if (error?.code === "oauth_not_configured") return "not_configured";
  if (error?.code === "oauth_not_supported") return "unsupported_plugin";
  return "failed";
}

router.get("/:pluginId/oauth/callback", oauthCallbackRateLimiter, async (req, res) => {
  const plugin = oauthPluginForCallback(req.params.pluginId);
  if (!plugin) {
    return returnToApp(res, String(req.params.pluginId).slice(0, 80), "error", "unsupported_plugin");
  }
  try {
    if (req.query.error) {
      return returnToApp(res, plugin.id, "error", String(req.query.error) === OAUTH_CANCELLED ? "cancelled" : "provider_error");
    }
    const state = await consumeOAuthState(req.query.state);
    if (state.pluginId !== plugin.id) {
      throw new PluginError("That sign-in was started for a different service.", 400, "invalid_oauth_state");
    }
    await completeOAuthConnection({
      userId: state.sub,
      pluginId: plugin.id,
      code: String(req.query.code || ""),
      redirectUri: state.redirectUri || oauthCallbackUri(plugin.id, req),
      requestId: req.requestId
    });
    return returnToApp(res, plugin.id, "connected");
  } catch (error) {
    const reason = reasonFor(error);
    if (error instanceof PluginError) console.warn(`Plugin OAuth callback rejected for ${plugin.id}: ${error.code}`);
    else console.error("Plugin OAuth callback failed:", error?.name || "UnknownError");
    return returnToApp(res, plugin.id, "error", reason);
  }
});

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
    const result = await beginOAuthConnection(req.userId, req.params.pluginId, {
      redirectUri: oauthCallbackUri(String(req.params.pluginId), req),
      requestId: req.requestId
    });
    return res.json(result);
  } catch (error) {
    if (error instanceof PluginError) return fail(res, error);
    return next(error);
  }
});

// Apps that open the sign-in in a separate browser never see the redirect land,
// so they poll this instead. It reports only what the account already owns.
router.get("/:pluginId/oauth/status", async (req, res, next) => {
  try {
    const plugin = await getPluginDetail(req.userId, req.params.pluginId);
    return res.json({
      pluginId: plugin.id,
      availability: plugin.availability,
      oauthConfigured: Boolean(plugin.oauth?.configured),
      installed: plugin.installed,
      connection: plugin.connection,
      account: plugin.config?.account || null,
      scopes: plugin.config?.scopes || "",
      lastError: plugin.lastError || plugin.lastTestMessage || ""
    });
  } catch (error) {
    if (error instanceof PluginError) return fail(res, error);
    return next(error);
  }
});

export default router;

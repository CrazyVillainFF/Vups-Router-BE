import jwt from "jsonwebtoken";
import { getJwtSecret } from "../middleware.js";
import { PluginError } from "./errors.js";

const AUDIENCE = "vupsrouter-plugin-oauth";
const ISSUER = "vupsrouter";

function secret() {
  const value = getJwtSecret();
  if (!value) throw new PluginError("OAuth is not configured on the server.", 503, "oauth_not_configured");
  return value;
}

export function createOAuthState({ userId, pluginId, redirectUri = "" }, { expiresIn = "10m" } = {}) {
  if (!userId || !pluginId) throw new PluginError("OAuth state requires a user and plugin.", 400, "invalid_oauth_state");
  return jwt.sign(
    { sub: String(userId), pluginId, redirectUri, kind: "plugin_oauth" },
    secret(),
    { audience: AUDIENCE, issuer: ISSUER, expiresIn }
  );
}

export function verifyOAuthState(state) {
  try {
    const payload = jwt.verify(String(state || ""), secret(), { audience: AUDIENCE, issuer: ISSUER });
    if (payload?.kind !== "plugin_oauth" || !payload.sub || !payload.pluginId) {
      throw new Error("invalid state");
    }
    return payload;
  } catch (error) {
    if (error instanceof PluginError) throw error;
    throw new PluginError("The OAuth state is invalid or has expired. Start the connection again.", 400, "invalid_oauth_state");
  }
}

export function oauthConfiguration(pluginId) {
  const prefix = `PLUGIN_OAUTH_${String(pluginId || "").toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
  const clientId = process.env[`${prefix}_CLIENT_ID`] || "";
  const clientSecret = process.env[`${prefix}_CLIENT_SECRET`] || "";
  const authorizeUrl = process.env[`${prefix}_AUTHORIZE_URL`] || "";
  const tokenUrl = process.env[`${prefix}_TOKEN_URL`] || "";
  const scopes = process.env[`${prefix}_SCOPES`] || "";
  return {
    configured: Boolean(clientId && clientSecret && authorizeUrl && tokenUrl),
    clientId,
    clientSecret,
    authorizeUrl,
    tokenUrl,
    scopes
  };
}

export function buildOAuthAuthorizeUrl({ pluginId, userId, redirectUri }) {
  const config = oauthConfiguration(pluginId);
  if (!config.configured) {
    throw new PluginError(
      "This plugin needs an OAuth app that has not been configured on this server yet.",
      501,
      "oauth_not_configured"
    );
  }
  const state = createOAuthState({ userId, pluginId, redirectUri });
  const url = new URL(config.authorizeUrl);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  if (config.scopes) url.searchParams.set("scope", config.scopes);
  return { url: url.toString(), state };
}

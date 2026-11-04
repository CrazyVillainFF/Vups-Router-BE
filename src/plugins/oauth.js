import { createHash, randomBytes } from "node:crypto";
import jwt from "jsonwebtoken";
import connectToDatabase from "../db.js";
import { getJwtSecret } from "../middleware.js";
import { PluginError } from "./errors.js";
import { requestJson } from "./http.js";
import PluginOAuthState from "./oauthState.js";
import { redactSecrets } from "./redact.js";

const AUDIENCE = "vupsrouter-plugin-oauth";
const ISSUER = "vupsrouter";
const STATE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_CLIENT_APP = "https://vups-router-three.vercel.app";

function secret() {
  const value = getJwtSecret();
  if (!value) throw new PluginError("OAuth is not configured on the server.", 503, "oauth_not_configured");
  return value;
}

// The signed state is high-entropy and already self-authenticating; only its
// digest is stored, so a database read can never hand back a usable state string.
function fingerprint(state) {
  return createHash("sha256").update(String(state)).digest("hex");
}

export function createOAuthState({ userId, pluginId, redirectUri = "" }, { expiresIn = "10m" } = {}) {
  if (!userId || !pluginId) throw new PluginError("OAuth state requires a user and plugin.", 400, "invalid_oauth_state");
  return jwt.sign(
    { sub: String(userId), pluginId, redirectUri, kind: "plugin_oauth", jti: randomBytes(12).toString("hex") },
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

async function database() {
  try {
    await connectToDatabase();
  } catch {
    throw new PluginError("The server could not record this sign-in attempt. Try again in a moment.", 503, "oauth_state_unavailable");
  }
}

export async function issueOAuthState({ userId, pluginId, redirectUri }) {
  const state = createOAuthState({ userId, pluginId, redirectUri });
  await database();
  try {
    await PluginOAuthState.create({
      _id: fingerprint(state),
      userId,
      pluginId,
      expiresAt: new Date(Date.now() + STATE_TTL_MS)
    });
  } catch {
    throw new PluginError("The server could not record this sign-in attempt. Try again in a moment.", 503, "oauth_state_unavailable");
  }
  return state;
}

// Atomic claim: the document is gone the moment it is verified, so a second
// request with the same state — the same browser tab refreshed, or a forwarded
// callback URL — is rejected instead of exchanging the code twice.
export async function consumeOAuthState(state) {
  const payload = verifyOAuthState(state);
  await database();
  const claimed = await PluginOAuthState.findByIdAndDelete(fingerprint(String(state)));
  if (!claimed) {
    throw new PluginError(
      "That sign-in attempt has already been used or has expired. Start the connection again.",
      400,
      "oauth_state_replayed"
    );
  }
  return payload;
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
    scopes,
    variableNames: [
      `${prefix}_CLIENT_ID`,
      `${prefix}_CLIENT_SECRET`,
      `${prefix}_AUTHORIZE_URL`,
      `${prefix}_TOKEN_URL`
    ]
  };
}

export async function buildOAuthAuthorizeUrl({ pluginId, userId, redirectUri }) {
  const config = oauthConfiguration(pluginId);
  if (!config.configured) {
    throw new PluginError(
      "This plugin needs an OAuth app that has not been configured on this server yet.",
      501,
      "oauth_not_configured"
    );
  }
  const state = await issueOAuthState({ userId, pluginId, redirectUri });
  const url = new URL(config.authorizeUrl);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  if (config.scopes) url.searchParams.set("scope", config.scopes);
  return { url: url.toString(), state };
}

export const OAUTH_STATE_TTL_MS = STATE_TTL_MS;

// The provider answers with JSON when the request asks for it. Nothing here is
// logged or returned verbatim: both the code and the client secret are stripped
// from any text the provider echoes back.
export async function exchangeOAuthCode({ pluginId, code, redirectUri, signal }) {
  const config = oauthConfiguration(pluginId);
  if (!config.configured) {
    throw new PluginError(
      "This plugin needs an OAuth app that has not been configured on this server yet.",
      501,
      "oauth_not_configured"
    );
  }
  if (!code || typeof code !== "string") {
    throw new PluginError("The provider did not return an authorization code.", 400, "missing_authorization_code");
  }
  const secrets = [config.clientSecret, code];
  let payload;
  try {
    payload = await requestJson(config.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        redirect_uri: redirectUri,
        grant_type: "authorization_code"
      }),
      timeoutMs: 12000,
      signal
    });
  } catch (error) {
    const status = error instanceof PluginError ? error.status : 502;
    const message = error instanceof PluginError ? error.message : "The provider could not be reached.";
    throw new PluginError(
      `${redactSecrets(message, secrets)} (token exchange failed)`,
      status,
      "token_exchange_failed",
      { cause: error }
    );
  }
  const accessToken = typeof payload?.access_token === "string" ? payload.access_token : "";
  if (!accessToken) {
    const reason = payload?.error_description || payload?.error || "no access token was returned";
    throw new PluginError(
      `The provider rejected the sign-in: ${redactSecrets(String(reason), [...secrets, ...secretValuesOf(payload)])}.`,
      401,
      "token_exchange_failed"
    );
  }
  return {
    accessToken,
    refreshToken: typeof payload.refresh_token === "string" ? payload.refresh_token : "",
    scope: typeof payload.scope === "string" ? payload.scope : ""
  };
}

function secretValuesOf(payload) {
  return ["access_token", "refresh_token", "id_token"]
    .map(key => payload?.[key])
    .filter(value => typeof value === "string" && value.length > 4);
}

// Where the browser is handed back after the callback. The value is a deployment
// setting, never something a provider response can choose.
export function oauthClientAppBase() {
  const configured = process.env.PLUGIN_OAUTH_CLIENT_BASE
    || process.env.CLIENT_ORIGIN
    || process.env.FRONTEND_ORIGIN
    || DEFAULT_CLIENT_APP;
  return String(configured).split(",")[0].trim().replace(/\/+$/, "") || DEFAULT_CLIENT_APP;
}

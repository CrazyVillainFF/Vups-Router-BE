import { decryptSecret, encryptSecret } from "../encryption.js";
import PluginAudit from "./audit.js";
import PluginInstallation from "./installation.js";
import { PLUGIN_CATALOG, catalogSummary, getPlugin } from "./catalog.js";
import { getAdapter, publicTools, findTool } from "./adapters/index.js";
import { PluginError, isPluginError } from "./errors.js";
import { buildOAuthAuthorizeUrl, exchangeOAuthCode, oauthConfiguration } from "./oauth.js";
import { redactSecrets, secretValues } from "./redact.js";
import { splitSecretFields, validateFields, validateInput } from "./validation.js";

const CONNECTION_TIMEOUT_MS = 20000;
const EXECUTION_TIMEOUT_MS = 20000;
const TOOL_PREFIX = "plugin__";

function connectionSignal() {
  return AbortSignal.timeout(CONNECTION_TIMEOUT_MS);
}

function executionSignal(caller = null) {
  const timeout = AbortSignal.timeout(EXECUTION_TIMEOUT_MS);
  if (!caller) return timeout;
  // A caller stop has to reach the plugin request itself, not just be noticed
  // between rounds once the upstream call has already finished.
  return AbortSignal.any([timeout, caller]);
}

// Exported so the redaction path can be tested without a live provider: an
// upstream body that echoes a token must never reach the client or the database.
export function safeErrorMessage(error, secrets = []) {
  const raw = error instanceof PluginError
    ? error.message
    : error?.name === "TimeoutError" || error?.name === "AbortError"
      ? "The plugin service timed out."
      : "The plugin service could not be reached.";
  return redactSecrets(raw, secrets);
}

function credentialMap(installation, credentials) {
  return Object.fromEntries((installation?.credentialKeys || []).map(key => [key, Boolean(credentials?.[key])]));
}

function installationView(installation) {
  if (!installation) return null;
  return {
    installed: true,
    connection: installation.status,
    installedAt: installation.installedAt || installation.createdAt || null,
    lastTestAt: installation.lastTestAt || null,
    lastTestStatus: installation.lastTestStatus || "",
    lastTestMessage: installation.lastTestMessage || "",
    lastError: installation.lastError || "",
    config: installation.config || {},
    credentialsConfigured: Object.fromEntries((installation.credentialKeys || []).map(key => [key, true]))
  };
}

function oauthSummary(plugin, oauthInstallation) {
  if (!plugin.oauthPluginId) return null;
  const companion = getPlugin(plugin.oauthPluginId);
  if (!companion) return null;
  const view = installationView(oauthInstallation);
  const config = oauthConfiguration(companion.id);
  return {
    pluginId: companion.id,
    label: companion.auth.label,
    configured: config.configured,
    installed: Boolean(view),
    connection: view?.connection || "disconnected",
    account: oauthInstallation?.config?.account || null,
    scopes: oauthInstallation?.config?.scopes || "",
    // The scope string is public by design (it travels in the authorization URL),
    // so the app can say what the sign-in will ask for before it asks.
    offeredScopes: config.scopes,
    lastCheckAt: view?.lastTestAt || null,
    lastCheckStatus: view?.lastTestStatus || "",
    lastError: view?.lastError || ""
  };
}

// A sign-in row shares its primary plugin's adapter, so only that row resolves its
// tool list through the adapter code; every other row keeps the catalog-id lookup.
function toolsFor(plugin) {
  return publicTools(plugin.auth.type === "oauth" ? plugin.adapter : plugin.id);
}

function decorate(plugin, installation, oauthInstallation = null) {
  const view = installationView(installation);
  return {
    ...plugin,
    tools: toolsFor(plugin),
    installed: Boolean(view),
    connection: view?.connection || "disconnected",
    installedAt: view?.installedAt || null,
    lastTestAt: view?.lastTestAt || null,
    lastTestStatus: view?.lastTestStatus || "",
    lastTestMessage: view?.lastTestMessage || "",
    lastError: view?.lastError || "",
    config: view?.config || {},
    credentialsConfigured: view?.credentialsConfigured || {},
    oauth: oauthSummary(plugin, oauthInstallation)
  };
}

export async function listPlugins(userId) {
  const installations = await PluginInstallation.find({ userId }).lean();
  const byId = new Map(installations.map(installation => [installation.pluginId, installation]));
  const plugins = PLUGIN_CATALOG.map(plugin => decorate(plugin, byId.get(plugin.id), byId.get(plugin.oauthPluginId)));
  const installed = plugins.filter(plugin => plugin.marketplaceEntry !== false && plugin.installed);
  return {
    plugins,
    summary: {
      ...catalogSummary(),
      installed: installed.length,
      connected: installed.filter(plugin => plugin.connection === "connected").length
    }
  };
}

export async function getPluginDetail(userId, pluginId) {
  const plugin = getPlugin(pluginId);
  if (!plugin) throw new PluginError("That plugin does not exist in the catalog.", 404, "plugin_not_found");
  const installation = await PluginInstallation.findOne({ userId, pluginId: plugin.id }).lean();
  const companion = plugin.oauthPluginId
    ? await PluginInstallation.findOne({ userId, pluginId: plugin.oauthPluginId }).lean()
    : null;
  return decorate(plugin, installation, companion);
}

async function loadInstallation(userId, pluginId, { withCredentials = false } = {}) {
  const query = PluginInstallation.findOne({ userId, pluginId });
  if (withCredentials) query.select("+encryptedCredentials");
  return query.lean();
}

function decryptCredentials(installation) {
  if (!installation?.encryptedCredentials) return {};
  try {
    const parsed = JSON.parse(decryptSecret(installation.encryptedCredentials));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    throw new PluginError(
      "The saved credentials could not be decrypted. Reconnect this plugin.",
      409,
      "credentials_unavailable"
    );
  }
}

async function audit(userId, pluginId, action, status, details = {}) {
  try {
    await PluginAudit.create({
      userId,
      pluginId,
      action,
      status,
      toolName: details.toolName || "",
      errorCode: details.errorCode || "",
      durationMs: details.durationMs ?? null,
      requestId: details.requestId || "",
      metadata: details.metadata || {}
    });
  } catch (error) {
    console.error("Plugin audit write failed:", error?.name || "UnknownError");
  }
}

function normalizeCredentialsInput(fields, input) {
  const { config, credentials } = splitSecretFields(fields, input);
  return { config, credentials };
}

async function connectAndTest(plugin, adapter, config, credentials) {
  try {
    const result = await adapter.testConnection({
      config,
      credentials,
      signal: connectionSignal()
    });
    return redactSecrets(result?.message || `${plugin.name} is connected.`, secretValues(credentials, config));
  } catch (error) {
    throw new PluginError(
      `Could not connect to ${plugin.name}: ${safeErrorMessage(error, secretValues(credentials, config))}`,
      422,
      "connection_failed",
      { cause: error }
    );
  }
}

export async function installPlugin(userId, pluginId, input = {}, { requestId = "" } = {}) {
  const plugin = getPlugin(pluginId);
  if (!plugin) throw new PluginError("That plugin does not exist in the catalog.", 404, "plugin_not_found");
  const adapter = getAdapter(plugin.adapter);
  if (!adapter) {
    throw new PluginError(
      "The adapter for this plugin has not been implemented yet. It is listed in the catalog for transparency only.",
      409,
      "adapter_not_available"
    );
  }
  if (plugin.auth.type === "oauth") {
    if (!oauthConfiguration(plugin.id).configured) {
      console.warn(`Plugin OAuth is not configured for ${plugin.id}; missing ${oauthConfiguration(plugin.id).variableNames.join(", ")}.`);
      throw new PluginError(
        `${plugin.name} needs a sign-in app that has not been configured on this server yet.`,
        501,
        "oauth_not_configured"
      );
    }
    throw new PluginError(
      `${plugin.name} connects through its own sign-in. Use the connect button instead of sending credentials.`,
      400,
      "oauth_connection_required"
    );
  }

  const fields = plugin.auth.fields || [];
  const submitted = normalizeCredentialsInput(fields, input);
  validateFields(fields, input);
  const message = await connectAndTest(plugin, adapter, submitted.config, submitted.credentials);
  const encryptedCredentials = Object.keys(submitted.credentials).length
    ? encryptSecret(JSON.stringify(submitted.credentials))
    : "";
  const now = new Date();
  const installation = await PluginInstallation.findOneAndUpdate(
    { userId, pluginId: plugin.id },
    {
      $set: {
        status: "connected",
        config: submitted.config,
        credentialKeys: Object.keys(submitted.credentials),
        encryptedCredentials,
        connectedAt: now,
        lastTestAt: now,
        lastTestStatus: "connected",
        lastTestMessage: message,
        lastError: ""
      }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
  ).lean();
  await audit(userId, plugin.id, "install", "success", {
    requestId,
    metadata: { authType: plugin.auth.type, toolCount: toolsFor(plugin).length }
  });
  return { plugin: decorate(plugin, installation), message };
}

export async function updatePlugin(userId, pluginId, input = {}, { requestId = "" } = {}) {
  const plugin = getPlugin(pluginId);
  if (!plugin) throw new PluginError("That plugin does not exist in the catalog.", 404, "plugin_not_found");
  const adapter = getAdapter(plugin.adapter);
  if (!adapter) throw new PluginError("This plugin has no implemented adapter.", 409, "adapter_not_available");
  const existing = await loadInstallation(userId, plugin.id, { withCredentials: true });
  if (!existing) throw new PluginError("Install this plugin before changing its settings.", 404, "plugin_not_installed");

  const previousCredentials = decryptCredentials(existing);
  const fields = plugin.auth.fields || [];
  const submitted = normalizeCredentialsInput(fields, input);
  const credentials = { ...previousCredentials, ...submitted.credentials };
  const config = { ...(existing.config || {}), ...submitted.config };
  validateFields(fields, { ...credentials, ...config });
  const message = await connectAndTest(plugin, adapter, config, credentials);
  const encryptedCredentials = Object.keys(credentials).length
    ? encryptSecret(JSON.stringify(credentials))
    : "";
  const now = new Date();
  const installation = await PluginInstallation.findOneAndUpdate(
    { userId, pluginId: plugin.id },
    {
      $set: {
        status: "connected",
        config,
        credentialKeys: Object.keys(credentials),
        encryptedCredentials,
        lastTestAt: now,
        lastTestStatus: "connected",
        lastTestMessage: message,
        lastError: ""
      }
    },
    { new: true, runValidators: true }
  ).lean();
  await audit(userId, plugin.id, "update", "success", { requestId });
  return { plugin: decorate(plugin, installation), message };
}

export async function testPlugin(userId, pluginId, { requestId = "" } = {}) {
  const plugin = getPlugin(pluginId);
  if (!plugin) throw new PluginError("That plugin does not exist in the catalog.", 404, "plugin_not_found");
  const adapter = getAdapter(plugin.adapter);
  if (!adapter) throw new PluginError("This plugin has no implemented adapter.", 409, "adapter_not_available");
  const installation = await loadInstallation(userId, plugin.id, { withCredentials: true });
  if (!installation) throw new PluginError("Install this plugin before testing it.", 404, "plugin_not_installed");
  const credentials = decryptCredentials(installation);
  try {
    const message = await connectAndTest(plugin, adapter, installation.config || {}, credentials);
    const now = new Date();
    const updated = await PluginInstallation.findOneAndUpdate(
      { userId, pluginId: plugin.id },
      {
        $set: {
          status: "connected",
          lastTestAt: now,
          lastTestStatus: "connected",
          lastTestMessage: message,
          lastError: ""
        }
      },
      { new: true, runValidators: true }
    ).lean();
    await audit(userId, plugin.id, "test", "success", { requestId });
    return { plugin: decorate(plugin, updated), message };
  } catch (error) {
    const message = safeErrorMessage(error, secretValues(credentials, installation.config));
    await PluginInstallation.updateOne(
      { userId, pluginId: plugin.id },
      {
        $set: {
          status: "needs_reconnection",
          lastTestAt: new Date(),
          lastTestStatus: "failed",
          lastTestMessage: message,
          lastError: message
        }
      }
    );
    await audit(userId, plugin.id, "test", "error", {
      requestId,
      errorCode: isPluginError(error) ? error.code : "connection_failed"
    });
    throw new PluginError(message, isPluginError(error) ? error.status : 422, isPluginError(error) ? error.code : "connection_failed");
  }
}

export async function uninstallPlugin(userId, pluginId, { requestId = "" } = {}) {
  const plugin = getPlugin(pluginId);
  if (!plugin) throw new PluginError("That plugin does not exist in the catalog.", 404, "plugin_not_found");
  await revokeCredentials(userId, plugin, { requestId });
  const result = await PluginInstallation.deleteOne({ userId, pluginId: plugin.id });
  if (!result.deletedCount) throw new PluginError("This plugin is not installed.", 404, "plugin_not_installed");
  await audit(userId, plugin.id, "uninstall", "success", { requestId });
  return { uninstalled: true, pluginId: plugin.id };
}

// A sign-in token stays valid at the provider after the local record is deleted,
// so disconnecting asks the provider to drop it too. Failure is logged by name
// only and never blocks the deletion: the user's intent is to revoke access.
async function revokeCredentials(userId, plugin, { requestId = "" } = {}) {
  if (plugin.auth.type !== "oauth") return;
  const adapter = getAdapter(plugin.adapter);
  if (!adapter || typeof adapter.revoke !== "function") return;
  if (!oauthConfiguration(plugin.id).configured) return;
  const installation = await loadInstallation(userId, plugin.id, { withCredentials: true });
  if (!installation?.encryptedCredentials) return;
  let credentials;
  try {
    credentials = decryptCredentials(installation);
  } catch {
    return;
  }
  try {
    await adapter.revoke(credentials, {
      config: oauthConfiguration(plugin.id),
      signal: connectionSignal()
    });
  } catch (error) {
    console.error(`Token revocation failed for ${plugin.id}:`, error?.name || "UnknownError");
    await audit(userId, plugin.id, "uninstall", "error", {
      requestId,
      errorCode: "revocation_failed",
      metadata: { via: "oauth" }
    });
  }
}

export async function beginOAuthConnection(userId, pluginId, { redirectUri = "", requestId = "" } = {}) {
  const plugin = getPlugin(pluginId);
  if (!plugin) throw new PluginError("That plugin does not exist in the catalog.", 404, "plugin_not_found");
  if (plugin.auth.type !== "oauth") {
    throw new PluginError("This plugin does not use a sign-in connection.", 400, "oauth_not_supported");
  }
  const adapter = getAdapter(plugin.adapter);
  if (!adapter) throw new PluginError("This plugin has no implemented adapter.", 409, "adapter_not_available");
  if (!oauthConfiguration(plugin.id).configured) {
    console.warn(`Plugin OAuth is not configured for ${plugin.id}; missing ${oauthConfiguration(plugin.id).variableNames.join(", ")}.`);
    throw new PluginError(
      `${plugin.name} needs a sign-in app that has not been configured on this server yet.`,
      501,
      "oauth_not_configured"
    );
  }
  const result = await buildOAuthAuthorizeUrl({ pluginId: plugin.id, userId, redirectUri });
  await audit(userId, plugin.id, "oauth_start", "success", { requestId, metadata: { via: "oauth" } });
  // Only the provider URL travels back to the app. The state stays server-side in
  // the signed token inside that URL and in its single-use record.
  return { url: result.url };
}

export async function completeOAuthConnection({
  userId,
  pluginId,
  code,
  redirectUri,
  requestId = ""
}) {
  const plugin = getPlugin(pluginId);
  if (!plugin) throw new PluginError("That plugin does not exist in the catalog.", 404, "plugin_not_found");
  const adapter = getAdapter(plugin.adapter);
  if (!adapter) throw new PluginError("This plugin has no implemented adapter.", 409, "adapter_not_available");
  const started = Date.now();
  const tokens = await exchangeOAuthCode({
    pluginId: plugin.id,
    code,
    redirectUri,
    signal: connectionSignal()
  });
  const credentials = {
    accessToken: tokens.accessToken,
    ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {})
  };
  const secrets = secretValues(credentials);
  let account = {};
  if (typeof adapter.authenticate === "function") {
    try {
      account = await adapter.authenticate(credentials, { signal: connectionSignal() });
    } catch (error) {
      throw new PluginError(
        `The sign-in succeeded but ${plugin.name} would not say which account it belongs to: ${safeErrorMessage(error, secrets)}`,
        422,
        "account_verification_failed",
        { cause: error }
      );
    }
  }
  const message = redactSecrets(
    account?.login ? `Signed in as ${account.login}.` : `${plugin.name} is connected.`,
    secrets
  );
  const now = new Date();
  const installation = await PluginInstallation.findOneAndUpdate(
    { userId, pluginId: plugin.id },
    {
      $set: {
        status: "connected",
        config: {
          ...(account && Object.keys(account).length ? { account } : {}),
          scopes: tokens.scope,
          connectedVia: "oauth"
        },
        credentialKeys: Object.keys(credentials),
        encryptedCredentials: encryptSecret(JSON.stringify(credentials)),
        connectedAt: now,
        lastTestAt: now,
        lastTestStatus: "connected",
        lastTestMessage: message,
        lastError: ""
      }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
  ).lean();
  await audit(userId, plugin.id, "oauth_callback", "success", {
    requestId,
    durationMs: Date.now() - started,
    metadata: { via: "oauth", scopes: tokens.scope || "", login: account?.login || "" }
  });
  return { plugin: decorate(plugin, installation), message };
}

export async function executePluginTool(userId, pluginId, toolName, args = {}, {
  confirm = false,
  source = "ui",
  requestId = "",
  signal = null
} = {}) {
  const plugin = getPlugin(pluginId);
  if (!plugin) throw new PluginError("That plugin does not exist in the catalog.", 404, "plugin_not_found");
  const adapter = getAdapter(plugin.adapter);
  if (!adapter) throw new PluginError("This plugin has no implemented adapter.", 409, "adapter_not_available");
  const tool = findTool(plugin.adapter, toolName);
  if (!tool) throw new PluginError("That tool is not available for this plugin.", 404, "tool_not_found");
  const installation = await loadInstallation(userId, plugin.id, { withCredentials: true });
  if (!installation) throw new PluginError("Install this plugin before using its tools.", 404, "plugin_not_installed");
  if (installation.status !== "connected") {
    throw new PluginError("Reconnect this plugin before using its tools.", 409, "plugin_not_connected");
  }
  if (tool.sensitive && confirm !== true) {
    await audit(userId, plugin.id, "execute", "denied", {
      toolName,
      requestId,
      errorCode: "approval_required",
      metadata: { source }
    });
    throw new PluginError("This action changes data or sends a message. Confirm it before running the tool.", 403, "approval_required");
  }
  validateInput(tool.inputSchema, args);
  const credentials = decryptCredentials(installation);
  const started = Date.now();
  try {
    const result = await adapter.execute(tool.name, args, {
      config: installation.config || {},
      credentials,
      signal: executionSignal(signal),
      requestId
    });
    await audit(userId, plugin.id, "execute", "success", {
      toolName,
      requestId,
      durationMs: Date.now() - started,
      metadata: { source, resultKeys: Object.keys(result || {}).slice(0, 20) }
    });
    return { tool: tool.name, pluginId: plugin.id, result, durationMs: Date.now() - started };
  } catch (error) {
    const secrets = secretValues(credentials, installation.config);
    const message = safeErrorMessage(error, secrets);
    const status = isPluginError(error) && (error.status === 401 || error.status === 403)
      ? "needs_reconnection"
      : installation.status;
    if (status !== installation.status) {
      await PluginInstallation.updateOne(
        { userId, pluginId: plugin.id },
        { $set: { status, lastError: message } }
      );
    }
    await audit(userId, plugin.id, "execute", "error", {
      toolName,
      requestId,
      durationMs: Date.now() - started,
      errorCode: isPluginError(error) ? error.code : "tool_failed",
      metadata: { source }
    });
    if (error instanceof PluginError) {
      throw new PluginError(message, error.status, error.code);
    }
    throw new PluginError(message, 502, "tool_failed", { cause: error });
  }
}

export function toolNameFor(pluginId, toolName) {
  return `${TOOL_PREFIX}${pluginId}__${toolName}`;
}

export function parseToolName(name) {
  const value = String(name || "");
  if (!value.startsWith(TOOL_PREFIX)) return null;
  const rest = value.slice(TOOL_PREFIX.length);
  const separator = rest.indexOf("__");
  if (separator <= 0 || separator >= rest.length - 2) return null;
  return { pluginId: rest.slice(0, separator), toolName: rest.slice(separator + 2) };
}

export async function toolDefinitionsForUser(userId) {
  const installations = await PluginInstallation.find({ userId, status: "connected" }).lean();
  const definitions = [];
  for (const installation of installations) {
    const plugin = getPlugin(installation.pluginId);
    if (!plugin) continue;
    for (const tool of toolsFor(plugin)) {
      if (tool.sensitive) continue;
      definitions.push({
        type: "function",
        function: {
          name: toolNameFor(plugin.id, tool.name),
          description: `${plugin.name}: ${tool.description}`,
          parameters: tool.inputSchema
        }
      });
    }
  }
  return definitions;
}

export async function executeToolByName(userId, name, args, options = {}) {
  const parsed = parseToolName(name);
  if (!parsed) throw new PluginError("The assistant requested an unknown tool.", 400, "tool_not_found");
  return executePluginTool(userId, parsed.pluginId, parsed.toolName, args, {
    ...options,
    source: options.source || "ai"
  });
}

export async function recentActivity(userId, limit = 20) {
  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 50);
  const rows = await PluginAudit.find({ userId })
    .sort({ createdAt: -1 })
    .limit(safeLimit)
    .select("pluginId action toolName status errorCode durationMs createdAt metadata")
    .lean();
  return rows.map(row => ({
    pluginId: row.pluginId,
    action: row.action,
    toolName: row.toolName,
    status: row.status,
    errorCode: row.errorCode,
    durationMs: row.durationMs,
    createdAt: row.createdAt,
    source: row.metadata?.source || ""
  }));
}

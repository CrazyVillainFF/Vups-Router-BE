export class PluginError extends Error {
  constructor(message, status = 400, code = "plugin_error", options = {}) {
    super(message);
    this.name = "PluginError";
    this.status = status;
    this.code = code;
    this.retryAfter = options.retryAfter ?? null;
    this.expose = options.expose ?? true;
    this.cause = options.cause;
  }
}

export function pluginErrorPayload(error) {
  if (!(error instanceof PluginError)) return null;
  return {
    message: error.expose ? error.message : "The plugin request failed.",
    code: error.code,
    ...(error.retryAfter ? { retryAfter: error.retryAfter } : {})
  };
}

export function isPluginError(error) {
  return error instanceof PluginError;
}

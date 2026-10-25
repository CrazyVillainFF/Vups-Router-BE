import mongoose from "mongoose";

const cache = globalThis.__vupsRouterMongoose ??= { connection: null, promise: null };

function hasReadyConnection() {
  return Boolean(cache.connection) && mongoose.connection.readyState === 1;
}

export function describeDatabaseError(error) {
  const parts = [error?.name || "", error?.message || ""];
  const reason = error?.reason;
  if (reason?.type) parts.push(String(reason.type));
  if (reason?.servers?.values) {
    for (const server of reason.servers.values()) {
      if (server?.error?.message) parts.push(server.error.message);
    }
  }
  const raw = parts.join(" ");

  if (/database is not configured/i.test(raw)) {
    return {
      reason: "not_configured",
      hint: "Set MONGODB_URI in server/.env to your MongoDB connection string, then restart the backend."
    };
  }
  if (/authentication failed|bad auth|auth failed/i.test(raw)) {
    return {
      reason: "auth_failed",
      hint: "The database rejected the configured user. Verify the username and login in MONGODB_URI, and that the user can access the target database."
    };
  }
  if (/MongoParseError|Invalid scheme|URI must|percent-encoding|malformed/i.test(raw)) {
    return {
      reason: "invalid_uri",
      hint: "MONGODB_URI is malformed. Percent-encode special characters in the username or password (@ → %40, : → %3A, / → %2F, # → %23, ? → %3F, % → %25, space → %20)."
    };
  }
  if (/ENOTFOUND|EAI_AGAIN|querySrv|getaddrinfo/i.test(raw)) {
    return {
      reason: "dns_error",
      hint: "The database hostname could not be resolved. Verify the host in MONGODB_URI."
    };
  }
  if (/ETIMEDOUT|timed out|timeout|ServerSelectionError/i.test(raw)) {
    return {
      reason: "timeout",
      hint: "The database could not be reached before the timeout. In Atlas, allow the backend's outbound traffic under Network Access (Render's free tier needs 0.0.0.0/0) and make sure the cluster is running."
    };
  }
  if (/ECONNREFUSED|ECONNRESET|not allowed|allowlist|SSL|TLS/i.test(raw)) {
    return {
      reason: "unreachable",
      hint: "The database refused the connection. If using Atlas, check Network Access (IP allowlist) and that the database is running."
    };
  }
  return {
    reason: "unavailable",
    hint: "The database connection failed. Check the backend logs for details."
  };
}

export function safeDatabaseErrorText(error) {
  const parts = [error?.name || "", error?.message || ""];
  const servers = error?.reason?.servers;
  if (servers?.values) {
    for (const server of servers.values()) {
      if (server?.error?.message) parts.push(server.error.message);
    }
  }
  return parts
    .join(" ")
    .replace(/mongodb(?:\+srv)?:\/\/[^\s"']+/gi, "mongodb://[redacted]")
    .replace(/(password|passwd|pwd)=[^&\s"']+/gi, "$1=[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
}

const MONGO_CONNECTION_ERROR_NAMES = new Set([
  "MongooseServerSelectionError",
  "MongoServerSelectionError",
  "MongoNetworkError",
  "MongoNetworkTimeoutError",
  "MongoTopologyClosedError",
  "MongoParseError",
  "MongoNotConnectedError",
  "MongoSystemError"
]);

export function isDatabaseFailure(error) {
  if (!error) return false;
  const name = String(error.name || "");
  const message = String(error.message || "");
  if (/^database is not configured\.?$/i.test(message.trim())) return true;
  if (MONGO_CONNECTION_ERROR_NAMES.has(name)) return true;
  if (name === "MongoServerError") {
    return /not primary|primary stepped down|shutdown in progress|connection|network|topology|socket|timed out|timeout|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND/i.test(message);
  }
  if (name === "MongooseError") {
    return /buffering timed out|failed to connect|server selection|topology|not connected|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND/i.test(message);
  }
  return false;
}

export default async function connectToDatabase() {
  if (hasReadyConnection()) return cache.connection;
  cache.connection = null;
  if (!process.env.MONGODB_URI) throw new Error("Database is not configured.");

  if (!cache.promise) {
    const pending = mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 10000
    }).then(connection => {
      cache.connection = connection;
      cache.promise = null;
      return connection;
    }).catch(error => {
      cache.promise = null;
      cache.connection = null;
      throw error;
    });
    cache.promise = pending;
  }

  return cache.promise;
}

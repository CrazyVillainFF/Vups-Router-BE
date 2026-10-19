import mongoose from "mongoose";

const cache = globalThis.__vupsRouterMongoose ??= { connection: null, promise: null };

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

export default async function connectToDatabase() {
  if (cache.connection) return cache.connection;
  if (!process.env.MONGODB_URI) throw new Error("Database is not configured.");

  if (!cache.promise) {
    cache.promise = mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 10000
    }).then(connection => connection).catch(error => {
      cache.promise = null;
      throw error;
    });
  }

  cache.connection = await cache.promise;
  return cache.connection;
}
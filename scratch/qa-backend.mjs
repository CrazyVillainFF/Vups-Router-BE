// QA-only: boots the real backend against an ephemeral in-memory MongoDB so the
// desktop sign-in handoff can be exercised end-to-end without touching the
// production database. Nothing here is shipped.
//   node scratch/qa-backend.mjs [port]
process.env.NODE_ENV = process.env.NODE_ENV || "development";
process.env.JWT_SECRET ||= "qa-jwt-secret-with-at-least-32-characters-long";
process.env.ENCRYPTION_SECRET ||= "qa-encryption-secret-with-32-characters";
process.env.RATE_LIMIT_MAX = "10000";
process.env.DESKTOP_AUTH_RATE_LIMIT_MAX = "10000";
delete process.env.MONGODB_URI;

const { MongoMemoryServer } = await import("mongodb-memory-server");
const mongod = await MongoMemoryServer.create();
process.env.MONGODB_URI = mongod.getUri("vupsrouter_qa");

const { default: mongoose } = await import("mongoose");
await connectToDatabaseSafe();
const { default: app } = await import("../src/index.js");

async function connectToDatabaseSafe() {
  const { default: connectToDatabase } = await import("../src/db.js");
  await connectToDatabase();
}

const port = Number(process.argv[2] || 4000);
app.listen(port, "127.0.0.1", () => {
  console.log(`QA backend listening on http://127.0.0.1:${port}`);
});

async function shutdown() {
  await mongoose.disconnect().catch(() => {});
  await mongod.stop().catch(() => {});
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

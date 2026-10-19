import User from "./user.js";

export class UsageError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "UsageError";
    this.code = code;
  }
}

export function dailyQuota() {
  const value = Number(process.env.AI_DAILY_QUOTA);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 100;
}

export function maxConcurrency() {
  const value = Number(process.env.AI_MAX_CONCURRENCY);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 3;
}

const activeRequests = new Map();

export function acquireSlot(userId) {
  const key = String(userId);
  const current = activeRequests.get(key) ?? 0;
  if (current >= maxConcurrency()) return false;
  activeRequests.set(key, current + 1);
  return true;
}

export function releaseSlot(userId) {
  const key = String(userId);
  const current = activeRequests.get(key) ?? 0;
  if (current <= 1) activeRequests.delete(key);
  else activeRequests.set(key, current - 1);
}

export function activeSlotCount(userId) {
  return activeRequests.get(String(userId)) ?? 0;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

export async function consumeDailyQuota(userId) {
  const day = today();
  await User.updateOne(
    { _id: userId, "aiUsage.day": { $ne: day } },
    { $set: { "aiUsage.day": day, "aiUsage.count": 0 } }
  );
  const user = await User.findOneAndUpdate(
    { _id: userId },
    { $inc: { "aiUsage.count": 1 } },
    { returnDocument: "after", projection: "aiUsage" }
  );
  const quota = dailyQuota();
  const used = user?.aiUsage?.count ?? 0;
  if (used > quota) {
    await User.updateOne({ _id: userId }, { $inc: { "aiUsage.count": -1 } });
    throw new UsageError(
      `Daily AI request limit reached (${quota} per day). The limit resets at midnight UTC.`,
      "quota_exceeded"
    );
  }
  return { used, quota };
}

export async function usageForEmail(email) {
  const user = await User.findOne({ email: String(email).trim().toLowerCase() }).select("name email aiEnabled aiUsage");
  if (!user) return null;
  const day = today();
  return {
    name: user.name,
    email: user.email,
    aiEnabled: user.aiEnabled !== false,
    dailyUsed: user.aiUsage?.day === day ? user.aiUsage?.count ?? 0 : 0,
    dailyQuota: dailyQuota()
  };
}

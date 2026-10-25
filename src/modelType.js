import User from "./user.js";

export const MODEL_TYPES = new Set(["custom", "free"]);

export function normalizeModelType(value) {
  const type = typeof value === "string" ? value.trim().toLowerCase() : "";
  return MODEL_TYPES.has(type) ? type : null;
}

// A user who has not made an explicit choice keeps the current onboarding
// behaviour: free models when no provider is saved, custom models once a
// provider exists. This grandfathers existing custom setups instead of
// silently switching them to the free catalogue after deployment.
export async function modelTypeForUser(userId, configCount) {
  let user = null;
  try {
    user = await User.findById(userId).select("modelType");
  } catch {
    user = null;
  }
  const explicit = normalizeModelType(user?.modelType);
  if (explicit) return { modelType: explicit, explicit: true };
  return { modelType: configCount > 0 ? "custom" : "free", explicit: false };
}

// Preserve the free default for a brand-new installation when it saves its
// first provider. Users who already had a provider, or who already chose a
// mode, are not touched.
export async function preserveFirstProviderModelType(userId, configCount) {
  if (configCount > 0) return;
  try {
    await User.updateOne(
      { _id: userId, $or: [{ modelType: null }, { modelType: { $exists: false } }] },
      { $set: { modelType: "free" } }
    );
  } catch {
    // Preference persistence is best-effort; the derived default still applies.
  }
}

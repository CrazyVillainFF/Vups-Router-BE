import mongoose from "mongoose";

export const COMBO_SETTINGS_DEFAULTS = {
  maxWorkingModels: 4,
  autoAvailability: true,
  healthTtlMs: 120000,
  timeoutMs: 60000,
  retries: 0,
  maxConcurrent: 3,
  probeTimeoutMs: 20000
};

const SETTINGS_LIMITS = {
  maxWorkingModels: { min: 1, max: 8 },
  healthTtlMs: { min: 15000, max: 1800000 },
  timeoutMs: { min: 5000, max: 300000 },
  retries: { min: 0, max: 2 },
  maxConcurrent: { min: 1, max: 8 },
  probeTimeoutMs: { min: 5000, max: 60000 }
};

export const COMBO_MAX_SELECTED_MODELS = 32;
const MODEL_KINDS = ["saved", "shared", "vups"];
const AVAILABILITY_STATUSES = ["working", "not_working", "unknown"];

function text(value, max = 200) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function clampInteger(value, fallback, { min, max }) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

export function comboModelKey(descriptor) {
  const kind = MODEL_KINDS.includes(descriptor?.kind) ? descriptor.kind : "saved";
  if (kind === "saved") return `saved:${text(descriptor?.configId, 80)}:${text(descriptor?.model, 200)}`;
  if (kind === "shared") return `shared:${text(descriptor?.model, 200)}`;
  return `vups:${text(descriptor?.model, 200)}`;
}

export function sanitizeSelectedModel(input) {
  if (!input || typeof input !== "object") return null;
  const kind = MODEL_KINDS.includes(input.kind) ? input.kind : "saved";
  const model = text(input.model, 200);
  if (!model) return null;
  const configId = kind === "saved" ? text(input.configId, 80) : "";
  if (kind === "saved" && !configId) return null;
  return {
    key: comboModelKey({ kind, configId, model }),
    kind,
    configId,
    providerId: kind === "saved" ? text(input.providerId, 60) : "",
    provider: text(input.provider, 80) || (kind === "shared" ? "Shared" : kind === "vups" ? "Vups" : "Provider"),
    providerType: text(input.providerType, 40),
    model,
    label: text(input.label, 120) || model
  };
}

export function normalizeSelectedModels(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const result = [];
  for (const entry of input) {
    const descriptor = sanitizeSelectedModel(entry);
    if (!descriptor || seen.has(descriptor.key)) continue;
    seen.add(descriptor.key);
    result.push(descriptor);
    if (result.length >= COMBO_MAX_SELECTED_MODELS) break;
  }
  return result;
}

export function normalizeComboSettings(input) {
  const source = input && typeof input === "object" ? input : {};
  const settings = { ...COMBO_SETTINGS_DEFAULTS };
  if (typeof source.autoAvailability === "boolean") settings.autoAvailability = source.autoAvailability;
  for (const [name, limits] of Object.entries(SETTINGS_LIMITS)) {
    settings[name] = clampInteger(source[name], COMBO_SETTINGS_DEFAULTS[name], limits);
  }
  return settings;
}

export function normalizeAvailability(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const result = [];
  for (const entry of input) {
    const key = text(entry?.key, 300);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push({
      key,
      status: AVAILABILITY_STATUSES.includes(entry.status) ? entry.status : "unknown",
      checkedAt: Number.isFinite(Date.parse(entry.checkedAt)) ? new Date(entry.checkedAt) : null,
      reason: text(entry.reason, 60),
      retryable: typeof entry.retryable === "boolean" ? entry.retryable : null,
      providerUpdatedAt: text(entry.providerUpdatedAt, 40)
    });
    if (result.length >= COMBO_MAX_SELECTED_MODELS * 2) break;
  }
  return result;
}

const selectedModelSchema = new mongoose.Schema({
  key: { type: String, required: true, maxlength: 300 },
  kind: { type: String, enum: MODEL_KINDS, default: "saved" },
  configId: { type: String, default: "", maxlength: 80 },
  providerId: { type: String, default: "", maxlength: 60 },
  provider: { type: String, default: "", maxlength: 80 },
  providerType: { type: String, default: "", maxlength: 40 },
  model: { type: String, required: true, maxlength: 200 },
  label: { type: String, default: "", maxlength: 120 }
}, { _id: false });

const comboSettingsSchema = new mongoose.Schema({
  maxWorkingModels: { type: Number, default: COMBO_SETTINGS_DEFAULTS.maxWorkingModels, min: 1, max: 8 },
  autoAvailability: { type: Boolean, default: COMBO_SETTINGS_DEFAULTS.autoAvailability },
  healthTtlMs: { type: Number, default: COMBO_SETTINGS_DEFAULTS.healthTtlMs, min: 15000, max: 1800000 },
  timeoutMs: { type: Number, default: COMBO_SETTINGS_DEFAULTS.timeoutMs, min: 5000, max: 300000 },
  retries: { type: Number, default: COMBO_SETTINGS_DEFAULTS.retries, min: 0, max: 2 },
  maxConcurrent: { type: Number, default: COMBO_SETTINGS_DEFAULTS.maxConcurrent, min: 1, max: 8 },
  probeTimeoutMs: { type: Number, default: COMBO_SETTINGS_DEFAULTS.probeTimeoutMs, min: 5000, max: 60000 }
}, { _id: false });

const availabilitySchema = new mongoose.Schema({
  key: { type: String, required: true, maxlength: 300 },
  status: { type: String, enum: AVAILABILITY_STATUSES, default: "unknown" },
  checkedAt: { type: Date, default: null },
  reason: { type: String, default: "", maxlength: 60 },
  retryable: { type: Boolean, default: null },
  providerUpdatedAt: { type: String, default: "", maxlength: 40 }
}, { _id: false });

const comboConfigSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true, index: true },
  enabled: { type: Boolean, default: true },
  selected: { type: [selectedModelSchema], default: [] },
  settings: { type: comboSettingsSchema, default: () => ({}) },
  availability: { type: [availabilitySchema], default: [] }
}, { timestamps: true, versionKey: false });

const ComboConfig = mongoose.models.ComboConfig || mongoose.model("ComboConfig", comboConfigSchema);

export function defaultComboConfig(userId) {
  return {
    userId,
    enabled: true,
    selected: [],
    settings: normalizeComboSettings({}),
    availability: [],
    isNew: true
  };
}

export async function comboConfigForUser(userId) {
  const stored = await ComboConfig.findOne({ userId });
  if (!stored) return defaultComboConfig(userId);
  return stored;
}

export function publicComboConfig(config) {
  const settings = normalizeComboSettings(config?.settings);
  return {
    enabled: config?.enabled !== false,
    selected: normalizeSelectedModels(config?.selected),
    settings,
    availability: normalizeAvailability(config?.availability).map(entry => ({
      key: entry.key,
      status: entry.status,
      checkedAt: entry.checkedAt ? entry.checkedAt.toISOString() : null
    })),
    updatedAt: config?.updatedAt ?? null
  };
}

export default ComboConfig;

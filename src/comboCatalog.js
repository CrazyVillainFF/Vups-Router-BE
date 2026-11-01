import ProviderConfig from "./providerConfig.js";
import { sharedModelStatus } from "./sharedModel.js";
import { VUPS_MODEL_ID, VUPS_MODEL_NAME, vupsProviderForChat } from "./vupsGalax.js";
import { comboModelKey } from "./comboConfig.js";

function savedModelRows(config) {
  const rows = [];
  const seen = new Set();
  const candidates = [
    config.defaultModel,
    config.model,
    ...(Array.isArray(config.models) ? config.models : []),
    ...(Array.isArray(config.freeModels) ? config.freeModels : [])
  ];
  for (const candidate of candidates) {
    const model = typeof candidate === "string" ? candidate.trim() : "";
    if (!model || seen.has(model)) continue;
    seen.add(model);
    rows.push({
      key: comboModelKey({ kind: "saved", configId: config.configId, model }),
      kind: "saved",
      configId: config.configId,
      providerId: config.providerId,
      provider: config.provider,
      providerType: config.providerType || "openai_compatible",
      model,
      label: model,
      group: config.provider,
      vision: false,
      available: true
    });
  }
  return rows;
}

function vupsRow() {
  try {
    const provider = vupsProviderForChat();
    if (!provider?.baseUrl || !provider?.apiKey) return null;
  } catch {
    return null;
  }
  return {
    key: comboModelKey({ kind: "vups", model: VUPS_MODEL_ID }),
    kind: "vups",
    configId: "",
    providerId: "",
    provider: "Vups",
    providerType: "openai_compatible",
    model: VUPS_MODEL_ID,
    label: VUPS_MODEL_NAME,
    group: "Vups",
    vision: false,
    available: true
  };
}

export async function comboCatalogForUser(userId) {
  const [configs, shared, vups] = await Promise.all([
    ProviderConfig.find({ userId }).sort({ active: -1, updatedAt: -1 }).lean(),
    sharedModelStatus().catch(() => null),
    Promise.resolve(vupsRow())
  ]);

  const models = [];
  const seen = new Set();
  for (const config of configs) {
    if (config.enabled === false) continue;
    for (const row of savedModelRows(config)) {
      if (seen.has(row.key)) continue;
      seen.add(row.key);
      models.push(row);
    }
  }

  const sharedModels = Array.isArray(shared?.models) ? shared.models : [];
  for (const entry of sharedModels) {
    const model = typeof entry?.id === "string" ? entry.id.trim() : "";
    if (!model) continue;
    const key = comboModelKey({ kind: "shared", model });
    if (seen.has(key)) continue;
    seen.add(key);
    models.push({
      key,
      kind: "shared",
      configId: "",
      providerId: "",
      provider: shared?.provider === "ollama" ? "Ollama" : "OpenRouter",
      providerType: "openai_compatible",
      model,
      label: typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : model,
      group: "Shared · Free",
      vision: entry.vision === true,
      available: entry.available !== false,
      sharedStatus: shared?.status ?? "unknown"
    });
  }

  if (vups && !seen.has(vups.key)) models.push(vups);

  return {
    models,
    sharedStatus: shared
      ? { provider: shared.provider, status: shared.status, available: shared.available === true }
      : { provider: "unavailable", status: "unavailable", available: false },
    generatedAt: new Date().toISOString()
  };
}

export function descriptorFromCatalog(catalog, key) {
  if (!key) return null;
  return catalog.models.find(model => model.key === key) || null;
}

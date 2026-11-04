import ProviderConfig from "./providerConfig.js";
import ComboConfig, { normalizeAvailability } from "./comboConfig.js";
import { chatCompletion, ProviderError } from "./providerClient.js";
import { resolveProvider } from "./routes/chat.js";
import { vupsProviderForChat } from "./vupsGalax.js";
import { redactSecrets } from "./plugins/redact.js";

const PERMANENT_CODES = new Set([
  "invalid_credentials",
  "invalid_api_key",
  "missing_api_key",
  "key_decryption_failed",
  "forbidden",
  "quota_exhausted",
  "invalid_model",
  "model_unavailable",
  "provider_disabled",
  "config_not_found",
  "invalid_base_url",
  "invalid_source",
  "vups_not_configured",
  "vups_vision_unsupported",
  "shared_disabled",
  "shared_model_unavailable",
  "unsupported_qoder_mode"
]);

const TRANSIENT_CODES = new Set([
  "timeout",
  "stream_error",
  "network_error",
  "rate_limit_requests",
  "rate_limit_tokens",
  "ambiguous_rate_limit",
  "concurrency_limit",
  "overloaded",
  "upstream_unavailable",
  "empty_response"
]);

const PROBE_PROMPT = "Reply with the single word OK.";

export class ComboCancelledError extends Error {
  constructor() {
    super("Combo run cancelled.");
    this.name = "ComboCancelledError";
    this.code = "cancelled";
    this.status = 499;
  }
}

export function isTransientAvailabilityError(error) {
  // providerClient attaches its own retry verdict to the error it throws, and it
  // spells the rate-limit codes as categories rather than codes, so a rate limited
  // model used to fall through and be cached as if it were permanently broken. The
  // code sets stay as the fallback for errors that carry no verdict at all.
  if (error?.retryable === true || error?.classification?.retryable === true) return true;
  const code = String(error?.code || "");
  if (PERMANENT_CODES.has(code)) return false;
  return TRANSIENT_CODES.has(code);
}

export function availabilityReason(error) {
  if (error?.classification?.retryable === true) return "transient_failure";
  const code = String(error?.code || error?.name || "provider_error").trim().slice(0, 60);
  return code || "provider_error";
}

function cancelled(signal) {
  return signal?.aborted === true;
}

const MAX_PROBE_DETAIL_CHARS = 240;

// The HTTP status the provider actually answered with, when the failure carried
// one. A transport error has no status, and inventing 500 would misreport it.
function probeHttpStatus(error) {
  const status = Number(error?.status);
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
}

// The sentence a single-model test shows the user. Provider messages are already
// sanitised by describeProviderError, but a probe knows the exact credential it
// was carrying, so it redacts that too before anything leaves the module.
function probeDetail(error, secrets = []) {
  const message = typeof error?.message === "string" ? error.message.trim() : "";
  if (!message) return "";
  return redactSecrets(message.slice(0, MAX_PROBE_DETAIL_CHARS), secrets);
}

function probeFailure(error, startedAt, secrets = []) {
  return {
    status: "not_working",
    reason: availabilityReason(error),
    retryable: isTransientAvailabilityError(error),
    latencyMs: Date.now() - startedAt,
    httpStatus: probeHttpStatus(error),
    detail: probeDetail(error, secrets)
  };
}

export async function resolveComboProvider(userId, descriptor) {
  if (descriptor.kind === "vups") {
    const provider = vupsProviderForChat();
    return {
      ...provider,
      provider: "Vups",
      providerType: provider.providerType || "openai_compatible",
      authMode: "pat",
      openapiBaseUrl: "",
      probeModel: provider.model
    };
  }
  const provider = await resolveProvider(
    userId,
    descriptor.model,
    descriptor.kind === "saved" ? descriptor.configId : "",
    "",
    descriptor.kind === "saved" ? descriptor.providerId : ""
  );
  return { ...provider, probeModel: descriptor.model };
}

export async function probeDescriptor(userId, descriptor, { signal, timeoutMs = 20000 } = {}) {
  const startedAt = Date.now();
  if (!descriptor || !descriptor.model) {
    return {
      status: "not_working",
      reason: "invalid_model",
      retryable: false,
      latencyMs: 0,
      httpStatus: null,
      detail: ""
    };
  }
  let provider;
  try {
    provider = await resolveComboProvider(userId, descriptor);
    if (provider?.shared === true && provider?.available === false) {
      throw new ProviderError("The shared model pool is not available.", 503, "shared_model_unavailable");
    }
  } catch (error) {
    if (cancelled(signal)) throw new ComboCancelledError();
    return probeFailure(error, startedAt);
  }

  const timeout = AbortSignal.timeout(Math.max(5000, Math.min(60000, Number(timeoutMs) || 20000)));
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    await chatCompletion(
      {
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        providerType: provider.providerType,
        authMode: provider.authMode,
        openapiBaseUrl: provider.openapiBaseUrl,
        model: provider.probeModel || descriptor.model,
        messages: [{ role: "user", content: PROBE_PROMPT }],
        maxTokens: 64
      },
      combined
    );
    // chatCompletion throws on an empty or unusable body, so reaching this line
    // means the model itself returned an answer rather than the endpoint accepting
    // the request.
    return {
      status: "working",
      reason: "",
      retryable: false,
      latencyMs: Date.now() - startedAt,
      httpStatus: null,
      detail: ""
    };
  } catch (error) {
    if (cancelled(signal)) throw new ComboCancelledError();
    return probeFailure(error, startedAt, [provider.apiKey]);
  }
}

function freshnessTtlMs(entry, settings) {
  if (entry.status === "working") return settings.healthTtlMs;
  if (entry.status === "not_working") {
    return entry.retryable === false
      ? Math.max(settings.healthTtlMs, 10 * 60 * 1000)
      : Math.min(settings.healthTtlMs, 60 * 1000);
  }
  return 0;
}

export function availabilityIsFresh(entry, settings, providerUpdatedAt = "") {
  if (!entry || entry.status === "unknown" || !entry.checkedAt) return false;
  if (providerUpdatedAt && entry.providerUpdatedAt && entry.providerUpdatedAt !== providerUpdatedAt) return false;
  const checkedAt = entry.checkedAt instanceof Date ? entry.checkedAt.getTime() : Date.parse(entry.checkedAt);
  if (!Number.isFinite(checkedAt)) return false;
  return Date.now() - checkedAt < freshnessTtlMs(entry, settings);
}

async function providerFingerprints(userId, descriptors) {
  if (!descriptors.some(descriptor => descriptor.kind === "saved")) return new Map();
  const rows = await ProviderConfig.find({ userId }).select("configId updatedAt").lean();
  return new Map(rows.map(row => [row.configId, row.updatedAt ? new Date(row.updatedAt).toISOString() : ""]));
}

async function runPool(items, limit, worker) {
  const queue = [...items];
  const size = Math.max(1, Math.min(limit, queue.length));
  const workers = Array.from({ length: size }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      await worker(item);
    }
  });
  await Promise.all(workers);
}

function publicEntry(entry) {
  return {
    key: entry.key,
    status: entry.status,
    checkedAt: entry.checkedAt ? new Date(entry.checkedAt).toISOString() : null
  };
}

// Mongoose subdocuments keep schema values behind prototype getters, so
// spreading one yields an empty object. Availability entries are copied field
// by field to keep cached and freshly probed entries in the same plain shape.
function plainEntry(entry) {
  return {
    key: String(entry?.key || ""),
    status: entry?.status === "working" || entry?.status === "not_working" ? entry.status : "unknown",
    checkedAt: entry?.checkedAt ? new Date(entry.checkedAt) : null,
    reason: String(entry?.reason || ""),
    retryable: typeof entry?.retryable === "boolean" ? entry.retryable : null,
    providerUpdatedAt: String(entry?.providerUpdatedAt || "")
  };
}

export async function runAvailabilityChecks({
  userId,
  config,
  descriptors = config?.selected || [],
  force = false,
  signal = null,
  concurrency = 3
}) {
  const settings = config?.settings || {};
  const ttlSettings = {
    healthTtlMs: Number(settings.healthTtlMs) || 120000
  };
  const fingerprints = await providerFingerprints(userId, descriptors);
  const cached = new Map(
    (Array.isArray(config?.availability) ? config.availability : [])
      .map(entry => [entry.key, plainEntry(entry)])
  );
  const results = new Map();
  const pending = [];

  for (const descriptor of descriptors) {
    const fingerprint = descriptor.kind === "saved" ? fingerprints.get(descriptor.configId) || "" : "";
    const entry = cached.get(descriptor.key);
    if (!force && availabilityIsFresh(entry, ttlSettings, fingerprint)) {
      results.set(descriptor.key, entry);
    } else {
      pending.push(descriptor);
    }
  }

  await runPool(pending, Math.max(1, Math.min(8, Number(concurrency) || 3)), async descriptor => {
    if (cancelled(signal)) return;
    try {
      const probe = await probeDescriptor(userId, descriptor, {
        signal,
        timeoutMs: settings.probeTimeoutMs
      });
      results.set(descriptor.key, {
        key: descriptor.key,
        status: probe.status,
        checkedAt: new Date(),
        reason: probe.reason,
        retryable: probe.retryable,
        providerUpdatedAt: descriptor.kind === "saved" ? fingerprints.get(descriptor.configId) || "" : ""
      });
    } catch (error) {
      if (error instanceof ComboCancelledError) return;
      results.set(descriptor.key, {
        key: descriptor.key,
        status: "not_working",
        checkedAt: new Date(),
        reason: availabilityReason(error),
        retryable: true,
        providerUpdatedAt: descriptor.kind === "saved" ? fingerprints.get(descriptor.configId) || "" : ""
      });
    }
  });

  const ordered = descriptors.map(descriptor => plainEntry(
    results.get(descriptor.key) || cached.get(descriptor.key) || {
      key: descriptor.key,
      status: "unknown",
      checkedAt: null,
      reason: "",
      retryable: null,
      providerUpdatedAt: ""
    }
  ));

  if (config && !config.isNew) {
    // A check is only ever run over a subset of the selected models - a keyed
    // recheck, or a single-model test - so the entries this run did not touch
    // carry over instead of being silently dropped from the cache.
    const probedKeys = new Set(descriptors.map(descriptor => descriptor.key));
    const carried = [...cached.values()].filter(entry => entry.key && !probedKeys.has(entry.key));
    config.availability = normalizeAvailability([...ordered, ...carried]);
    config.markModified?.("availability");
    try {
      await config.save();
    } catch {
      /* Availability is advisory; a failed cache write must not fail the run. */
    }
  }

  const activeKeys = descriptors
    .filter(descriptor => ordered.find(entry => entry.key === descriptor.key)?.status === "working")
    .map(descriptor => descriptor.key);
  const excludedKeys = descriptors
    .filter(descriptor => !activeKeys.includes(descriptor.key))
    .map(descriptor => descriptor.key);

  return {
    models: ordered.map(publicEntry),
    entries: ordered,
    activeKeys,
    excludedKeys
  };
}

// Availability rows are read-modify-written, so two concurrent single-model tests
// for the same account could each start from the pre-write state and one result
// would vanish. Every write for a user runs after the previous one has landed.
const availabilityWrites = new Map();

function queueAvailabilityWrite(userId, task) {
  const previous = availabilityWrites.get(userId) || Promise.resolve();
  const run = previous.then(task);
  const tracked = run.catch(() => {});
  availabilityWrites.set(userId, tracked);
  tracked.then(() => {
    if (availabilityWrites.get(userId) === tracked) availabilityWrites.delete(userId);
  });
  return run;
}

export function storeAvailabilityEntry(userId, entry) {
  return queueAvailabilityWrite(userId, async () => {
    const stored = await ComboConfig.findOne({ userId });
    const carried = (Array.isArray(stored?.availability) ? stored.availability : [])
      .filter(row => String(row?.key || "") !== entry.key);
    await ComboConfig.findOneAndUpdate(
      { userId },
      { $set: { availability: normalizeAvailability([entry, ...carried]) } },
      { upsert: true, setDefaultsOnInsert: true }
    );
  });
}

// One model, one real request, no orchestration and no selection change. The
// result lands in the same availability cache the batch check writes, so a model
// proved by a manual test is reported identically to one proved by a recheck.
export async function runModelTest({ userId, descriptor, config, signal = null }) {
  const settings = config?.settings || {};
  const probe = await probeDescriptor(userId, descriptor, {
    signal,
    timeoutMs: settings.probeTimeoutMs
  });
  const fingerprints = await providerFingerprints(userId, [descriptor]);
  const entry = {
    key: descriptor.key,
    status: probe.status,
    checkedAt: new Date(),
    reason: probe.reason,
    retryable: probe.retryable,
    providerUpdatedAt: descriptor.kind === "saved" ? fingerprints.get(descriptor.configId) || "" : ""
  };
  await storeAvailabilityEntry(userId, entry);
  return {
    ...publicEntry(entry),
    // The batch endpoint only ever publishes key/status/checkedAt. A test is a
    // deliberate action on one model, so it also hands back why it failed and
    // what the provider answered - reason is a code, detail is already redacted.
    reason: probe.reason,
    retryable: probe.retryable,
    latencyMs: probe.latencyMs,
    httpStatus: probe.httpStatus,
    detail: probe.detail
  };
}

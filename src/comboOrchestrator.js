import { randomUUID } from "node:crypto";
import { chatCompletion } from "./providerClient.js";
import {
  ComboCancelledError,
  isTransientAvailabilityError,
  resolveComboProvider
} from "./comboAvailability.js";
import { comboFailoverCategory, comboFailureReason } from "./comboFailover.js";

export const COMBO_EXECUTION = "sequential-failover";

export class ComboError extends Error {
  constructor(message, status = 400, code = "combo_error") {
    super(message);
    this.name = "ComboError";
    this.status = status;
    this.code = code;
  }
}

function cancelled(signal) {
  return signal?.aborted === true;
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (cancelled(signal)) {
      reject(new ComboCancelledError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ComboCancelledError());
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

function modelForProvider(descriptor, provider) {
  if (descriptor.kind === "vups") return provider.probeModel || provider.model || descriptor.model;
  return descriptor.model;
}

// One request in flight, always. The bounded same-model retry is the user's
// existing `retries` preference; it never overlaps with another model because the
// caller awaits this before it even looks at the next candidate.
async function callProvider({ descriptor, provider, messages, signal, settings }) {
  const attempts = 1 + Math.max(0, Math.min(2, Number(settings.retries) || 0));
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (cancelled(signal)) throw new ComboCancelledError();
    const timeout = AbortSignal.timeout(Math.max(5000, Math.min(300000, Number(settings.timeoutMs) || 60000)));
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      return await chatCompletion(
        {
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
          providerType: provider.providerType,
          authMode: provider.authMode,
          openapiBaseUrl: provider.openapiBaseUrl,
          model: modelForProvider(descriptor, provider),
          messages
        },
        combined
      );
    } catch (error) {
      if (cancelled(signal)) throw new ComboCancelledError();
      lastError = error;
      if (!isTransientAvailabilityError(error) || attempt + 1 >= attempts) throw error;
      await delay(Math.min(3000, 700 * 2 ** attempt), signal);
    }
  }
  throw lastError || new Error("Model request failed.");
}

function publicModel(descriptor, status = "waiting") {
  return {
    key: descriptor.key,
    label: descriptor.label,
    provider: descriptor.provider,
    model: descriptor.model,
    status
  };
}

function logFailure(descriptor, error, category) {
  const code = String(error?.code || error?.name || "unknown").slice(0, 60);
  console.warn(`[combo] ${descriptor.kind} model failed: ${code} (${category || "permanent"})`);
}

/**
 * One task, one active model request at a time.
 *
 * Candidates are the user's selected models in their configured order. Each is
 * asked the identical conversation, and the first validated answer ends the run.
 * A limit, quota or temporary capacity failure moves to the next candidate; a
 * credential, payload, capability or configuration failure ends the run with an
 * honest error instead of hiding behind another model. Nothing is probed,
 * compared or synthesized, so a run never spends requests beyond its attempts.
 */
export async function runComboChat({ userId, config, messages, signal = null, onEvent = null }) {
  const emit = event => {
    try {
      onEvent?.(event);
    } catch {
      /* A failed progress write must not cancel model work. */
    }
  };
  const settings = config?.settings || {};
  const descriptors = Array.isArray(config?.selected) ? config.selected : [];
  if (!config?.enabled) {
    throw new ComboError("Vups Combo AI is disabled. Enable it in Combo settings.", 403, "combo_disabled");
  }
  if (descriptors.length === 0) {
    throw new ComboError("Select at least one model for Vups Combo AI.", 400, "no_models_selected");
  }
  if (cancelled(signal)) throw new ComboCancelledError();

  const limit = Math.max(1, Math.min(8, Number(settings.maxWorkingModels) || 4));
  const candidates = descriptors.slice(0, limit);
  const deferred = descriptors.slice(limit);
  const runId = randomUUID();
  const startedAt = Date.now();

  emit({ type: "run", runId, execution: COMBO_EXECUTION, selectedCount: descriptors.length, attemptLimit: candidates.length });
  emit({
    type: "pool",
    active: candidates.map(descriptor => publicModel(descriptor)),
    deferredCount: deferred.length,
    selectedCount: descriptors.length,
    attemptLimit: candidates.length
  });
  emit({
    type: "stage",
    phase: "starting",
    message: candidates.length === 1
      ? `Asking ${candidates[0].label}`
      : `Trying ${candidates.length} models one at a time, in your order`
  });

  const attempts = [];
  const switches = [];
  let finalText = "";
  let finalModel = null;

  for (let index = 0; index < candidates.length; index += 1) {
    if (cancelled(signal)) throw new ComboCancelledError();
    const descriptor = candidates[index];
    const attempt = index + 1;
    const modelStarted = Date.now();
    const identity = {
      key: descriptor.key,
      label: descriptor.label,
      provider: descriptor.provider,
      model: descriptor.model
    };
    emit({ type: "model", ...identity, status: "started", attempt, index, total: candidates.length });

    let content = "";
    let failure = null;
    try {
      const provider = await resolveComboProvider(userId, descriptor);
      const result = await callProvider({ descriptor, provider, messages, signal, settings });
      content = String(result?.content || "").trim();
      if (!content) {
        const empty = new Error("The model returned no answer text.");
        empty.code = "empty_response";
        throw empty;
      }
    } catch (error) {
      if (error instanceof ComboCancelledError || cancelled(signal)) throw new ComboCancelledError();
      failure = error;
    }
    const latencyMs = Date.now() - modelStarted;

    if (!failure) {
      attempts.push({ ...publicModel(descriptor), attempt, status: "succeeded", latencyMs, chars: content.length });
      emit({ type: "model", ...identity, status: "finished", attempt, index, total: candidates.length, latencyMs, chars: content.length });
      finalText = content;
      finalModel = identity;
      break;
    }

    const category = comboFailoverCategory(failure);
    const reason = comboFailureReason(failure);
    logFailure(descriptor, failure, category);
    const next = category ? candidates[index + 1] || null : null;
    attempts.push({
      ...publicModel(descriptor),
      attempt,
      status: "failed",
      latencyMs,
      chars: 0,
      category: category || "permanent",
      reason
    });
    emit({
      type: "model",
      ...identity,
      status: "failed",
      attempt,
      index,
      total: candidates.length,
      latencyMs,
      category,
      reason,
      willSwitch: Boolean(next)
    });

    if (!category) {
      throw new ComboError(
        `${descriptor.label} ${reason}. Vups Combo AI stopped instead of trying another model, because this failure needs a fix in settings. Update that provider or remove the model from your Combo selection.`,
        502,
        "non_retryable_failure"
      );
    }
    if (!next) break;

    switches.push({ from: identity, to: publicModel(next), attempt, category, reason });
    emit({
      type: "stage",
      phase: "switching",
      message: `Switching to ${next.label} - ${descriptor.label} ${reason}`
    });
  }

  if (!finalModel) {
    throw new ComboError(
      `None of your ${attempts.length} tried model${attempts.length === 1 ? "" : "s"} could answer right now: every attempt hit a rate limit, an exhausted quota or a temporary provider failure. Your selections are saved; try again shortly or reorder them in Combo settings.`,
      502,
      "all_models_failed"
    );
  }
  if (cancelled(signal)) throw new ComboCancelledError();

  emit({ type: "stage", phase: "finalizing", message: `${finalModel.label} answered` });

  return {
    runId,
    finalText,
    meta: {
      runId,
      execution: COMBO_EXECUTION,
      selectedCount: descriptors.length,
      attemptLimit: candidates.length,
      attemptedCount: attempts.length,
      deferredCount: deferred.length,
      durationMs: Date.now() - startedAt,
      deferred: deferred.map(descriptor => publicModel(descriptor)),
      attempts,
      switches,
      finalModel,
      singleModel: attempts.length === 1,
      finalChars: finalText.length
    }
  };
}
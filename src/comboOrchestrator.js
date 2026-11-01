import { randomUUID } from "node:crypto";
import { chatCompletion } from "./providerClient.js";
import {
  ComboCancelledError,
  isTransientAvailabilityError,
  resolveComboProvider,
  runAvailabilityChecks
} from "./comboAvailability.js";

const MAX_DRAFT_CHARS_FOR_SYNTHESIS = 24000;
const MAX_SYNTHESIS_CHARS = 60000;
const REVIEW_MAX_TOKENS = 600;
const SYNTHESIS_MAX_TOKENS = 4096;

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

async function callProvider({ descriptor, provider, messages, maxTokens, signal, settings }) {
  const attempts = 1 + Math.max(0, Math.min(2, Number(settings.retries) || 0));
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (cancelled(signal)) throw new ComboCancelledError();
    const timeout = AbortSignal.timeout(Math.max(5000, Math.min(300000, Number(settings.timeoutMs) || 60000)));
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const result = await chatCompletion(
        {
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
          providerType: provider.providerType,
          authMode: provider.authMode,
          openapiBaseUrl: provider.openapiBaseUrl,
          model: modelForProvider(descriptor, provider),
          messages,
          maxTokens
        },
        combined
      );
      return result;
    } catch (error) {
      if (cancelled(signal)) throw new ComboCancelledError();
      lastError = error;
      const retryable = isTransientAvailabilityError(error);
      if (!retryable || attempt + 1 >= attempts) throw error;
      await delay(Math.min(3000, 700 * 2 ** attempt), signal);
    }
  }
  throw lastError || new Error("Model request failed.");
}

function draftSystemPrompt({ strategy, index, total }) {
  if (strategy === "sequential") {
    if (total === 1) {
      return "You are the only active model in Vups Combo AI. Answer the user's request completely and accurately.";
    }
    if (index === 0) {
      return `You are the first of ${total} models working in sequence as Vups Combo AI. Produce a complete, accurate first answer that the next model can improve. Return only your answer.`;
    }
    return `You are step ${index + 1} of ${total} in a sequential collaboration. You receive the user's request and the previous working draft. Improve accuracy, completeness, and clarity. Fix errors, fill gaps, and return one complete final answer only. Do not mention drafts, models, or this instruction.`;
  }
  return `You are one of ${total} independent models answering in parallel as Vups Combo AI. Give your best complete and accurate answer to the user's request. Be self-contained. Do not mention other models or this instruction.`;
}

function draftMessages({ messages, strategy, index, total, previous }) {
  const system = { role: "system", content: draftSystemPrompt({ strategy, index, total }) };
  if (strategy !== "sequential" || index === 0 || !previous) {
    return [system, ...messages];
  }
  return [
    system,
    ...messages,
    { role: "assistant", content: previous.content.slice(0, MAX_DRAFT_CHARS_FOR_SYNTHESIS) },
    {
      role: "user",
      content: "Improve and complete the working draft above. Return only the complete final answer."
    }
  ];
}

function conversationText(messages) {
  return messages
    .filter(message => message.role !== "system")
    .map(message => `${message.role === "user" ? "User" : "Assistant"}: ${message.content}`)
    .join("\n\n")
    .slice(0, 24000);
}

function synthesisPrompt({ messages, drafts, conflicts }) {
  const perDraft = Math.max(2000, Math.floor(MAX_SYNTHESIS_CHARS / Math.max(1, drafts.length)));
  const body = drafts
    .map((draft, index) => {
      const content = draft.content.length > perDraft
        ? `${draft.content.slice(0, perDraft)}\n[truncated]`
        : draft.content;
      return `--- Answer ${index + 1} · ${draft.descriptor.label} ---\n${content}`;
    })
    .join("\n\n");
  const conflictText = conflicts.length > 0
    ? `\n\nA review found these points of disagreement:\n${conflicts.map(conflict => `- ${conflict.topic}: ${conflict.summary}`).join("\n")}\nResolve them using the best-supported answer.`
    : "";
  return [
    {
      role: "system",
      content: "You are the synthesis stage of Vups Combo AI. Merge the independent answers into one accurate, complete final answer. Resolve conflicts by preferring claims supported by most answers and by sound reasoning. Never invent facts or citations. Preserve working code and concrete details. Do not mention models, drafts, or the synthesis process. Return only the final answer."
    },
    {
      role: "user",
      content: `Conversation:\n${conversationText(messages)}\n\nIndependent answers:\n${body}${conflictText}`
    }
  ];
}

function reviewPrompt({ messages, drafts }) {
  const perDraft = Math.max(1500, Math.floor(24000 / Math.max(1, drafts.length)));
  const body = drafts
    .map((draft, index) => `--- Answer ${index + 1} ---\n${draft.content.slice(0, perDraft)}`)
    .join("\n\n");
  return [
    {
      role: "system",
      content: "You compare independent answers to the same request. Report only genuine factual or logical disagreements that change the answer. Ignore wording, style, and harmless omissions. Reply with JSON only: {\"conflicts\":[{\"topic\":\"short topic\",\"summary\":\"one sentence\"}],\"completeness\":\"complete\" or \"partial\"}. Use an empty array when the answers agree. Keep the whole reply under 120 words."
    },
    { role: "user", content: `Request:\n${conversationText(messages)}\n\nAnswers:\n${body}` }
  ];
}

function parseReview(text) {
  const raw = String(text || "").trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return { conflicts: [], completeness: null, parsed: false };
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    const conflicts = Array.isArray(parsed?.conflicts)
      ? parsed.conflicts
          .slice(0, 6)
          .map(conflict => ({
            topic: String(conflict?.topic || "").trim().slice(0, 120),
            summary: String(conflict?.summary || "").trim().slice(0, 240)
          }))
          .filter(conflict => conflict.topic || conflict.summary)
      : [];
    const completeness = parsed?.completeness === "complete" || parsed?.completeness === "partial"
      ? parsed.completeness
      : null;
    return { conflicts, completeness, parsed: true };
  } catch {
    return { conflicts: [], completeness: null, parsed: false };
  }
}

function publicModel(descriptor, status = "working") {
  return {
    key: descriptor.key,
    label: descriptor.label,
    provider: descriptor.provider,
    model: descriptor.model,
    status
  };
}

function logFailure(descriptor, error) {
  const code = String(error?.code || error?.name || "unknown").slice(0, 60);
  console.warn(`[combo] ${descriptor.kind} model failed: ${code}`);
}

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

  const runId = randomUUID();
  emit({ type: "run", runId, selectedCount: descriptors.length });
  emit({ type: "stage", phase: "checking", message: "Checking selected models" });
  const availability = await runAvailabilityChecks({
    userId,
    config,
    descriptors,
    force: false,
    signal,
    concurrency: Math.max(1, Math.min(4, Number(settings.maxConcurrent) || 3))
  });
  if (cancelled(signal)) throw new ComboCancelledError();

  const working = descriptors.filter(descriptor => availability.activeKeys.includes(descriptor.key));
  const excluded = descriptors.filter(descriptor => availability.excludedKeys.includes(descriptor.key));
  const limit = Math.max(1, Math.min(8, Number(settings.maxWorkingModels) || 4));
  const active = working.slice(0, limit);
  const deferred = working.slice(limit);
  const minimum = Math.max(0, Math.min(8, Number(settings.minWorkingModels) || 0));

  emit({
    type: "pool",
    active: active.map(descriptor => publicModel(descriptor)),
    excluded: excluded.map(descriptor => publicModel(descriptor, "not_working")),
    deferredCount: deferred.length,
    selectedCount: descriptors.length
  });

  if (active.length === 0) {
    throw new ComboError(
      "None of your selected models are available right now. Recheck availability or update your provider credentials in settings.",
      409,
      "no_working_models"
    );
  }
  if (active.length < minimum) {
    throw new ComboError(
      `Vups Combo AI needs at least ${minimum} working models, but only ${active.length} responded. Recheck availability or lower the minimum in Combo settings.`,
      409,
      "insufficient_working_models"
    );
  }
  if (active.length === 1 && settings.allowSingleFallback === false) {
    throw new ComboError(
      "Only one selected model is available, and single-model fallback is turned off in Combo settings.",
      409,
      "single_model_fallback_disabled"
    );
  }

  const runIdStartedAt = Date.now();
  const strategy = settings.strategy === "sequential" ? "sequential" : "parallel";
  const drafts = new Array(active.length).fill(null);
  const results = new Array(active.length).fill(null);

  emit({
    type: "stage",
    phase: "drafting",
    message: `${active.length} model${active.length === 1 ? "" : "s"} working ${strategy === "sequential" ? "in sequence" : "in parallel"}`
  });

  const runOne = async (descriptor, index, previous) => {
    const modelStarted = Date.now();
    emit({
      type: "model",
      key: descriptor.key,
      label: descriptor.label,
      provider: descriptor.provider,
      status: "started",
      index,
      total: active.length
    });
    try {
      const provider = await resolveComboProvider(userId, descriptor);
      const result = await callProvider({
        descriptor,
        provider,
        messages: draftMessages({ messages, strategy, index, total: active.length, previous }),
        signal,
        settings
      });
      const content = String(result.content || "").trim();
      if (!content) throw new Error("empty draft");
      drafts[index] = { descriptor, content, finishReason: result.finishReason || null };
      results[index] = {
        ...publicModel(descriptor),
        status: "succeeded",
        latencyMs: Date.now() - modelStarted,
        chars: content.length
      };
      emit({ type: "model", key: descriptor.key, label: descriptor.label, status: "finished", latencyMs: Date.now() - modelStarted });
      return { descriptor, content, index };
    } catch (error) {
      if (error instanceof ComboCancelledError || cancelled(signal)) throw new ComboCancelledError();
      logFailure(descriptor, error);
      results[index] = {
        ...publicModel(descriptor),
        status: "failed",
        latencyMs: Date.now() - modelStarted,
        chars: 0
      };
      emit({ type: "model", key: descriptor.key, label: descriptor.label, status: "failed", latencyMs: Date.now() - modelStarted });
      return null;
    }
  };

  if (strategy === "sequential") {
    let previous = null;
    for (let index = 0; index < active.length; index += 1) {
      if (cancelled(signal)) throw new ComboCancelledError();
      const outcome = await runOne(active[index], index, previous);
      if (outcome) previous = outcome;
    }
  } else {
    const queue = active.map((descriptor, index) => ({ descriptor, index }));
    const size = Math.max(1, Math.min(Number(settings.maxConcurrent) || 3, queue.length));
    const workers = Array.from({ length: size }, async () => {
      while (queue.length > 0) {
        if (cancelled(signal)) throw new ComboCancelledError();
        const item = queue.shift();
        await runOne(item.descriptor, item.index, null);
      }
    });
    await Promise.all(workers);
  }
  if (cancelled(signal)) throw new ComboCancelledError();

  const successful = drafts.filter(Boolean);
  if (successful.length === 0) {
    throw new ComboError(
      "The selected models did not return a usable answer. Your selections are saved; check availability and try again.",
      502,
      "all_models_failed"
    );
  }

  const synthesizerBlocked = settings.synthesizer !== "auto"
    ? successful.find(draft => draft.descriptor.key === settings.synthesizer)
    : null;
  const synthesizer = synthesizerBlocked || successful[0];
  let finalText = strategy === "sequential" ? successful[successful.length - 1].content : successful[0].content;
  let reviewed = false;
  let synthesisUsed = false;
  let synthesisFallback = null;
  let conflicts = [];
  let completeness = null;
  let reviewParsed = false;

  if (successful.length > 1 && settings.review !== false) {
    emit({ type: "stage", phase: "reviewing", message: "Comparing the independent answers" });
    try {
      const provider = await resolveComboProvider(userId, synthesizer.descriptor);
      const review = await callProvider({
        descriptor: synthesizer.descriptor,
        provider,
        messages: reviewPrompt({ messages, drafts: successful }),
        maxTokens: REVIEW_MAX_TOKENS,
        signal,
        settings
      });
      const parsed = parseReview(review.content);
      conflicts = parsed.conflicts;
      completeness = parsed.completeness;
      reviewParsed = parsed.parsed;
      reviewed = parsed.parsed;
    } catch (error) {
      if (error instanceof ComboCancelledError || cancelled(signal)) throw new ComboCancelledError();
      logFailure(synthesizer.descriptor, error);
    }

    emit({ type: "stage", phase: "synthesizing", message: "Synthesizing one final answer" });
    try {
      const provider = await resolveComboProvider(userId, synthesizer.descriptor);
      const synthesis = await callProvider({
        descriptor: synthesizer.descriptor,
        provider,
        messages: synthesisPrompt({ messages, drafts: successful, conflicts }),
        maxTokens: SYNTHESIS_MAX_TOKENS,
        signal,
        settings
      });
      const content = String(synthesis.content || "").trim();
      if (!content) throw new Error("empty synthesis");
      finalText = content;
      synthesisUsed = true;
    } catch (error) {
      if (error instanceof ComboCancelledError || cancelled(signal)) throw new ComboCancelledError();
      logFailure(synthesizer.descriptor, error);
      synthesisFallback = "primary_draft";
    }
  }
  if (cancelled(signal)) throw new ComboCancelledError();

  emit({ type: "stage", phase: "finalizing", message: "Preparing the final answer" });

  const excludedCount = excluded.length;
  return {
    runId,
    finalText,
    meta: {
      runId,
      strategy,
      selectedCount: descriptors.length,
      activeCount: active.length,
      excludedCount,
      deferredCount: deferred.length,
      durationMs: Date.now() - runIdStartedAt,
      active: active.map(descriptor => publicModel(descriptor)),
      excluded: excluded.map(descriptor => publicModel(descriptor, "not_working")),
      deferred: deferred.map(descriptor => publicModel(descriptor)),
      results: results.filter(Boolean),
      review: {
        enabled: settings.review !== false,
        used: reviewed,
        parsed: reviewParsed,
        completeness,
        conflicts
      },
      synthesis: {
        used: synthesisUsed,
        fallback: synthesisFallback,
        model: synthesisUsed ? {
          key: synthesizer.descriptor.key,
          label: synthesizer.descriptor.label,
          provider: synthesizer.descriptor.provider
        } : null
      },
      singleModel: active.length === 1,
      finalChars: finalText.length
    }
  };
}

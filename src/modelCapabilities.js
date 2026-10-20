const INPUT_ALIASES = {
  text: ["text"],
  image: ["image", "images", "vision"],
  audio: ["audio"],
  video: ["video"],
  file: ["file", "files", "pdf"]
};

function list(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(entry => typeof entry === "string")
    .map(entry => entry.trim().toLowerCase())
    .filter(Boolean);
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : null;
}

function hasAny(values, aliases) {
  return aliases.some(alias => values.includes(alias));
}

function declaredBooleans(entry) {
  const raw = entry?.capabilities;
  if (Array.isArray(raw)) {
    return {
      values: raw.map(value => String(value || "").toLowerCase()),
      object: null
    };
  }
  return {
    values: [],
    object: raw && typeof raw === "object" ? raw : null
  };
}

function truthy(...values) {
  return values.some(value => value === true);
}

function architectureCapabilities(entry) {
  const input = list(
    entry?.architecture?.input_modalities ?? entry?.input_modalities ?? entry?.inputModalities ?? entry?.modalities?.input
  );
  const output = list(
    entry?.architecture?.output_modalities ?? entry?.output_modalities ?? entry?.outputModalities ?? entry?.modalities?.output
  );
  const parameters = list(entry?.supported_parameters ?? entry?.supportedParameters);
  const { values, object } = declaredBooleans(entry);
  const chat = output.length > 0
    ? hasAny(output, ["text", "chat", "completion"])
    : object?.completion_chat === true || values.includes("completion_chat") || null;
  const vision = input.length > 0
    ? hasAny(input, INPUT_ALIASES.image)
    : truthy(object?.vision, object?.image_input, object?.imageInput, entry?.supports_vision) ||
        values.includes("vision") ||
        values.includes("image_input") ||
        null;
  const tools = parameters.length > 0
    ? hasAny(parameters, ["tools", "tool_choice", "function_calling"])
    : truthy(object?.tools, object?.function_calling, object?.functionCalling, entry?.supports_tools) ||
        values.includes("tools") ||
        values.includes("function_calling") ||
        null;
  const reasoning = parameters.length > 0
    ? hasAny(parameters, ["reasoning", "include_reasoning", "reasoning_effort"])
    : truthy(object?.reasoning, object?.thinking, entry?.supports_reasoning) ||
        values.includes("reasoning") ||
        values.includes("thinking") ||
        null;
  return {
    chat,
    vision,
    tools,
    reasoning,
    audioInput: input.length > 0 ? hasAny(input, INPUT_ALIASES.audio) : truthy(object?.audio_input) || null,
    audioOutput: output.length > 0 ? hasAny(output, ["audio"]) : truthy(object?.audio_output) || null,
    videoInput: input.length > 0 ? hasAny(input, INPUT_ALIASES.video) : truthy(object?.video_input) || null,
    imageGeneration: output.length > 0 ? hasAny(output, ["image"]) : truthy(object?.image_generation) || null,
    embeddings: output.length > 0 ? hasAny(output, ["embedding", "embeddings"]) : values.includes("embed") || null
  };
}

export function normalizeCapabilities(entry) {
  const base = architectureCapabilities(entry);
  const contextLength =
    numberOrNull(entry?.context_length) ??
    numberOrNull(entry?.contextLength) ??
    numberOrNull(entry?.inputTokenLimit) ??
    numberOrNull(entry?.limits?.context);
  const maxOutputTokens =
    numberOrNull(entry?.top_provider?.max_completion_tokens) ??
    numberOrNull(entry?.max_output_tokens) ??
    numberOrNull(entry?.maxOutputTokens) ??
    numberOrNull(entry?.outputTokenLimit) ??
    numberOrNull(entry?.limits?.output);
  const capabilities = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== null && value !== undefined) capabilities[key] = value;
  }
  if (capabilities.chat === true && entry?.architecture?.output_modalities) {
    capabilities.streaming = true;
  }
  if (contextLength) capabilities.contextLength = contextLength;
  if (maxOutputTokens) capabilities.maxOutputTokens = maxOutputTokens;
  return capabilities;
}

export function geminiCapabilities(entry, id) {
  const methods = list(entry?.supportedGenerationMethods);
  const input = list(entry?.inputModalities ?? entry?.input_modalities);
  const capabilities = {
    chat: methods.length === 0 || methods.includes("generatecontent")
  };
  if (methods.includes("streamgeneratecontent")) capabilities.streaming = true;
  if (methods.includes("embedcontent") || /embedding/i.test(id)) capabilities.embeddings = true;
  if (input.length > 0) {
    capabilities.vision = hasAny(input, INPUT_ALIASES.image);
    capabilities.audioInput = hasAny(input, INPUT_ALIASES.audio);
    capabilities.videoInput = hasAny(input, INPUT_ALIASES.video);
  }
  const contextLength = numberOrNull(entry?.inputTokenLimit);
  const maxOutputTokens = numberOrNull(entry?.outputTokenLimit);
  if (contextLength) capabilities.contextLength = contextLength;
  if (maxOutputTokens) capabilities.maxOutputTokens = maxOutputTokens;
  return capabilities;
}

export function visionFromCapabilities(capabilities, fallback = null) {
  if (capabilities?.vision === true) return true;
  if (capabilities?.vision === false) return false;
  return fallback === true ? true : fallback === false ? false : null;
}

export function freeFromPricing(entry) {
  const raw = entry?.pricing;
  if (!raw || typeof raw !== "object") return null;
  const prompt = Number(raw.prompt);
  const completion = Number(raw.completion);
  const request = raw.request === undefined || raw.request === null || raw.request === "" ? null : Number(raw.request);
  if (!Number.isFinite(prompt) || !Number.isFinite(completion)) return null;
  if (prompt !== 0 || completion !== 0) return false;
  return request === null || request === 0;
}

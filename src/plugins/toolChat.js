import { chatCompletion, usesResponsesApi } from "../providerClient.js";
import { PluginError } from "./errors.js";
import { executeToolByName, toolDefinitionsForUser } from "./service.js";

const MAX_TOOL_ROUNDS = 2;
const MAX_TOOL_CALLS_PER_ROUND = 5;
const MAX_TOOL_RESULT_CHARS = 12000;

export function providerSupportsPluginTools(provider, model) {
  const type = provider?.providerType || "openai_compatible";
  if (type === "anthropic_compatible" || type === "watsonx" || type === "qoder_cloud_agents") return false;
  try {
    return !usesResponsesApi(provider.baseUrl, model, type);
  } catch {
    return false;
  }
}

function toolError(error) {
  return {
    error: {
      code: error?.code || "tool_failed",
      message: error?.message || "The plugin tool failed."
    }
  };
}

function toolMessageContent(value) {
  const text = JSON.stringify(value);
  return text.length > MAX_TOOL_RESULT_CHARS ? `${text.slice(0, MAX_TOOL_RESULT_CHARS)}…` : text;
}

function cancelledError() {
  return new PluginError("Request cancelled.", 499, "cancelled");
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw cancelledError();
}

export async function runPluginToolLoop({
  userId,
  provider,
  model,
  messages,
  temperature,
  maxTokens,
  reasoning,
  signal,
  requestId = ""
}) {
  throwIfAborted(signal);
  if (!providerSupportsPluginTools(provider, model)) return null;
  const tools = await toolDefinitionsForUser(userId);
  if (tools.length === 0) return null;

  let conversation = messages;
  const toolsUsed = [];
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
    throwIfAborted(signal);
    const result = await chatCompletion({
      baseUrl: provider.baseUrl,
      authMode: provider.authMode,
      openapiBaseUrl: provider.openapiBaseUrl,
      apiKey: provider.apiKey,
      providerType: provider.providerType,
      model,
      messages: conversation,
      temperature,
      maxTokens,
      reasoning,
      tools,
      toolChoice: "auto",
      requestId,
      attempt: round
    }, signal);
    throwIfAborted(signal);

    if (!result.toolCalls?.length) {
      if (!result.content) {
        throw new PluginError("The assistant returned an empty answer after using plugins.", 502, "empty_response");
      }
      return { content: result.content, finishReason: result.finishReason, toolsUsed };
    }
    if (round === MAX_TOOL_ROUNDS) {
      throw new PluginError("The assistant used too many plugin tool rounds. Try a narrower request.", 502, "tool_round_limit");
    }

    const calls = result.toolCalls.slice(0, MAX_TOOL_CALLS_PER_ROUND).map((call, index) => ({
      ...call,
      id: call.id || `plugin_call_${round}_${index}`
    }));
    conversation = [
      ...conversation,
      { role: "assistant", content: result.content || null, tool_calls: calls }
    ];
    for (const call of calls) {
      throwIfAborted(signal);
      toolsUsed.push(call.function.name);
      let args;
      try {
        args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
      } catch {
        conversation.push({
          role: "tool",
          tool_call_id: call.id,
          content: toolMessageContent({ error: { code: "invalid_tool_arguments", message: "The tool arguments were not valid JSON." } })
        });
        continue;
      }
      let value;
      try {
        value = await executeToolByName(userId, call.function.name, args, {
          confirm: false,
          source: "ai",
          requestId,
          signal
        });
      } catch (error) {
        if (signal?.aborted) throw cancelledError();
        value = toolError(error);
      }
      throwIfAborted(signal);
      conversation.push({
        role: "tool",
        tool_call_id: call.id,
        content: toolMessageContent(value)
      });
    }
    if (result.toolCalls.length > MAX_TOOL_CALLS_PER_ROUND) {
      conversation.push({
        role: "system",
        content: "Only the first five tool calls in the previous round were executed. Use fewer tools at once."
      });
    }
  }
  throw new PluginError("The assistant used too many plugin tool rounds.", 502, "tool_round_limit");
}

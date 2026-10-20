import test from "node:test";
import assert from "node:assert/strict";
import { geminiCapabilities, normalizeCapabilities, visionFromCapabilities } from "./modelCapabilities.js";

test("OpenRouter model metadata becomes explicit capabilities", () => {
  const capabilities = normalizeCapabilities({
    architecture: {
      input_modalities: ["text", "image", "audio"],
      output_modalities: ["text"]
    },
    supported_parameters: ["tools", "tool_choice", "reasoning"],
    context_length: 128000,
    top_provider: { max_completion_tokens: 8192 }
  });
  assert.deepEqual(capabilities, {
    chat: true,
    streaming: true,
    vision: true,
    tools: true,
    reasoning: true,
    audioInput: true,
    audioOutput: false,
    videoInput: false,
    imageGeneration: false,
    embeddings: false,
    contextLength: 128000,
    maxOutputTokens: 8192
  });
});

test("declared provider capabilities are honored without inventing unknowns", () => {
  const capabilities = normalizeCapabilities({
    capabilities: { image_input: true, thinking: true, completion_chat: true }
  });
  assert.equal(capabilities.vision, true);
  assert.equal(capabilities.reasoning, true);
  assert.equal(capabilities.chat, true);
  assert.equal(capabilities.tools, undefined);
  assert.equal(capabilities.audioInput, undefined);
  assert.equal(visionFromCapabilities(capabilities), true);
});

test("missing metadata stays unknown rather than claiming support", () => {
  const capabilities = normalizeCapabilities({ id: "some-model" });
  assert.deepEqual(capabilities, {});
  assert.equal(visionFromCapabilities(capabilities), null);
});

test("Gemini metadata maps token limits and modalities", () => {
  const capabilities = geminiCapabilities({
    supportedGenerationMethods: ["generateContent", "streamGenerateContent"],
    inputModalities: ["TEXT", "IMAGE"],
    inputTokenLimit: 1048576,
    outputTokenLimit: 65536
  }, "gemini-test");
  assert.equal(capabilities.chat, true);
  assert.equal(capabilities.streaming, true);
  assert.equal(capabilities.vision, true);
  assert.equal(capabilities.contextLength, 1048576);
  assert.equal(capabilities.maxOutputTokens, 65536);
});

test("Gemini models without modality metadata do not claim vision", () => {
  const capabilities = geminiCapabilities({
    supportedGenerationMethods: ["generateContent"]
  }, "gemini-test");
  assert.equal(capabilities.chat, true);
  assert.equal(capabilities.vision, undefined);
  assert.equal(visionFromCapabilities(capabilities), null);
});

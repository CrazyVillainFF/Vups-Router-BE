import assert from "node:assert/strict";
import { test } from "node:test";

const { buildChatRequestBody, serializeMessages } = await import("../providerClient.js");
const { providerSupportsPluginTools } = await import("./toolChat.js");

test("chat request bodies include tool definitions only for chat-completions providers", () => {
  const tools = [{
    type: "function",
    function: {
      name: "plugin__wikipedia__search",
      description: "Search Wikipedia",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }
    }
  }];
  const body = buildChatRequestBody({
    model: "test-model",
    messages: [{ role: "user", content: "Hello" }],
    stream: false,
    tools,
    toolChoice: "auto"
  });
  assert.deepEqual(body.tools, tools);
  assert.equal(body.tool_choice, "auto");

  const responses = buildChatRequestBody({
    model: "test-model",
    messages: [{ role: "user", content: "Hello" }],
    stream: false,
    responses: true,
    tools,
    toolChoice: "auto"
  });
  assert.equal(responses.tools, undefined);
});

test("tool calls and tool results survive message serialization", () => {
  const messages = serializeMessages([
    { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "x", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "call_1", content: "{\"ok\":true}" }
  ]);
  assert.deepEqual(messages[0].tool_calls, [{ id: "call_1", type: "function", function: { name: "x", arguments: "{}" } }]);
  assert.equal(messages[1].role, "tool");
  assert.equal(messages[1].tool_call_id, "call_1");
});

test("plugin tools are disabled for providers with incompatible protocols", () => {
  assert.equal(providerSupportsPluginTools({ providerType: "openai_compatible", baseUrl: "https://api.example.com/v1" }, "test-model"), true);
  assert.equal(providerSupportsPluginTools({ providerType: "anthropic_compatible", baseUrl: "https://api.example.com/v1" }, "test-model"), false);
  assert.equal(providerSupportsPluginTools({ providerType: "watsonx", baseUrl: "https://api.example.com/v1" }, "test-model"), false);
});

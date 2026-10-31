import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import {
  buildAnthropicRequestBody,
  buildChatRequestBody,
  chatCompletion,
  parseTextToolCalls,
  resolveToolTransport,
  toolTransportFor
} from "./providerClient.js";
import { DESKTOP_TOOLS } from "./desktopTools.js";

const MODEL = "tool-transport-model";
const requests = [];
let server;
let baseUrl;
let anthropicBaseUrl;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => {
      data += chunk;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function json(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

before(async () => {
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const raw = req.method === "POST" ? await readBody(req) : "";
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = raw;
    }
    const apiKey = req.headers["x-api-key"] || String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    requests.push({ path: url.pathname, headers: req.headers, body, apiKey });

    if (url.pathname === "/anthropic/v1/messages") {
      if (apiKey === "anthropic-tools") {
        return json(res, 200, {
          id: "msg_tool",
          type: "message",
          role: "assistant",
          content: [
            { type: "text", text: "I will check." },
            { type: "tool_use", id: "toolu_1", name: "list_directory", input: { path: "C:/Users/Test/Desktop" } }
          ],
          stop_reason: "tool_use"
        });
      }
      return json(res, 200, {
        id: "msg_plain",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "Hello from Claude" }],
        stop_reason: "end_turn"
      });
    }

    if (url.pathname === "/v1/responses") {
      if (apiKey === "responses-tools") {
        return json(res, 200, {
          id: "resp_tool",
          status: "completed",
          output: [
            { type: "message", role: "assistant", content: [{ type: "output_text", text: "Checking the folder." }] },
            { type: "function_call", id: "fc_1", call_id: "call_9", name: "read_file", arguments: "{\"path\":\"C:/Temp/a.txt\"}" }
          ]
        });
      }
      return json(res, 200, {
        id: "resp_plain",
        status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Hello from Responses" }] }]
      });
    }

    if (url.pathname === "/v1/chat/completions") {
      if (apiKey === "reject-tools") {
        if (Array.isArray(body?.tools) && body.tools.length > 0) {
          return json(res, 400, { error: { message: "Invalid parameter: tools is not supported by this model." } });
        }
        return json(res, 200, {
          choices: [{
            message: {
              role: "assistant",
              content: [
                "I will read it.",
                '<vups_tool_call>{"name":"read_file","arguments":{"path":"C:/Temp/a.txt"}}</vups_tool_call>',
                '<vups_tool_call>{"name":"format_drive","arguments":{}}</vups_tool_call>',
                '<vups_tool_call>{broken json}</vups_tool_call>'
              ].join("\n")
            },
            finish_reason: "stop"
          }]
        });
      }
      if (apiKey === "openai-tools") {
        return json(res, 200, {
          choices: [{
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{ id: "call_1", type: "function", function: { name: "list_directory", arguments: "{\"path\":\"C:/Temp\"}" } }]
            },
            finish_reason: "tool_calls"
          }]
        });
      }
      return json(res, 200, { choices: [{ message: { role: "assistant", content: "Hello from chat" }, finish_reason: "stop" }] });
    }

    return json(res, 404, { error: { message: "No adapter route" } });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  anthropicBaseUrl = `http://127.0.0.1:${server.address().port}/anthropic`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
});

test("every provider type resolves to a supported tool transport", () => {
  assert.equal(resolveToolTransport("https://api.openai.com/v1", "gpt-5.6-sol", "openai_compatible"), "openai_chat");
  assert.equal(resolveToolTransport("https://api.openai.com/v1", "gpt-5.6-sol", "openai_responses"), "openai_responses");
  assert.equal(resolveToolTransport("https://api.anthropic.com", "claude-sol", "anthropic_compatible"), "anthropic");
  assert.equal(resolveToolTransport("https://us-south.ml.cloud.ibm.com?project_id=p", "granite", "watsonx"), "text");
  assert.equal(resolveToolTransport("https://api.example.com", "qoder-model", "qoder_cloud_agents"), "text");
  assert.equal(resolveToolTransport("https://agentrouter.org", "gpt-5.6-sol", "openai_compatible"), "openai_responses");
  assert.equal(resolveToolTransport("https://co.agentrouter.org", "gpt-5.6-sol", "openai_compatible"), "openai_chat");
  assert.equal(resolveToolTransport("https://opencode.ai/inference", "claude-sonnet-4", "openai_compatible"), "anthropic");
  assert.equal(resolveToolTransport("https://opencode.ai/inference", "gpt-5.6-sol", "openai_compatible"), "openai_responses");
});

test("toolTransportFor reads the stored provider shape without throwing on bad URLs", () => {
  assert.equal(
    toolTransportFor({ baseUrl: "https://api.openai.com/v1", providerType: "openai_compatible" }, "gpt-5.6-sol"),
    "openai_chat"
  );
  assert.equal(
    toolTransportFor({ baseUrl: "https://api.anthropic.com", providerType: "anthropic_compatible" }, "claude-sol"),
    "anthropic"
  );
  assert.equal(
    toolTransportFor({ baseUrl: "https://api.openai.com/v1", providerType: "openai_responses" }, "gpt-5.6-sol"),
    "openai_responses"
  );
  assert.equal(
    toolTransportFor({ baseUrl: "https://us-south.ml.cloud.ibm.com?project_id=p", providerType: "watsonx" }, "granite"),
    "text"
  );
  assert.equal(
    toolTransportFor({ baseUrl: "not a url", providerType: "openai_compatible" }, "m"),
    "openai_chat"
  );
});

test("Anthropic bodies carry native tool definitions and tool_choice", () => {
  const body = buildAnthropicRequestBody({
    model: MODEL,
    stream: false,
    messages: [{ role: "user", content: "List my Desktop" }],
    tools: DESKTOP_TOOLS.slice(0, 3),
    toolChoice: "auto"
  });
  assert.equal(body.tools.length, 3);
  assert.equal(body.tools[0].name, "get_windows_known_folder");
  assert.equal(body.tools[0].input_schema.type, "object");
  assert.equal(body.tools[0].function, undefined);
  assert.deepEqual(body.tool_choice, { type: "auto" });
  assert.equal(body.messages[0].content[0].type, "text");
});

test("Anthropic history becomes tool_use and tool_result blocks", () => {
  const body = buildAnthropicRequestBody({
    model: MODEL,
    stream: false,
    messages: [
      { role: "user", content: "List it" },
      {
        role: "assistant",
        content: "Checking",
        tool_calls: [{ id: "toolu_1", type: "function", function: { name: "list_directory", arguments: "{\"path\":\"C:/Temp\"}" } }]
      },
      { role: "tool", tool_call_id: "toolu_1", content: "{\"ok\":true}" },
      { role: "assistant", content: "Done" }
    ]
  });
  assert.deepEqual(body.messages[1], {
    role: "assistant",
    content: [
      { type: "text", text: "Checking" },
      { type: "tool_use", id: "toolu_1", name: "list_directory", input: { path: "C:/Temp" } }
    ]
  });
  assert.deepEqual(body.messages[2], {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "{\"ok\":true}" }]
  });
  assert.deepEqual(body.messages[3], { role: "assistant", content: [{ type: "text", text: "Done" }] });
});

test("Anthropic chat returns normalized tool calls from tool_use blocks", async () => {
  requests.length = 0;
  const result = await chatCompletion({
    baseUrl: anthropicBaseUrl,
    apiKey: "anthropic-tools",
    providerType: "anthropic_compatible",
    model: MODEL,
    messages: [{ role: "user", content: "List C:/Users/Test/Desktop" }],
    tools: DESKTOP_TOOLS,
    toolChoice: "auto"
  });
  assert.equal(result.toolTransport, "anthropic");
  assert.equal(result.content, "I will check.");
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].id, "toolu_1");
  assert.deepEqual(result.toolCalls[0].function, {
    name: "list_directory",
    arguments: "{\"path\":\"C:/Users/Test/Desktop\"}"
  });
  assert.equal(requests[0].path, "/anthropic/v1/messages");
  assert.equal(requests[0].headers["anthropic-version"], "2023-06-01");
  assert.equal(requests[0].body.tools.length, DESKTOP_TOOLS.length);
});

test("Responses bodies flatten tools and tool history into documented items", () => {
  const body = buildChatRequestBody({
    model: MODEL,
    stream: false,
    responses: true,
    messages: [
      { role: "system", content: "Be careful." },
      { role: "user", content: "List it" },
      {
        role: "assistant",
        content: "Checking",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "list_directory", arguments: "{\"path\":\"C:/Temp\"}" } }]
      },
      { role: "tool", tool_call_id: "call_1", content: "ok" }
    ],
    tools: DESKTOP_TOOLS.slice(0, 2),
    toolChoice: "auto"
  });
  assert.equal(body.instructions, "Be careful.");
  assert.equal(body.tools.length, 2);
  assert.deepEqual(body.tools[0], {
    type: "function",
    name: "get_windows_known_folder",
    description: DESKTOP_TOOLS[0].function.description,
    parameters: DESKTOP_TOOLS[0].function.parameters,
    strict: false
  });
  assert.equal(body.tool_choice, "auto");
  assert.deepEqual(body.input[0], { role: "user", content: "List it" });
  const call = body.input.find(item => item.type === "function_call");
  const output = body.input.find(item => item.type === "function_call_output");
  assert.deepEqual(call, {
    type: "function_call",
    call_id: "call_1",
    name: "list_directory",
    arguments: "{\"path\":\"C:/Temp\"}"
  });
  assert.deepEqual(output, { type: "function_call_output", call_id: "call_1", output: "ok" });
  assert.equal(body.messages, undefined);
});

test("Responses chat returns normalized function_call items", async () => {
  requests.length = 0;
  const result = await chatCompletion({
    baseUrl,
    apiKey: "responses-tools",
    providerType: "openai_responses",
    model: MODEL,
    messages: [{ role: "user", content: "Read C:/Temp/a.txt" }],
    tools: DESKTOP_TOOLS,
    toolChoice: "auto"
  });
  assert.equal(result.toolTransport, "openai_responses");
  assert.equal(result.content, "Checking the folder.");
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].id, "call_9");
  assert.deepEqual(result.toolCalls[0].function, {
    name: "read_file",
    arguments: "{\"path\":\"C:/Temp/a.txt\"}"
  });
  assert.equal(requests[0].path, "/v1/responses");
  assert.equal(requests[0].body.tools.length, DESKTOP_TOOLS.length);
});

test("OpenAI chat still returns native tool_calls unchanged", async () => {
  requests.length = 0;
  const result = await chatCompletion({
    baseUrl,
    apiKey: "openai-tools",
    providerType: "openai_compatible",
    model: MODEL,
    messages: [{ role: "user", content: "List C:/Temp" }],
    tools: DESKTOP_TOOLS,
    toolChoice: "auto"
  });
  assert.equal(result.toolTransport, "openai_chat");
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].function.name, "list_directory");
  assert.equal(requests[0].path, "/v1/chat/completions");
  assert.equal(requests[0].body.tools.length, DESKTOP_TOOLS.length);
});

test("a model without native tools gets one validated text-protocol attempt", async () => {
  requests.length = 0;
  const result = await chatCompletion({
    baseUrl,
    apiKey: "reject-tools",
    providerType: "openai_compatible",
    model: MODEL,
    messages: [
      { role: "system", content: "You are VupsRouter." },
      { role: "user", content: "Read C:/Temp/a.txt" }
    ],
    tools: DESKTOP_TOOLS,
    toolChoice: "auto"
  });
  assert.equal(requests.length, 2, "one native attempt, one compatibility attempt");
  assert.equal(requests[0].body.tools.length, DESKTOP_TOOLS.length);
  assert.equal(requests[1].body.tools, undefined);
  assert.equal(requests[1].body.tool_choice, undefined);
  assert.match(String(requests[1].body.messages[0].content), /<vups_tool_call>/);
  assert.match(String(requests[1].body.messages[0].content), /read_file\(/);
  assert.equal(result.toolTransport, "text");
  assert.equal(result.toolCalls.length, 1, "only the registered call executes");
  assert.equal(result.toolCalls[0].function.name, "read_file");
  assert.deepEqual(JSON.parse(result.toolCalls[0].function.arguments), { path: "C:/Temp/a.txt" });
  assert.match(result.content, /I will read it\./);
  assert.doesNotMatch(result.content, /\{"name":"read_file"/, "an executed block is never shown as prose");
  assert.match(result.content, /format_drive/, "an unregistered tool name stays plain text");
  assert.match(result.content, /broken json/, "malformed JSON stays plain text");
});

test("text-protocol history replaces tool turns with replayable blocks", async () => {
  requests.length = 0;
  const result = await chatCompletion({
    baseUrl,
    apiKey: "reject-tools",
    providerType: "openai_compatible",
    model: MODEL,
    messages: [
      { role: "system", content: "You are VupsRouter." },
      { role: "user", content: "Read C:/Temp/a.txt" },
      {
        role: "assistant",
        content: "Checking",
        tool_calls: [{ id: "call_7", type: "function", function: { name: "read_file", arguments: "{\"path\":\"C:/Temp/a.txt\"}" } }]
      },
      { role: "tool", tool_call_id: "call_7", content: "{\"ok\":true}" }
    ],
    tools: DESKTOP_TOOLS,
    toolChoice: "auto"
  });
  const messages = requests[1].body.messages;
  const assistant = messages.find(message => message.role === "assistant");
  assert.equal(assistant.tool_calls, undefined);
  assert.match(assistant.content, /<vups_tool_call>\{"name":"read_file"/);
  const toolTurn = messages.find(message => message.role === "user" && message.content.includes("[Tool result: read_file]"));
  assert.ok(toolTurn, "the tool result is replayed as readable text");
  assert.match(toolTurn.content, /\{"ok":true\}/);
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].function.name, "read_file");
});

test("the text parser caps calls and refuses names outside the supplied registry", () => {
  const blocks = Array.from({ length: 7 }, (_, index) => (
    `<vups_tool_call>{"name":"read_file","arguments":{"path":"C:/f${index}.txt"}}</vups_tool_call>`
  )).join("\n");
  const parsed = parseTextToolCalls(blocks, DESKTOP_TOOLS);
  assert.equal(parsed.toolCalls.length, 5);
  assert.match(parsed.content, /f5\.txt/, "blocks over the cap stay visible text");

  const unknown = parseTextToolCalls(
    '<vups_tool_call>{"name":"write_everything","arguments":{}}</vups_tool_call>',
    DESKTOP_TOOLS
  );
  assert.equal(unknown.toolCalls.length, 0);
  assert.match(unknown.content, /write_everything/);

  const noRegistry = parseTextToolCalls(
    '<vups_tool_call>{"name":"read_file","arguments":{"path":"C:/a"}}</vups_tool_call>',
    []
  );
  assert.equal(noRegistry.toolCalls.length, 0, "no tools in the request means nothing is executable");

  const argumentsTooLarge = parseTextToolCalls(
    `<vups_tool_call>{"name":"read_file","arguments":{"path":"${"a".repeat(200001)}"}}</vups_tool_call>`,
    DESKTOP_TOOLS
  );
  assert.equal(argumentsTooLarge.toolCalls.length, 0, "oversized arguments are never executed");
});

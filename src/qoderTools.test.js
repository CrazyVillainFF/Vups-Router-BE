import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { chatCompletion, startChatCompletionStream } from "./providerClient.js";
import { FAKE_QODER_API_KEY, FAKE_QODER_MODEL, startFakeQoder } from "./testUtils/fakeQoder.js";

const MODEL = FAKE_QODER_MODEL;

// The same shape the central registry hands every provider.
const TOOLS = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a text file from the selected workspace.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Absolute path to the file." } },
        required: ["path"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_directory",
      description: "List the entries of a folder.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false
      }
    }
  }
];

let fake;
let baseUrl;
let requests;
let keySeq = 0;

// The agent cache is keyed on the credential, so each test gets its own key.
function credential() {
  keySeq += 1;
  return `${FAKE_QODER_API_KEY}-tools-${keySeq}`;
}

before(async () => {
  fake = await startFakeQoder();
  baseUrl = fake.baseUrl;
  requests = fake.state.requests;
});

after(async () => {
  await fake?.close();
});

beforeEach(() => {
  fake.state.clearRequests();
  requests = fake.state.requests;
});

const createdAgents = () => requests.filter(entry => entry.path === "/api/v1/cloud/agents" && entry.method === "POST");
const createdSessions = () => requests.filter(entry => entry.path === "/api/v1/cloud/sessions" && entry.method === "POST");
const postedEvents = () => requests.filter(entry => entry.method === "POST" && /\/sessions\/[^/]+\/events$/.test(entry.path));

async function collect(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let raw = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    raw += decoder.decode(value, { stream: true });
  }
  const chunks = [];
  let terminalCount = 0;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    const parsed = JSON.parse(payload);
    chunks.push(parsed);
    if (typeof parsed?.choices?.[0]?.finish_reason === "string") terminalCount += 1;
  }
  return { chunks, terminalCount };
}

function toolCallMessage(calls) {
  return {
    role: "assistant",
    content: null,
    tool_calls: calls.map(call => ({
      id: call.id,
      type: "function",
      function: { name: call.function.name, arguments: call.function.arguments }
    }))
  };
}

test("the whole registry is registered on the Qoder agent as custom tools", async () => {
  const apiKey = credential();
  const result = await chatCompletion({
    baseUrl,
    apiKey,
    providerType: "qoder_cloud_agents",
    model: MODEL,
    messages: [{ role: "user", content: "Say hello" }],
    tools: TOOLS,
    toolChoice: "auto",
    conversationId: "conv-registry-1"
  });

  assert.equal(result.content, "Hello world");
  assert.equal(result.finishReason, "stop");

  const [agent] = createdAgents();
  assert.ok(agent, "an agent is created for a request that carries tools");
  const names = agent.body.tools.map(tool => tool.name);
  assert.deepEqual(names, ["read_file", "list_directory"], "every registry tool reaches Qoder, in order");
  for (const tool of agent.body.tools) {
    assert.equal(tool.type, "custom");
    assert.equal(typeof tool.description, "string");
    assert.equal(tool.input_schema.type, "object");
  }
  assert.deepEqual(agent.body.tools[0].input_schema, TOOLS[0].function.parameters, "the JSON schema is sent unchanged");
  assert.deepEqual(agent.body.tools[0].input_schema.required, ["path"]);
  // Qoder's own sandbox toolset is enabled by naming it; leaving it out keeps
  // every action on VupsRouter's side of the approval dialog.
  assert.equal(JSON.stringify(agent.body.tools).includes("agent_toolset_20260401"), false);
  assert.match(agent.body.name, /[0-9a-f]{12}$/, "the agent name carries the registry signature");

  // The same registry reuses the same agent instead of provisioning another.
  await chatCompletion({
    baseUrl,
    apiKey,
    providerType: "qoder_cloud_agents",
    model: MODEL,
    messages: [{ role: "user", content: "Say hello again" }],
    tools: TOOLS,
    conversationId: "conv-registry-2"
  });
  assert.equal(createdAgents().length, 1, "an identical tool set never creates a second agent");
});

test("a different tool set gets its own agent and an empty request gets a tool-less one", async () => {
  const apiKey = credential();
  // Unique descriptions keep this test's signatures away from any agent the
  // earlier tests left on the same fake account.
  const scoped = TOOLS.map(tool => ({ ...tool, function: { ...tool.function, description: `${tool.function.description} (scoped)` } }));
  await chatCompletion({
    baseUrl,
    apiKey,
    providerType: "qoder_cloud_agents",
    model: MODEL,
    messages: [{ role: "user", content: "Hello" }],
    tools: scoped,
    conversationId: "conv-registry-3"
  });
  await chatCompletion({
    baseUrl,
    apiKey,
    providerType: "qoder_cloud_agents",
    model: MODEL,
    messages: [{ role: "user", content: "Hello" }],
    tools: [scoped[0]],
    conversationId: "conv-registry-4"
  });

  const agents = createdAgents();
  assert.equal(agents.length, 2, "the registry is part of the agent identity");
  assert.notEqual(agents[0].body.name, agents[1].body.name);
  assert.deepEqual(agents[1].body.tools.map(tool => tool.name), ["read_file"]);
});

test("a custom tool use becomes a canonical tool call that is answered on the same session", async () => {
  const apiKey = credential();
  const conversationId = "conv-tool-resume-1";
  const fileContent = JSON.stringify({ ok: true, path: "C:/workspace/a.txt", content: "hello" });
  fake.state.toolScript = [
    { tools: [{ name: "read_file", input: { path: "C:/workspace/a.txt" } }] },
    { text: "The file says hello." }
  ];

  const first = await chatCompletion({
    baseUrl,
    apiKey,
    providerType: "qoder_cloud_agents",
    model: MODEL,
    messages: [{ role: "user", content: "Read a.txt" }],
    tools: TOOLS,
    conversationId
  });

  assert.equal(first.finishReason, "tool_calls");
  assert.equal(first.toolTransport, "qoder_custom");
  assert.equal(first.toolCalls.length, 1);
  const [call] = first.toolCalls;
  assert.equal(call.type, "function");
  assert.equal(call.function.name, "read_file");
  assert.deepEqual(JSON.parse(call.function.arguments), { path: "C:/workspace/a.txt" }, "arguments survive as JSON");
  assert.match(call.id, /^ctu_/, "the Qoder custom tool use id is the call id");
  assert.equal(fake.state.toolResults.length, 0, "the adapter never invents a tool result");

  const sessionId = fake.state.sessions.at(-1).id;
  assert.equal(
    postedEvents().at(-1).path,
    `/api/v1/cloud/sessions/${sessionId}/events`,
    "the call is bound to the session that made it"
  );

  const second = await chatCompletion({
    baseUrl,
    apiKey,
    providerType: "qoder_cloud_agents",
    model: MODEL,
    messages: [
      { role: "user", content: "Read a.txt" },
      toolCallMessage(first.toolCalls),
      { role: "tool", tool_call_id: call.id, content: fileContent }
    ],
    tools: TOOLS,
    conversationId
  });

  assert.equal(second.content, "The file says hello.");
  assert.equal(second.finishReason, "stop");
  assert.equal(createdSessions().length, 1, "the tool result resumes the session that paused, it does not start a new one");
  assert.equal(fake.state.toolResults.length, 1);
  assert.equal(fake.state.toolResults[0].customToolUseId, call.id);
  assert.equal(fake.state.toolResults[0].isError, false);
  assert.deepEqual(fake.state.toolResults[0].content, [{ type: "text", text: fileContent }]);
  const resultBatch = postedEvents().at(-1);
  assert.equal(resultBatch.path, `/api/v1/cloud/sessions/${sessionId}/events`);
  assert.equal(resultBatch.body.events[0].type, "user.custom_tool_result");
  assert.equal(resultBatch.body.events[0].custom_tool_use_id, call.id);
  assert.equal(resultBatch.body.events[0].is_error, undefined);
});

test("parallel tool calls are returned and answered in one batch", async () => {
  const apiKey = credential();
  fake.state.toolScript = [
    {
      tools: [
        { name: "read_file", input: { path: "C:/workspace/a.txt" } },
        { name: "list_directory", input: { path: "C:/workspace" } }
      ]
    },
    { text: "Both done." }
  ];

  const first = await chatCompletion({
    baseUrl,
    apiKey,
    providerType: "qoder_cloud_agents",
    model: MODEL,
    messages: [{ role: "user", content: "Inspect the workspace" }],
    tools: TOOLS,
    conversationId: "conv-tool-parallel-1"
  });

  assert.equal(first.toolCalls.length, 2);
  assert.deepEqual(first.toolCalls.map(call => call.function.name), ["read_file", "list_directory"]);
  assert.notEqual(first.toolCalls[0].id, first.toolCalls[1].id);

  const results = first.toolCalls.map((call, index) => ({
    role: "tool",
    tool_call_id: call.id,
    content: JSON.stringify({ ok: true, index })
  }));
  const second = await chatCompletion({
    baseUrl,
    apiKey,
    providerType: "qoder_cloud_agents",
    model: MODEL,
    messages: [
      { role: "user", content: "Inspect the workspace" },
      toolCallMessage(first.toolCalls),
      ...results
    ],
    tools: TOOLS,
    conversationId: "conv-tool-parallel-1"
  });

  assert.equal(second.content, "Both done.");
  assert.equal(fake.state.toolResults.length, 2);
  const batch = postedEvents().at(-1).body.events;
  assert.equal(batch.length, 2, "both results travel in one batch");
  assert.deepEqual(batch.map(event => event.custom_tool_use_id), first.toolCalls.map(call => call.id));
});

test("Qoder keeps issuing tool calls until the task is finished, on one session", async () => {
  const apiKey = credential();
  const conversationId = "conv-tool-multistep-1";
  fake.state.toolScript = [
    { tools: [{ name: "list_directory", input: { path: "C:/workspace" } }] },
    { tools: [{ name: "read_file", input: { path: "C:/workspace/a.txt" } }] },
    { text: "The workspace holds a.txt, which says hello." }
  ];
  const conversation = [{ role: "user", content: "Summarize the workspace" }];
  const seen = [];

  for (let round = 0; round < 3; round += 1) {
    const result = await chatCompletion({
      baseUrl,
      apiKey,
      providerType: "qoder_cloud_agents",
      model: MODEL,
      messages: conversation,
      tools: TOOLS,
      conversationId
    });
    if (result.toolCalls?.length) {
      seen.push(...result.toolCalls.map(call => call.function.name));
      conversation.push(toolCallMessage(result.toolCalls));
      for (const call of result.toolCalls) {
        conversation.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify({ ok: true, tool: call.function.name })
        });
      }
      continue;
    }
    assert.equal(result.content, "The workspace holds a.txt, which says hello.");
    break;
  }

  assert.deepEqual(seen, ["list_directory", "read_file"], "the second round is driven by the first result");
  assert.equal(createdSessions().length, 1, "every round stays on the session that owns the conversation");
  assert.equal(fake.state.toolResults.length, 2, "each call is answered exactly once");
  assert.equal(fake.state.unknownToolResults.length, 0);
});

test("a tool the request never registered is refused with an error result, not executed", async () => {
  const apiKey = credential();
  fake.state.toolScript = [
    { tools: [{ name: "run_shell", input: { command: "echo hi" } }] },
    { text: "I could not use that tool." }
  ];

  const result = await chatCompletion({
    baseUrl,
    apiKey,
    providerType: "qoder_cloud_agents",
    model: MODEL,
    messages: [{ role: "user", content: "Run something" }],
    tools: [TOOLS[0]],
    conversationId: "conv-tool-unknown-1"
  });

  assert.deepEqual(result.toolCalls, undefined, "an unregistered call never reaches the execution loop");
  assert.equal(result.content, "I could not use that tool.");
  assert.equal(fake.state.toolResults.length, 1);
  assert.equal(fake.state.toolResults[0].isError, true);
  const payload = JSON.parse(fake.state.toolResults[0].content[0].text);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, "tool_not_available");
});

test("a failed tool result is posted with is_error so Qoder sees the real outcome", async () => {
  const apiKey = credential();
  fake.state.toolScript = [
    { tools: [{ name: "read_file", input: { path: "C:/missing.txt" } }] },
    { text: "That file does not exist." }
  ];

  const first = await chatCompletion({
    baseUrl,
    apiKey,
    providerType: "qoder_cloud_agents",
    model: MODEL,
    messages: [{ role: "user", content: "Read missing.txt" }],
    tools: TOOLS,
    conversationId: "conv-tool-error-1"
  });
  const failure = JSON.stringify({ ok: false, error: { code: "file_not_found", message: "C:/missing.txt does not exist." } });
  const second = await chatCompletion({
    baseUrl,
    apiKey,
    providerType: "qoder_cloud_agents",
    model: MODEL,
    messages: [
      { role: "user", content: "Read missing.txt" },
      toolCallMessage(first.toolCalls),
      { role: "tool", tool_call_id: first.toolCalls[0].id, content: failure }
    ],
    tools: TOOLS,
    conversationId: "conv-tool-error-1"
  });

  assert.equal(second.content, "That file does not exist.");
  assert.equal(fake.state.toolResults[0].isError, true);
  assert.equal(postedEvents().at(-1).body.events[0].is_error, true);
});

test("a new message after an abandoned tool turn replaces the paused session", async () => {
  const apiKey = credential();
  const conversationId = "conv-tool-abandoned-1";
  fake.state.toolScript = [
    { tools: [{ name: "read_file", input: { path: "C:/workspace/a.txt" } }] },
    { text: "The file says hello." }
  ];

  const first = await chatCompletion({
    baseUrl,
    apiKey,
    providerType: "qoder_cloud_agents",
    model: MODEL,
    messages: [{ role: "user", content: "Read a.txt" }],
    tools: TOOLS,
    conversationId
  });
  assert.equal(first.toolCalls.length, 1);
  const pausedSession = fake.state.sessions.at(-1).id;

  // The user moved on without the result ever coming back.
  fake.state.toolScript = [];
  fake.state.clearRequests();
  const second = await chatCompletion({
    baseUrl,
    apiKey,
    providerType: "qoder_cloud_agents",
    model: MODEL,
    messages: [
      { role: "user", content: "Read a.txt" },
      toolCallMessage(first.toolCalls),
      { role: "user", content: "Never mind, just say hello" }
    ],
    tools: TOOLS,
    conversationId
  });

  assert.equal(second.content, "Hello world");
  assert.deepEqual(fake.state.interrupts, [pausedSession], "the paused turn is released before the new one starts");
  assert.equal(createdSessions().length, 1, "a fresh session carries the real transcript");
  const batch = postedEvents().find(entry => entry.body.events[0].type === "user.message");
  assert.ok(batch, "the new turn is posted as a message, not as a tool result");
  const transcript = batch.body.events[0].content.map(block => block.text);
  assert.deepEqual(transcript, [
    "[User]\nRead a.txt",
    "[Assistant]\n[Tool call: read_file] {\"path\":\"C:/workspace/a.txt\"}",
    "[User]\nNever mind, just say hello"
  ]);
});

test("a streamed turn reports Qoder custom tool calls as tool_calls deltas", async () => {
  const apiKey = credential();
  fake.state.toolScript = [{ tools: [{ name: "read_file", input: { path: "C:/workspace/a.txt" } }] }];

  const response = await startChatCompletionStream({
    baseUrl,
    apiKey,
    providerType: "qoder_cloud_agents",
    model: MODEL,
    messages: [{ role: "user", content: "Read a.txt" }],
    tools: TOOLS,
    conversationId: "conv-stream-tools-1"
  });
  const { chunks, terminalCount } = await collect(response);

  const calls = chunks.flatMap(chunk => chunk?.choices?.[0]?.delta?.tool_calls || []);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].index, 0);
  assert.equal(calls[0].type, "function");
  assert.equal(calls[0].function.name, "read_file");
  assert.deepEqual(JSON.parse(calls[0].function.arguments), { path: "C:/workspace/a.txt" });
  assert.equal(calls[0].id, fake.state.toolCalls[0].customToolUseId);

  const terminal = chunks.filter(chunk => typeof chunk?.choices?.[0]?.finish_reason === "string");
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0].choices[0].finish_reason, "tool_calls");
  assert.equal(terminalCount, 1);
  assert.equal(fake.state.toolResults.length, 0, "a streamed call is executed by the caller, never by the adapter");
});

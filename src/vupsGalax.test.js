import assert from "node:assert/strict";
import { test } from "node:test";

process.env.NODE_ENV = "test";

const { vupsProviderForChat } = await import("./vupsGalax.js");

const ENV_KEYS = [
  "VUPS_BASE_URL",
  "VUPS_API_KEY",
  "VUPS_UNDERLYING_MODEL",
  "OPENROUTER_API_KEY",
  "OPENROUTER_BASE_URL",
  "OPENROUTER_DEFAULT_MODEL",
  "OPENROUTER_MODEL",
  "OPENROUTER_ALLOW_CUSTOM_BASE_URL"
];

function withEnv(values, run) {
  const saved = new Map(ENV_KEYS.map(name => [name, process.env[name]]));
  for (const name of ENV_KEYS) {
    if (values[name] === undefined) delete process.env[name];
    else process.env[name] = values[name];
  }
  try {
    return run();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("dedicated VUPS configuration takes precedence over OpenRouter", () => {
  withEnv(
    {
      VUPS_BASE_URL: "https://vups.example.com/v1/",
      VUPS_API_KEY: "vups-key",
      VUPS_UNDERLYING_MODEL: "vups-private-model",
      OPENROUTER_API_KEY: "openrouter-key",
      OPENROUTER_BASE_URL: "https://openrouter.ai/api/v1",
      OPENROUTER_DEFAULT_MODEL: "free/shared:free"
    },
    () => {
      const provider = vupsProviderForChat();
      assert.equal(provider.baseUrl, "https://vups.example.com/v1");
      assert.equal(provider.apiKey, "vups-key");
      assert.equal(provider.model, "vups-private-model");
      assert.equal(provider.providerType, "openai_compatible");
    }
  );
});

test("missing VUPS configuration falls back to the shared OpenRouter setup", () => {
  withEnv(
    {
      VUPS_BASE_URL: undefined,
      VUPS_API_KEY: undefined,
      VUPS_UNDERLYING_MODEL: undefined,
      OPENROUTER_API_KEY: " openrouter-key ",
      OPENROUTER_BASE_URL: "https://openrouter.ai/api/v1/",
      OPENROUTER_DEFAULT_MODEL: "free/shared:free"
    },
    () => {
      const provider = vupsProviderForChat();
      assert.equal(provider.baseUrl, "https://openrouter.ai/api/v1");
      assert.equal(provider.apiKey, "openrouter-key");
      assert.equal(provider.model, "free/shared:free");
    }
  );
});

test("partial VUPS configuration fails instead of mixing it with OpenRouter", () => {
  withEnv(
    {
      VUPS_BASE_URL: undefined,
      VUPS_API_KEY: undefined,
      VUPS_UNDERLYING_MODEL: "vups-private-model",
      OPENROUTER_API_KEY: "openrouter-key",
      OPENROUTER_BASE_URL: "https://openrouter.ai/api/v1",
      OPENROUTER_DEFAULT_MODEL: "free/shared:free"
    },
    () => {
      assert.throws(
        () => vupsProviderForChat(),
        error => error.status === 503 && error.code === "vups_not_configured"
      );
    }
  );
});

test("an invalid dedicated VUPS endpoint never falls back to OpenRouter", () => {
  withEnv(
    {
      VUPS_BASE_URL: "ftp://vups.example.com/v1",
      VUPS_API_KEY: "vups-key",
      VUPS_UNDERLYING_MODEL: "vups-private-model",
      OPENROUTER_API_KEY: "openrouter-key",
      OPENROUTER_BASE_URL: "https://openrouter.ai/api/v1",
      OPENROUTER_DEFAULT_MODEL: "free/shared:free"
    },
    () => {
      assert.throws(
        () => vupsProviderForChat(),
        error => error.status === 503 && /VUPS_BASE_URL/.test(error.message)
      );
    }
  );
});

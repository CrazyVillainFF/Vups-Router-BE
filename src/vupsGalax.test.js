import assert from "node:assert/strict";
import { test } from "node:test";

process.env.NODE_ENV = "test";

const {
  vupsExecutionConfiguration,
  vupsMaxOutputTokens,
  vupsProviderForChat,
  vupsTextConfiguration,
  vupsVisionConfiguration,
  DEFAULT_VUPS_MAX_OUTPUT_TOKENS,
  DEFAULT_VUPS_VISION_MODEL
} = await import("./vupsGalax.js");

const ENV_KEYS = [
  "VUPS_BASE_URL",
  "VUPS_API_KEY",
  "VUPS_UNDERLYING_MODEL",
  "VUPS_VISION",
  "VUPS_VISION_MODEL",
  "VUPS_MAX_OUTPUT_TOKENS",
  "VUPS_REQUEST_TIMEOUT_MS",
  "VUPS_STREAM_START_TIMEOUT_MS",
  "VUPS_STREAM_IDLE_TIMEOUT_MS",
  "VUPS_SSE_HEARTBEAT_MS",
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

test("shared OpenRouter fallback keeps text on the default model and routes images to the free vision model", () => {
  withEnv(
    {
      VUPS_BASE_URL: undefined,
      VUPS_API_KEY: undefined,
      VUPS_UNDERLYING_MODEL: undefined,
      VUPS_VISION: undefined,
      VUPS_VISION_MODEL: undefined,
      OPENROUTER_API_KEY: "openrouter-key",
      OPENROUTER_BASE_URL: "https://openrouter.ai/api/v1",
      OPENROUTER_DEFAULT_MODEL: "text/model:free"
    },
    () => {
      const text = vupsProviderForChat();
      assert.equal(text.model, "text/model:free");
      assert.equal(text.vision, null);

      const image = vupsProviderForChat({ images: true });
      assert.equal(image.model, DEFAULT_VUPS_VISION_MODEL);
      assert.equal(image.vision, true);
      assert.equal(image.reasoning, undefined, "OpenRouter fallback must not disable reasoning");
    }
  );
});

test("VUPS_VISION_MODEL overrides the fallback image model and VUPS_VISION=false disables images", () => {
  withEnv(
    {
      VUPS_BASE_URL: undefined,
      VUPS_API_KEY: undefined,
      VUPS_UNDERLYING_MODEL: undefined,
      VUPS_VISION: undefined,
      VUPS_VISION_MODEL: "custom/vision:free",
      OPENROUTER_API_KEY: "openrouter-key",
      OPENROUTER_BASE_URL: "https://openrouter.ai/api/v1",
      OPENROUTER_DEFAULT_MODEL: "text/model:free"
    },
    () => {
      const image = vupsProviderForChat({ images: true });
      assert.equal(image.model, "custom/vision:free");
      assert.equal(image.vision, true);
    }
  );

  withEnv(
    {
      VUPS_BASE_URL: undefined,
      VUPS_API_KEY: undefined,
      VUPS_UNDERLYING_MODEL: undefined,
      VUPS_VISION: "false",
      VUPS_VISION_MODEL: "custom/vision:free",
      OPENROUTER_API_KEY: "openrouter-key",
      OPENROUTER_BASE_URL: "https://openrouter.ai/api/v1",
      OPENROUTER_DEFAULT_MODEL: "text/model:free"
    },
    () => {
      const image = vupsProviderForChat({ images: true });
      assert.equal(image.model, "text/model:free");
      assert.equal(image.vision, false);
    }
  );
});

test("dedicated VUPS configuration uses VUPS_VISION_MODEL for image requests", () => {
  withEnv(
    {
      VUPS_BASE_URL: "https://vups.example.com/v1",
      VUPS_API_KEY: "vups-key",
      VUPS_UNDERLYING_MODEL: "vups-text-model",
      VUPS_VISION: undefined,
      VUPS_VISION_MODEL: "vups-vision-model",
      OPENROUTER_API_KEY: undefined,
      OPENROUTER_BASE_URL: undefined,
      OPENROUTER_DEFAULT_MODEL: undefined
    },
    () => {
      const text = vupsProviderForChat();
      assert.equal(text.model, "vups-text-model");
      assert.equal(text.vision, null);
      assert.equal(text.reasoning, undefined);

      const image = vupsProviderForChat({ images: true });
      assert.equal(image.model, "vups-vision-model");
      assert.equal(image.vision, true);
    }
  );
});

test("dedicated VUPS image requests require an explicit vision setting", () => {
  withEnv(
    {
      VUPS_BASE_URL: "https://vups.example.com/v1",
      VUPS_API_KEY: "vups-key",
      VUPS_UNDERLYING_MODEL: "vups-text-model",
      VUPS_VISION: undefined,
      VUPS_VISION_MODEL: undefined,
      OPENROUTER_API_KEY: undefined,
      OPENROUTER_BASE_URL: undefined,
      OPENROUTER_DEFAULT_MODEL: undefined
    },
    () => {
      assert.throws(
        () => vupsProviderForChat({ images: true }),
        error => error.status === 400 && error.code === "vups_vision_unsupported" && /VUPS_VISION_MODEL/.test(error.message)
      );
      assert.equal(vupsProviderForChat().model, "vups-text-model");
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

test("vision configuration reports the active model without exposing credentials", () => {
  assert.equal(DEFAULT_VUPS_VISION_MODEL, "nvidia/nemotron-3.5-super-vl:free");

  withEnv(
    {
      VUPS_BASE_URL: undefined,
      VUPS_API_KEY: undefined,
      VUPS_UNDERLYING_MODEL: undefined,
      VUPS_VISION: undefined,
      VUPS_VISION_MODEL: "nvidia/nemotron-3.5-super-vl:free",
      OPENROUTER_API_KEY: "openrouter-key",
      OPENROUTER_BASE_URL: "https://openrouter.ai/api/v1",
      OPENROUTER_DEFAULT_MODEL: "text/model:free"
    },
    () => {
      assert.deepEqual(vupsVisionConfiguration(), {
        enabled: true,
        model: "nvidia/nemotron-3.5-super-vl:free",
        source: "VUPS_VISION_MODEL"
      });
    }
  );

  withEnv(
    {
      VUPS_BASE_URL: undefined,
      VUPS_API_KEY: undefined,
      VUPS_UNDERLYING_MODEL: undefined,
      VUPS_VISION: "false",
      VUPS_VISION_MODEL: "nvidia/nemotron-3.5-super-vl:free",
      OPENROUTER_API_KEY: "openrouter-key"
    },
    () => {
      assert.equal(vupsVisionConfiguration().enabled, false);
    }
  );
});

test("a VUPS_VISION_MODEL change takes effect without reloading the module", () => {
  const base = {
    VUPS_BASE_URL: undefined,
    VUPS_API_KEY: undefined,
    VUPS_UNDERLYING_MODEL: undefined,
    VUPS_VISION: undefined,
    OPENROUTER_API_KEY: "openrouter-key",
    OPENROUTER_BASE_URL: "https://openrouter.ai/api/v1",
    OPENROUTER_DEFAULT_MODEL: "text/model:free"
  };

  withEnv({ ...base, VUPS_VISION_MODEL: "first/vision:free" }, () => {
    assert.equal(vupsProviderForChat({ images: true }).model, "first/vision:free");
  });
  withEnv({ ...base, VUPS_VISION_MODEL: "second/vision:free" }, () => {
    assert.equal(vupsProviderForChat({ images: true }).model, "second/vision:free");
  });
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

test("output and timeout settings are bounded and read without a reload", () => {
  withEnv({ VUPS_MAX_OUTPUT_TOKENS: undefined }, () => {
    assert.equal(vupsMaxOutputTokens(), DEFAULT_VUPS_MAX_OUTPUT_TOKENS);
  });
  withEnv({ VUPS_MAX_OUTPUT_TOKENS: "999999" }, () => {
    assert.equal(vupsMaxOutputTokens(), 32768);
  });
  withEnv(
    {
      VUPS_REQUEST_TIMEOUT_MS: undefined,
      VUPS_STREAM_START_TIMEOUT_MS: undefined
    },
    () => {
      const configuration = vupsExecutionConfiguration();
      assert.equal(configuration.requestTimeoutMs, 0, "no total deadline by default");
      assert.equal(configuration.streamStartTimeoutMs, 0, "a queued model is waited for");
    }
  );
  withEnv(
    {
      VUPS_REQUEST_TIMEOUT_MS: "0",
      VUPS_STREAM_START_TIMEOUT_MS: "0"
    },
    () => {
      const configuration = vupsExecutionConfiguration();
      assert.equal(configuration.requestTimeoutMs, 0);
      assert.equal(configuration.streamStartTimeoutMs, 0);
    }
  );
  withEnv(
    {
      VUPS_MAX_OUTPUT_TOKENS: "12",
      VUPS_REQUEST_TIMEOUT_MS: "1",
      VUPS_STREAM_START_TIMEOUT_MS: "9999999",
      VUPS_STREAM_IDLE_TIMEOUT_MS: "abc",
      VUPS_SSE_HEARTBEAT_MS: "50"
    },
    () => {
      assert.deepEqual(vupsExecutionConfiguration(), {
        maxOutputTokens: 256,
        requestTimeoutMs: 5000,
        streamStartTimeoutMs: 180000,
        streamIdleTimeoutMs: 240000,
        heartbeatMs: 1000
      });
    }
  );
});

test("text model configuration reports the effective source without credentials", () => {
  withEnv(
    {
      VUPS_UNDERLYING_MODEL: "dedicated/model",
      OPENROUTER_DEFAULT_MODEL: "shared/default"
    },
    () => {
      assert.deepEqual(vupsTextConfiguration(), {
        model: "dedicated/model",
        source: "VUPS_UNDERLYING_MODEL"
      });
    }
  );
  withEnv(
    {
      VUPS_UNDERLYING_MODEL: undefined,
      OPENROUTER_DEFAULT_MODEL: "shared/default"
    },
    () => {
      assert.deepEqual(vupsTextConfiguration(), {
        model: "shared/default",
        source: "OPENROUTER_DEFAULT_MODEL"
      });
    }
  );
});

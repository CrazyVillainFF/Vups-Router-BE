# VupsRouter Backend

Express API for VupsRouter with MongoDB-backed accounts, HTTP-only cookie sessions, encrypted per-user AI provider configuration, a server-side OpenAI-compatible chat proxy (with streaming), and database-backed conversation history.

## Requirements

- Node.js >= 22
- MongoDB (local `mongodb://127.0.0.1:27017/vupsrouter` or MongoDB Atlas)

## Setup

```sh
npm ci
```

Create `server/.env` from `.env.example` and fill in the real values:

| Variable | Required | Purpose |
| --- | --- | --- |
| `PORT` | no (default 4000) | HTTP port |
| `CLIENT_ORIGIN` / `CLIENT_ORIGINS` / `FRONTEND_ORIGIN` / `FRONTEND_ORIGINS` | yes | Allowed frontend origins (comma-separated, no trailing slash). `CLIENT_*` and `FRONTEND_*` names are equivalent. |
| `MONGODB_URI` | yes | MongoDB connection string |
| `JWT_SECRET` | yes | Session token signing secret, >= 32 random characters |
| `ENCRYPTION_SECRET` | yes | AES-256-GCM key for encrypting user provider API keys, >= 32 random characters |
| `ENCRYPTION_SECRET_PREVIOUS` | rotation only | comma-separated previous encryption key(s), read during controlled rotation |
| `AI_DAILY_QUOTA` | no (default 100) | Per-user daily AI request quota (resets midnight UTC) |
| `AI_MAX_CONCURRENCY` | no (default 3) | Max simultaneous AI requests per user |
| `ADMIN_EMAILS` | no | Comma-separated account emails allowed to call `/api/admin/*` |
| `ALLOW_PRIVATE_PROVIDER_URLS` | no (default off in production) | Allows personal provider base URLs pointing at localhost/private networks. Leave unset on public deployments: a hosted backend cannot reach your computer, so those URLs are rejected with an actionable message instead of failing as "invalid key" |

Generate both secrets with:

```sh
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Use a different value for each. `.env` is git-ignored; never commit it.

## Run

```sh
npm run dev     # nodemon
npm start       # production
npm test        # full integration suite (in-memory MongoDB, fake provider)
```

The test suite is self-contained: it downloads a temporary MongoDB binary via `mongodb-memory-server` and starts a local fake OpenAI-compatible provider, so no real database or API key is needed.

## API

All state-changing requests must use `Content-Type: application/json`; requests from browsers with an unknown `Origin` are rejected. Authentication uses the HTTP-only `vr_session` cookie (`SameSite=Lax; Secure; Max-Age=604800` in production, `Lax` without `Secure` in development). The shipped client reaches this API through the Vercel same-origin `/api/*` proxy, which keeps the cookie first-party so sessions survive reloads. A `Bearer` token from the signup/signin response is also accepted for API clients.

### Auth

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/api/auth/signup` | `{ name, email, password }` -> `201`, sets session cookie. `409` for duplicate email, `400` for invalid input |
| `POST` | `/api/auth/signin` | `{ email, password }` -> `200`, sets session cookie. `401` for invalid credentials |
| `POST` | `/api/auth/logout` | Clears the session cookie |
| `GET` | `/api/auth/me` | Returns the signed-in user (persistent login) |

### Provider configuration (authenticated)

Each user can save **multiple configurations at once**, including several keys for the same provider — every configuration is an isolated document with its own server-generated `configId` (unique per user), encrypted key, base URL, enabled flag, and saved model list. Saving, editing, or deleting one configuration never touches another. Exactly one configuration is `active` per user; `/api/chat` uses the requested `configId` (or the active one). Legacy single-config users are migrated in place on first read (the old document gains a `providerId` slug and a `configId` equal to it, and the old `/provider` endpoints keep working).

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/settings/providers` | Lists all saved configurations (masked keys only) plus `activeConfigId` (also returned as `activeProviderId` for older clients) |
| `POST` | `/api/settings/providers` | Creates a new configuration (server-generated stable `configId`; `providerId` may repeat) and makes it active |
| `PUT` | `/api/settings/providers/:identifier` | Upserts one configuration: `{ provider, baseUrl, apiKey?, model?, providerType? }`. `identifier` is the `configId` (or legacy `providerId` alias). A brand-new identifier becomes active; editing an existing one never steals the active slot |
| `POST` | `/api/settings/providers/:identifier/activate` | Makes this configuration the one chat uses (only this document is written) |
| `DELETE` | `/api/settings/providers/:identifier` | Deletes this configuration only; if it was active, the most recently updated remaining configuration is promoted |
| `POST` | `/api/settings/providers/:identifier/test` | Zero-inference connection check: reads `GET {baseUrl}/models` only, never sends a chat prompt, and records the result |
| `POST` | `/api/settings/providers/:identifier/test-model` | Explicit inference test: sends one tiny prompt using `{ model }` after the user confirms; never runs automatically on save |
| `PUT` | `/api/settings/providers/:identifier/models` | `{ models: string[], defaultModel? }` — validates length/uniqueness; `defaultModel` must be in the list |
| `GET` | `/api/settings/models?configId=` | Focused discovery for one saved configuration (`GET {baseUrl}/models`); the saved list is returned with a `warning` if discovery fails. Without `configId` (or legacy `providerId`) it returns the free/shared catalogue plus saved rows for **every** configuration, so the chat picker always shows both; a discovery failure only adds a `warning` and never erases rows |

Legacy endpoints (`GET/PUT/DELETE /api/settings/provider`, `POST /api/settings/provider/test`, `POST /api/settings/provider/test-model`) remain for backward compatibility and operate on the active provider.

### Provider protocols and quick start

VupsRouter dispatches through protocol adapters selected by `providerType`:

- `openai_compatible` (default) and `local_gateway` — OpenAI Chat Completions (`/chat/completions`). This also covers Vercel AI Gateway, Hugging Face Inference Providers, AI21 Studio, Cloudflare Workers AI, and Amazon Bedrock's OpenAI-compatible route (`/openai/v1`).
- `openai_responses` — OpenAI Responses API (`/responses`), also inferred for AgentRouter GPT models.
- `anthropic_compatible` — Anthropic Messages API (`/v1/messages`) with `x-api-key`, `anthropic-version`, native system prompts, images, and SSE deltas.
- **OpenCode Zen** (`opencode.ai/inference/*`) — one Bearer key reaches several documented API families. VupsRouter routes GPT/Grok/Muse Spark models to `/inference/openai/v1/responses`, Claude and Anthropic-family Qwen models to `/inference/anthropic/v1/messages` (Bearer auth), and other models to `/inference/openai/v1/chat/completions`. Discovery uses `https://opencode.ai/zen/v1/models` with the user's Bearer key. Models whose IDs end in `-free` are restricted by OpenCode to its official client: VupsRouter flags them as unavailable and rejects them with `free_tier_client_only` before any request is sent — it never imitates the client or bypasses that restriction. Gemini and Jev models use native schemas without a VupsRouter adapter and return `unsupported_protocol` before any request is sent.
- `azure_openai` — Azure OpenAI v1 (`/chat/completions`) with the key in the `api-key` header instead of `Authorization`.
- `watsonx` — IBM watsonx.ai (`/ml/v1/text/chat` and `/text/chat_stream`). The IBM Cloud API key is exchanged for a cached IAM bearer token; the base URL must include `?project_id=YOUR_PROJECT_ID`.
- Google Gemini is supported through its official OpenAI-compatible endpoint (`https://generativelanguage.googleapis.com/v1beta/openai`). Discovery uses the native `GET /v1beta/models` catalogue with `x-goog-api-key`, keeps only `generateContent` chat models, and reports Google's 400 invalid-key and 429 free-quota failures with dedicated codes (`invalid_api_key`, `free_quota_exhausted`). Free-tier quotas are enforced per Google Cloud project, reset at midnight Pacific, and are not available in the EEA, Switzerland, or the UK.
- `native` is retained for existing records but has no generic adapter and cannot be saved from the current UI.

1. Sign in and open **Provider settings**. Pick a provider card (or add a custom endpoint), choose the API protocol, paste your key, and save. Each configuration keeps its own key and models.
2. **Load models** to fetch the live list, select the ones to keep, and choose a default.
3. **Check connection** reads the model list only and is guaranteed zero-inference. OpenCode Zen uses its model catalog at `/zen/v1/models` with the user's Bearer key, so an invalid key is still reported. Some providers do not expose a model list; the endpoint is then recorded as reachable, not credential-verified.
4. **Test model** is the only action that sends inference. It requires an explicit confirmation and uses one tiny prompt; model tests never run automatically on save.
5. **Use for chat** switches the active provider. Chat requests go through the selected adapter and the model is never silently substituted.

Notes:

- **Localhost / private-network URLs**: a deployed backend (Render, Railway, …) cannot reach `http://localhost:...` on your computer — for example a FlagshipRouter or Ollama instance. On production, such URLs are rejected with `400 local_endpoint` / `private_endpoint` and an explanation (use a public HTTPS tunnel like ngrok/Cloudflare Tunnel, or run VupsRouter locally). During development and tests the guard is off; `ALLOW_PRIVATE_PROVIDER_URLS=true` re-enables private URLs for self-hosted backends that share the network.
- **URL normalization**: trailing `/chat/completions`, `/text/chat`, `/text/chat_stream`, `/responses`, `/messages`, `/completions`, `/models`, or `/embeddings` suffixes are stripped from the base URL automatically, so pasting a full endpoint URL does not produce a doubled path. `agentrouter.org` and `api.anthropic.com` base URLs normalize to `/v1` even when only the origin was saved; watsonx cluster URLs gain `/ml/v1`.
- **Watsonx credentials**: the `apiKey` field holds the IBM Cloud API key (not an IAM token). Tokens are exchanged once, cached in memory, and refreshed automatically. Append `?project_id=...` to the base URL; without it, chat and model tests return `missing_project_id`.
- **Providers without a model list**: Amazon Bedrock Runtime's OpenAI-compatible route has no `GET /models`. Check connection records the endpoint as reachable (zero inference), and Test model verifies the key; enter the model ID manually. The same reachable-only behavior applies to any other provider that returns 404/405 on `/models`.
- **Network errors are specific**: `dns_error`, `connection_refused`, `network_error`, and `timeout` are reported with the target hostname — never as an "invalid API key".
- The settings page shows a status badge per provider (Connection verified, Endpoint reachable, Invalid key, Insufficient balance, Unreachable, Not tested). Model listings drive validation: if a provider later removes a model, chat returns an actionable `invalid_model` error instead of a mystery failure.

### Administration (requires `ADMIN_EMAILS`)

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/api/admin/ai-access` | `{ email, enabled }` — enable/disable AI chat for a user |
| `GET` | `/api/admin/user?email=` | Account status plus today's usage |

All admin routes return `403` unless the signed-in user's email is listed in `ADMIN_EMAILS`. Disabled users keep normal accounts but receive `403 ai_disabled` from `/api/chat`. Quota exhaustion returns `429 quota_exceeded`; too many parallel requests return `429 concurrency_limit`.

### Chat and history (authenticated)

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/api/chat` | `{ conversationId?, messages, model?, configId?, providerId?, source?, mode?, temperature?, stream? }`. `configId` selects the exact saved configuration; `providerId` prevents a saved-model request from falling through to another provider; omit both for the shared model. `mode` is `general` (default) or `motion`. An unknown `configId` returns `404 config_not_found`. The final message may carry `images: [{ name?, mimeType?, data }]` (base64, PNG/JPEG/WebP/GIF) or `images: [{ name?, mimeType?, url }]` (public HTTPS URL). Proxies to `{baseUrl}/chat/completions` (AgentRouter `gpt-*` models: `{baseUrl}/responses`; OpenCode Zen routes each model to its documented chat, Responses, or Anthropic Messages endpoint). Streams SSE (`meta`, `delta`, `done`, `error` events) by default |
| `GET` | `/api/conversations` | Lists the user's conversations |
| `GET` | `/api/conversations/:id` | Full conversation with messages |
| `DELETE` | `/api/conversations/:id` | Deletes one conversation |

**Motion Design mode.** The chat composer has a real General/Motion Design selector. It sends `mode: "motion"` with the chat request; the backend swaps the system prompt for motion-engineering guidance covering GSAP timelines and ScrollTrigger, `@gsap/react` cleanup, CSS/SVG animation, Framer Motion trade-offs, responsive and reduced-motion behavior, performance, and debugging. It works through whichever provider/model is selected. The mode is stored in browser storage and is carried by both normal and Continue requests. Unknown modes return `400 invalid_mode`; the provider, credentials, persistence, and streaming behavior are unchanged.

`GET /api/health` pings MongoDB and returns `503` when it is unavailable. `GET /` is a liveness response.

## Render deployment

The backend repo (`CrazyVillainFF/Vups-Router-BE`) is connected to the Render service behind `https://vups-router-be.onrender.com`. Pushing to `main` triggers a redeploy.

Render service settings:

- Environment: `Node`
- Build Command: `npm ci`
- Start Command: `npm start`
- Health Check Path: leave unset (default port check). Do **not** point it at `/api/health` — that route intentionally returns `503` when MongoDB is down, which would restart the service during a database blip.

Environment variables to set in the Render dashboard (Environment tab):

| Variable | Value |
| --- | --- |
| `MONGODB_URI` | your Atlas connection string, e.g. `mongodb+srv://user:pass@cluster0.xxxxx.mongodb.net/vupsrouter?retryWrites=true&w=majority` |
| `JWT_SECRET` | `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |
| `ENCRYPTION_SECRET` | a second, different value from the same command |
| `CLIENT_ORIGIN` | `https://vups-router-three.vercel.app` |
| `NODE_ENV` | `production` (required: enables Secure cookies and strict startup checks) |
| `TRUST_PROXY` | optional; defaults to `1` in production for Render/Vercel. Set to `false`, a hop count, or an Express trust-proxy value only when your proxy topology differs. |

Do **not** set `PORT`; Render provides it automatically. `SERVER` is not needed either. The service exits at startup if `JWT_SECRET` or `ENCRYPTION_SECRET` is missing, so set them before deploying.

MongoDB Atlas: under **Network Access**, allow `0.0.0.0/0` (Render's free tier does not publish static outbound IPs), and make sure the database user can read/write the `vupsrouter` database.

### Frontend connectivity and CORS origins

The backend serves every application route under `/api/*` (`/api/auth`, `/api/settings`, `/api/conversations`, `/api/chat`, `/api/admin`) and `GET /api` now returns a small JSON index with all route paths — a bare `/api` no longer looks like a broken backend. The frontend calls `/api/*` on its own Vercel origin, and `client/vercel.json` proxies that path here; absolute backend URLs are ignored by production client builds because the session cookie must stay first-party. Direct API clients should send the returned Bearer token instead of relying on cross-site cookies.

If the browser shows "Could not reach the VupsRouter backend at https://vups-router-be.onrender.com/api" **while `curl` to the same backend works**, the cause is almost always CORS: `curl` sends no `Origin` header, browsers do. When the frontend's origin is not in the allowlist, the backend rejects the request without CORS headers and the browser hides the response, so the frontend can only report a generic network error. The Render logs show `Origin not allowed by CORS` or `Request blocked: origin not allowed`.

Every Vercel URL of the project counts as a different origin: the production alias (`vups-router-three.vercel.app`), the branch URL (e.g. `vups-router-git-main-<team>.vercel.app`), and the per-deployment URL (e.g. `vups-router-<hash>-<team>.vercel.app`). Opening the app via the Vercel dashboard's deployment link uses the deployment URL.

Origin variables (Render → Environment; the server re-reads them on every request, but changing env vars restarts the service anyway):

| Variable | Meaning |
| --- | --- |
| `CLIENT_ORIGIN`, `CLIENT_ORIGINS`, `FRONTEND_ORIGIN`, `FRONTEND_ORIGINS` | exact origins, comma-separated, no trailing slash; both prefix families are accepted and merged |
| `CLIENT_ORIGIN_PATTERNS`, `FRONTEND_ORIGIN_PATTERNS` | wildcard origins, comma-separated; `*` matches one hostname label (`a-z`, `0-9`, `-`), e.g. `https://vups-router-*-vishnu-4571.vercel.app` covers both the branch and deployment URLs of that project |

Built-in defaults already include `http://localhost:5173`, `http://127.0.0.1:5173` (dev), `http://localhost:4173`, `http://127.0.0.1:4173` (vite preview), and `https://vups-router-three.vercel.app`.

Verify from anywhere (replace the origin): `curl -s -D - -o NUL https://vups-router-be.onrender.com/api/auth/me -H "Origin: https://your-origin"` must return an `access-control-allow-origin` header equal to that origin. `npm run verify` checks the same behavior locally, including a pattern-matched Vercel alias.

Verify after deploy: `curl https://vups-router-be.onrender.com/api/health` should return `"database":"connected"`. When it is down, the response includes a safe `reason` and `hint` (never credentials), and the Render logs contain the redacted underlying error:

| `reason` | Meaning | Fix |
| --- | --- | --- |
| `not_configured` | `MONGODB_URI` is empty or unset | add it in Render → Environment |
| `invalid_uri` | connection string is malformed | percent-encode special characters in the password: `@ → %40`, `: → %3A`, `/ → %2F`, `# → %23`, `? → %3F`, `% → %25`, space → `%20` |
| `auth_failed` | Atlas rejected the database user | Atlas → Database Access: correct username/password and role `Read and write to any database` (or `readWrite` on `vupsrouter`) |
| `dns_error` | cluster hostname does not resolve | copy the host exactly from Atlas → Connect → Drivers |
| `timeout` | TCP connection never established | Atlas → Network Access: allow `0.0.0.0/0` (Render's free tier has no static outbound IPs) and ensure the cluster is not paused |
| `unreachable` | connection refused/reset by the network | same Network Access check, and confirm the cluster is running |
| `unavailable` | any other driver error | read the Render logs — credentials are redacted automatically |

If `/api/health` returns `"reason":"timeout"` from Render, it is almost always Atlas Network Access, not an application bug.

Security: if a `.env` file was ever committed to this repo (it was, in the initial commit), rotate `JWT_SECRET` so the exposed session-signing value can no longer be used. Do not rotate `ENCRYPTION_SECRET` blindly: it decrypts every saved provider key. Use the key-rotation procedure below if that value was exposed.

### Provider-key encryption rotation

New secrets are stored as `v2:<key-id>:<iv>:<tag>:<ciphertext>` with AES-256-GCM. `ENCRYPTION_SECRET_PREVIOUS` is a comma-separated read-only keyring for migration, so old records remain usable while new writes move to the current key.

1. Back up the `providerconfigs` collection, or take an Atlas snapshot.
2. Set the new `ENCRYPTION_SECRET`, and set `ENCRYPTION_SECRET_PREVIOUS` to the old value.
3. Run `npm run rotate-provider-keys` to see how many records need migration (dry run, no writes).
4. Run `npm run rotate-provider-keys -- --apply`.
5. Verify sign-in and a saved provider, then remove `ENCRYPTION_SECRET_PREVIOUS`.

Rollback: restore the collection backup and set `ENCRYPTION_SECRET` back to the old value. Records that were already migrated are only readable with the new value, so a rollback of the secret alone is not sufficient after step 4.

## OpenRouter shared model (production)

When `OPENROUTER_API_KEY` is set, every registered user — including brand-new accounts — gets shared OpenRouter models with no personal key. The backend refreshes `GET /api/v1/models` every five minutes and offers every model whose `pricing.prompt` and `pricing.completion` are both zero and whose metadata advertises text output. It never assumes a `:free` suffix means free and never treats missing pricing as free. An explicit `OPENROUTER_MODELS` allowlist is optional; when set, only those IDs are eligible. Paid IDs work only when they are explicitly listed there; missing IDs remain unavailable. Automatic fallback is always free-only, so adding paid IDs never creates a silent paid retry.

The in-chat model menu groups free rows under "FREE MODELS" and explicitly enabled paid rows under "SHARED PAID MODELS", labels paid rows as using the shared server key, shows capability badges, and provides search across model names, providers, tags, and capabilities. OpenRouter takes precedence over the Ollama shared model (below); if no OpenRouter key is set, the Ollama shared model is used.

Catalog results are cached in memory (`OPENROUTER_CATALOG_TTL_MS`, default five minutes). On a transient refresh failure the last catalog is served for up to `OPENROUTER_CATALOG_STALE_MS` (default 24 hours) and marked stale; a rejected server key (`401`/`403`) is reported as `unauthorized` instead of serving stale models. A configured default that disappears is replaced by the first currently free model, and `defaultUnavailable` is reported. If no free chat model is available, shared chat is blocked with a clear error rather than pretending to work.

Shared chat tries the selected model once, then the configured fallback once, but only for model-availability or transient failures (`not_found`, `model_unavailable`, model-specific `rate_limited`, timeouts, network/provider outages, empty responses). It never retries invalid credentials, permission failures, malformed requests, account-wide free-quota exhaustion, or insufficient credits, and never falls back to a paid model. Streaming fallback happens before any SSE headers are sent, so clients never receive a partial answer from the failed model.

Environment variables (set in the Render dashboard):

| Variable | Value |
| --- | --- |
| `OPENROUTER_API_KEY` | your OpenRouter key (`sk-or-v1-...`). Server-side only; never commit it and never send it to the frontend. |
| `OPENROUTER_MODELS` | optional comma-separated allowlist of shared model IDs. When unset, all zero-price text chat models from the live catalog are offered. When set, paid IDs become available (they consume the shared key's credits); missing IDs are rejected before any upstream call. Use exact IDs from the catalog. |
| `OPENROUTER_DEFAULT_MODEL` | preferred default free model. Falls back to the first currently free chat model when missing. |
| `OPENROUTER_FALLBACK_MODEL` | preferred fallback free model. Falls back to the first different available free model. |
| `OPENROUTER_MODEL` | legacy alias for `OPENROUTER_DEFAULT_MODEL`; `OPENROUTER_DEFAULT_MODEL` wins when both are set. |
| `OPENROUTER_CATALOG_TTL_MS` | catalog cache lifetime in milliseconds; default `300000` (five minutes). |
| `OPENROUTER_CATALOG_STALE_MS` | maximum age of a cached catalog served during transient failures; default `86400000` (24 hours). |
| `OPENROUTER_MAX_OUTPUT_TOKENS` | `4096` (default) — maximum output tokens per shared reply. Clamped server-side to 8192. |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` (default; override only for testing). |
| `PROVIDER_TIMEOUT_MS` / `PROVIDER_STREAM_TIMEOUT_MS` | `60000` / `300000` (defaults) — upstream timeouts, both personal and shared providers. |

Behavior and safety:

- Chat goes through the existing authenticated `POST /api/chat` proxy; the browser never contacts OpenRouter directly and never sees the key, the base URL, or any provider response headers.
- Shared requests reuse all existing protections: auth, chat rate limiting, per-user daily quota (`AI_DAILY_QUOTA`), per-user concurrency cap (`AI_MAX_CONCURRENCY`), message validation, and the output-token cap above.
- Rate limits are distinguished: a model-specific rate limit returns `429 {"code":"shared_model_rate_limited"}` ("pick another shared model"), while account-wide free-quota exhaustion (OpenRouter `free-models-per-day` text or HTTP 402) returns `429 {"code":"shared_quota_exhausted"}` and explicitly says switching models will not help. Upstream key problems (401/403) map to `503 {"code":"shared_unavailable"}` and never instruct users to fix a personal key. No raw provider text or account details leak.
- Free OpenRouter models are shared across the whole account (roughly 50 free requests/day for accounts with under $10 balance), so the per-user daily quota protects the shared pool.
- Admins (`ADMIN_EMAILS`) can disable/re-enable the shared model at runtime: `POST /api/admin/shared-model {"enabled": false}`.
- Admins can verify the Render key and endpoint without inference at `GET /api/admin/openrouter/diagnostics`. It calls `GET {base}/key`, returns only authentication status and safe usage/limit fields, and never returns the key or authorization header. `POST /api/admin/openrouter/test-model {"model":"exact/id"}` sends one minimal chat request with that key and exact catalog ID; unknown or disabled IDs are rejected before any upstream call.
- In production, `OPENROUTER_BASE_URL` must be `https://openrouter.ai/api/v1`. Custom values are ignored unless `OPENROUTER_ALLOW_CUSTOM_BASE_URL=true`, preventing a wrong or unrelated upstream from being used accidentally.
- **401 checklist:** open `GET /api/admin/openrouter/diagnostics` while signed in as an admin. Confirm `baseUrl` is exactly `https://openrouter.ai/api/v1`, `authentication.status` is `authenticated`, and the intended model is present. Then test that exact ID with `POST /api/admin/openrouter/test-model`. An upstream message such as `unauthorized client detected` is not an OpenRouter error; it usually means requests are reaching a different gateway, so check `OPENROUTER_BASE_URL` and the selected saved provider before replacing the key. Never send the key to a browser or third-party diagnostic site.
- Automated tests cover zero-price filtering, missing/malformed pricing, cache refresh and stale fallback, unauthorized keys, explicit allowlists, non-streaming fallback, streaming fallback before headers, and no retries for account-wide quota failures. Live OpenRouter inference depends on the configured key, credits, and current provider availability; run the deployment check below before claiming a live success.
- Live check on 2026-10-20: the catalog returned 20 zero-price chat models; the configured key was accepted as a free-tier key; the default (`nvidia/nemotron-3.5-lightning:free`) and fallback (`cohere/north-mini-code:free`) probes both returned `finish_reason: stop` with `OK`. This is a point-in-time result, not a guarantee of future availability.

For a deploy sanity check, `node scripts/verify-openrouter.mjs` (with `OPENROUTER_API_KEY` in the environment) refreshes the live catalog, verifies that selected IDs are zero-price and chat-capable, then probes up to three models (default plus fallback) with a minimal chat completion. Set `OPENROUTER_MODELS` to probe every allowlisted ID or `OPENROUTER_VERIFY_PROBE_LIMIT` to change the dynamic sample size. It never prints the key and exits non-zero on any failure.

**Long responses & truncation.** The shared output limit defaults to `4096` tokens (`OPENROUTER_MAX_OUTPUT_TOKENS`, clamped server-side to `8192`). Every streaming reply forwards the provider's `finish_reason` in the final `done` SSE event (`stop`, `length`, …), plus token `usage` when the provider sends it. When a reply is cut off by the limit, the client keeps the partial answer, shows “Response reached its length limit”, and offers “Continue generating” — which asks the model to continue without repeating previous text. Code-generation prompts are instructed to split large projects into files and generate them in manageable stages.

**Error taxonomy.** Provider/model failures return safe, specific codes and are never labeled as database failures: `400` invalid request/model (`bad_request`, `not_found`, `invalid_model`), `401` bad credentials (`invalid_api_key`), `402` insufficient credits, `429` rate limits (`rate_limited`, `shared_model_rate_limited`, `shared_quota_exhausted`), `502` provider outage/endpoint rejection (`provider_unavailable`, `network_error`, `method_not_allowed` for upstream HTTP 405), `503` shared model unavailable (`shared_unavailable`, `shared_model_unavailable`), `504` timeout. Mid-stream provider errors arrive as `{ "type": "error" }` SSE events even though the HTTP status is already `200`. The database-unavailable message is only used for confirmed MongoDB connection/query failures.

## Vups v3 Galax (built-in, optional)

`Vups v3 Galax` (`vups-v3-galax`) is a first-party model served by this backend through an OpenAI-compatible upstream. It appears at the top of the in-chat model menu as a free, built-in default with no user API key; saved personal providers, shared OpenRouter models, and the OmniRoute gateway remain selectable in their own groups.

- Browser requests go to `POST /api/chat/vups-v3-galax`, never directly to the upstream. The browser sees only the public model ID and a safe `Default` badge.
- The system prompt is assembled server-side and cannot be supplied or replaced by the client. The `motion` mode appends a fixed motion-design instruction.
- `VUPS_BASE_URL`, `VUPS_API_KEY`, and `VUPS_UNDERLYING_MODEL` are private backend values. When all three are set, they take precedence. When none are set, Vups v3 Galax reuses the existing shared OpenRouter configuration (`OPENROUTER_API_KEY`, optional `OPENROUTER_BASE_URL`, and `OPENROUTER_DEFAULT_MODEL`) so a deployment with working shared models does not need duplicate credentials. Partial VUPS configuration or neither configuration returns `503 {"code":"vups_not_configured"}`; invalid clients cannot choose a different underlying model.
- Image requests route to `VUPS_VISION_MODEL` when it is set. With the shared OpenRouter fallback, the default is the free, vision-capable `nvidia/nemotron-3.5-super-vl:free`, while text-only chats keep using `OPENROUTER_DEFAULT_MODEL`/`OPENROUTER_MODEL`. This prevents the text-only default model from rejecting images. A dedicated `VUPS_*` deployment must set `VUPS_VISION_MODEL` to an image-capable model available at `VUPS_BASE_URL`, or set `VUPS_VISION=true` to explicitly mark the dedicated model itself as vision-capable. `VUPS_VISION=false` disables image requests; a dedicated image request without either setting returns `400 {"code":"vups_vision_unsupported"}` instead of assuming text models can see images. Vups chat itself never generates images; prompt-based generation is a separate, optional Cloudflare Workers AI endpoint described below.
- The route supports SSE streaming and non-streaming replies, persists normal conversation history, and uses the existing signed-in user, daily quota, and concurrency protections. Its rate limit defaults to 30 requests per minute per user and IP (`VUPS_CHAT_RATE_LIMIT_MAX`).
- Vups requests send an explicit output budget (`VUPS_MAX_OUTPUT_TOKENS`, default `24576`, capped at `32768`). Streaming responses emit SSE heartbeat comments every 15 seconds while waiting for model output, have a bounded response-start timeout, and use a reset-on-data idle timeout so long reasoning is not mistaken for a dead connection. Non-streaming requests use a separate per-attempt request timeout.
- A stream is only reported as complete after a terminal signal (`[DONE]`, a finish reason, Anthropic `message_stop`, or a Responses completed/incomplete event). If the upstream closes after partial text without that signal, the route saves the partial text, emits an SSE error event with `code: "vups_stream_interrupted"` and `partial: true`, and the client keeps the text, marks it incomplete, and offers Continue generating. A partial stream is never automatically restarted or reported as a successful completion.
- Transient upstream `429`/`5xx`/network failures are retried at most `VUPS_MAX_RETRIES` times (default 2) with bounded exponential backoff and jitter. Retries apply only before an SSE stream starts; a partial stream is never restarted. Upstream `Retry-After` is honored only when it fits `VUPS_RETRY_MAX_RETRY_AFTER_MS` (default 15000); otherwise the `429` is returned immediately with its original header.
- Every upstream HTTP failure emits one structured `provider_upstream_failure` JSON log line. It includes the backend request ID, attempt, provider host and endpoint path, model, HTTP status, safe provider fields (`provider_name`, `provider_error_code`, `limit_source`), a truncated and redacted provider detail, category, and retry decision. Retry and final-outcome lines use `vups_provider_retry` and `vups_provider_outcome`. Query strings, API keys, cookies, and raw request bodies are never logged.
- Every response includes `X-Request-Id`; Vups failures also include `requestId` in the JSON body (and SSE error event). SSE failures add safe `diagnostic` fields (`category`, `classification`, `retryable`, provider status/error code, limit source, phase, reason, character count, and duration) so an interrupted stream can be classified without exposing prompts or credentials. Use the request ID to find the matching Render log line. `GET /api/health` returns the deployed `release` commit, the active text/vision model and source, the effective output budget and stream limits, and feature flags so a stale deployment or wrong override is visible without exposing credentials.
- Exhausted free-model daily quotas or account credits are not retried and return `429 {"code":"vups_quota_exhausted"}` with guidance to wait for quota reset or configure a funded model. Ordinary request-rate `429` responses return `vups_rate_limited`, token-per-minute limits return `vups_token_rate_limited`, concurrency limits return `vups_concurrency_limited`, and upstream `503` responses remain `503 {"code":"vups_upstream_unavailable"}` instead of being reported as rate limits. Shared upstream saturation is never “fixed” by silently switching the user's selected model.
- Streaming, vision, and free-tier availability depend on the configured upstream model. The OpenRouter vision default is verified against the live catalog, but free-tier capacity can still be rate-limited; provide `VUPS_VISION_MODEL` to choose another compatible model.
- Run `npm run check:vups-vision` with the same environment to verify the configured image model against the endpoint's live `/models` catalog. It prints image-capable IDs, prioritizes free models, and never prints the API key. For dedicated deployments, set `VUPS_VISION_MODEL` to one of those IDs, or set `VUPS_VISION=true` only when the dedicated text model itself accepts images.

Environment variables (set in the Render dashboard, or omit the three upstream values to use the shared OpenRouter configuration):

| Variable | Value |
| --- | --- |
| `VUPS_BASE_URL` | optional private OpenAI-compatible base URL, for example `https://provider.example.com/v1`. Server-side only. |
| `VUPS_API_KEY` | optional private upstream key. Never expose, log, or commit it. |
| `VUPS_UNDERLYING_MODEL` | optional exact upstream model ID that serves Vups v3 Galax. |
| `VUPS_VISION` | optional `true` / `false` for a dedicated model. `true` marks the dedicated model as vision-capable; `false` disables image requests; unset requires `VUPS_VISION_MODEL`. |
| `VUPS_VISION_MODEL` | optional exact model ID for image requests. Defaults to `nvidia/nemotron-3.5-super-vl:free` when using the shared OpenRouter fallback. |
| `VUPS_CHAT_RATE_LIMIT_MAX` | optional requests per minute per user and IP; default `30`. |
| `VUPS_MAX_RETRIES` | optional retries for transient upstream failures before a stream starts; default `2`, capped at `5`. |
| `VUPS_RETRY_BASE_MS` | optional base delay for exponential retry backoff; default `500`. |
| `VUPS_RETRY_MAX_MS` | optional maximum single backoff delay; default `8000`. |
| `VUPS_RETRY_MAX_RETRY_AFTER_MS` | optional maximum accepted upstream `Retry-After`; longer values fail immediately; default `15000`. |
| `VUPS_MAX_OUTPUT_TOKENS` | optional output budget sent to the upstream model; default `24576`, clamped to `256..32768`. |
| `VUPS_REQUEST_TIMEOUT_MS` | optional per-attempt timeout for non-streaming Vups requests; default `300000`, clamped to `5000..600000`. |
| `VUPS_STREAM_START_TIMEOUT_MS` | optional timeout for upstream response headers; default `60000`, clamped to `5000..180000`. |
| `VUPS_STREAM_IDLE_TIMEOUT_MS` | optional maximum silence between upstream chunks; default `240000`, clamped to `15000..600000`. |
| `VUPS_SSE_HEARTBEAT_MS` | optional interval for SSE keepalive comments while waiting; default `15000`, clamped to `1000..60000`. |

### Production diagnosis checklist

1. Call `GET /api/health` and compare `release` with the commit that contains the behavior you expect. If `features.vupsDiagnostics` is absent or false, the backend is running an older build; redeploy before drawing conclusions from its error text.
2. Reproduce the Vups request and read the response's `X-Request-Id`. Find `provider_upstream_failure` with the same `requestId` in the Render logs.
3. Check `providerHost`, `model`, `httpStatus`, `providerName`, `providerErrorCode`, `limitSource`, `providerDetail`, and `category`. Do not infer quota from `429` alone; quota has a separate category and is not retried.
4. If `limitSource` is `upstream_provider_shared_pool`, the upstream provider is shared and saturated. Retry later, use a different configured model, or fund a dedicated model. VupsRouter cannot raise an upstream provider's pool limit.
5. For OpenRouter, admin diagnostics (`GET /api/admin/openrouter/diagnostics` and `/test-model`) verify the key and exact model without exposing the key. A production error body that does not match the current source tree means the deployment is stale.

## Image generation (Cloudflare Workers AI, optional)

`POST /api/images/generate` generates an image from a prompt with Cloudflare Workers AI model `@cf/black-forest-labs/flux-1-schnell`. It is separate from chat and from image understanding/vision: it never changes the selected chat model, and generated images are not persisted in conversation history.

- Requires a signed-in user, the existing per-user daily AI quota, concurrency protection, and an image-specific rate limit (default 5 requests per minute per user and IP).
- Prompts are trimmed and limited to 2,048 characters, matching the model schema. Missing configuration returns `503 {"code":"image_generation_not_configured"}` before consuming quota.
- The backend calls `POST https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/run/@cf/black-forest-labs/flux-1-schnell` with `Authorization: Bearer {CLOUDFLARE_API_TOKEN}`. This is the REST API, not the Worker-only `env.AI.run()` binding.
- The documented JSON response contains `result.image` as base64 JPEG. The backend also accepts a binary `image/*` response, validates the payload, and returns `{ "success": true, "image": "data:image/jpeg;base64,...", "mimeType": "image/jpeg", "model": "@cf/black-forest-labs/flux-1-schnell" }`.
- Cloudflare `401/403` maps to a safe `503` credential message, `429` maps to `429 image_generation_rate_limited`, timeouts to `504`, and other provider failures to `502`. No paid fallback is used, and a failed request never reports success.
- Credentials and prompts are never logged. The frontend only receives the generated data URL and safe error messages.
- Free Workers AI usage is quota-limited, not guaranteed. The frontend shows loading, error, download, and retry controls.

Environment variables:

| Variable | Value |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID. Server-side only. |
| `CLOUDFLARE_API_TOKEN` | Workers AI API token with Read/Edit permission. Never expose or commit it. |
| `CLOUDFLARE_AI_BASE_URL` | optional endpoint override, default `https://api.cloudflare.com/client/v4`. |
| `IMAGE_GENERATION_TIMEOUT_MS` | optional request timeout, default `45000` (5s–120s). |
| `IMAGE_GENERATION_RATE_LIMIT_MAX` | optional requests per minute per user and IP, default `5`. |

## Shared Ollama model (optional)

Every authenticated user — including brand-new accounts — gets one shared model without configuring a personal API key. Personal providers keep working unchanged; users simply pick the shared model in the model selector.

How it works:

- The backend proxies shared chat requests to an Ollama server using `POST {OLLAMA_BASE_URL}/v1/chat/completions` and checks availability with `GET {OLLAMA_BASE_URL}/api/tags`.
- `OLLAMA_BASE_URL` is a private, backend-only value. It is never sent to browsers, never appears in any API response, and must never be baked into frontend code.
- Availability is honest: if the server is unreachable, the model is missing, or the shared model is disabled, the API reports `unreachable` / `missing_model` / `disabled` instead of pretending it works. If `OLLAMA_BASE_URL` is unset, the status is `not_configured`.
- Shared requests go through the same authenticated `/api/chat` route as personal ones, so they share the existing auth, rate limiting (`CHAT_RATE_LIMIT_MAX` per minute), per-user daily quota (`AI_DAILY_QUOTA`), per-user concurrency cap (`AI_MAX_CONCURRENCY`), and message validation. Shared output is capped by `OLLAMA_MAX_OUTPUT_TOKENS` (default 1024).

Environment variables (set in the Render dashboard):

| Variable | Value |
| --- | --- |
| `OLLAMA_BASE_URL` | private URL of the Ollama server, e.g. `https://ollama-internal.example.com` or `http://10.0.0.5:11434`. Leave unset to disable the shared model entirely. |
| `OLLAMA_MODEL` | `gemma3:4b` (default). Must be installed on the Ollama server — the backend verifies this via `/api/tags`. |
| `OLLAMA_MAX_OUTPUT_TOKENS` | `1024` (default) — maximum output tokens per shared reply. |

### Deploying Ollama on a separate, persistent server

Do **not** run Ollama inside the existing Render web service. Render's free/standard web instances have ephemeral disks (the pulled model would vanish on every deploy) and are sized for HTTP workloads, not model inference.

1. Provision a separate machine with a persistent disk (any small VM from any cloud, an on-prem box, or a GPU host; `gemma3:4b` runs on CPU with ~4 GB RAM but is much faster with a GPU). Attach a persistent volume for model storage — models live in `~/.ollama` by default.
2. Install Ollama on that machine (Linux): `curl -fsSL https://ollama.com/install.sh | sh`, then run it as a service (`systemctl enable --now ollama`). Set `OLLAMA_HOST=0.0.0.0:11434` if the backend must reach it over the network, or keep it on `127.0.0.1:11434` behind a reverse proxy.
3. Pull the model once, on the Ollama host: `ollama pull gemma3:4b`. Verify: `curl http://127.0.0.1:11434/api/tags` lists `gemma3:4b`. Re-pull after any model change; the disk must persist across restarts.
4. Expose it **privately** to the backend only: terminate TLS at a reverse proxy (Caddy/nginx) or use a private network/VPN between the Render service and the Ollama host. Restrict inbound traffic to the backend (firewall allowlist, or a proxy that requires a secret header). Never expose the Ollama port publicly without authentication — it has no built-in auth.
5. Set `OLLAMA_BASE_URL` on Render to the private address, redeploy the backend, and verify:
   ```
   curl https://vups-router-be.onrender.com/api/health          # database still connected
   ```
   Sign in as any user and open the app — the model picker should list `gemma3:4b` under the "FREE MODELS" section (tagged "Free"), alongside any saved keys. `GET /api/settings/shared-model` (authenticated) reports `status: "available"` only when the model is actually installed and the server is reachable.
6. If the Ollama host is unreachable from Render (private network not routable), requests fail cleanly with `shared_unavailable`; users with personal providers are unaffected.

### Admin controls

Administrators (listed in `ADMIN_EMAILS`) can toggle the shared model for all users at runtime — no redeploy needed:

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/admin/shared-model` | current status (enabled/disabled + availability) |
| `POST` | `/api/admin/shared-model` | `{ "enabled": false }` disables the shared model for everyone; `true` re-enables |

Ordinary users receive `403` on all `/api/admin/*` routes, and the admin toggle is never exposed in the client UI.

## OmniRoute gateway (optional)

When enabled, the backend exposes a server-configured [OmniRoute](https://github.com/zorojean/omniroute) instance as an extra model group ("OMNIROUTE GATEWAY") in the in-chat model menu. Everything else — personal keys, the shared OpenRouter/Ollama model, auth, quotas, streaming — keeps working exactly as before. OmniRoute is additive: it is never required.

How it works:

- The backend discovers models with `GET {OMNIROUTE_BASE_URL}/v1/models` (Bearer key) and chats with `POST {OMNIROUTE_BASE_URL}/v1/chat/completions`. OmniRoute translates to whatever upstream providers it is configured with, so the backend only ever speaks the OpenAI-compatible schema.
- `OMNIROUTE_BASE_URL` and `OMNIROUTE_API_KEY` are backend-only values. They are never sent to browsers, never appear in any API response (not even masked), and are never logged. Clients can only send the fixed source marker `"omniroute"` — the backend whitelists it, and every request is resolved server-side. A client can never point the server at an arbitrary URL.
- A **personal OmniRoute provider** saved from Settings is separate from this server gateway: it uses the user's own encrypted API key and base URL, supports the same zero-inference Check and explicit Test model flow as any personal provider, and never falls back to `OMNIROUTE_API_KEY`.
- Model discovery is cached for 30 seconds. A gateway outage never hides saved or free models: the picker shows them as usual and only the gateway section reports the problem. When the gateway is enabled but unavailable, the picker shows one disabled informational row ("Server API key rejected", "Unreachable right now", …) instead of silently hiding it.
- Gateway requests go through the same authenticated `/api/chat` route, so they share auth, rate limiting (`CHAT_RATE_LIMIT_MAX`), per-user daily quota (`AI_DAILY_QUOTA`), per-user concurrency cap (`AI_MAX_CONCURRENCY`), and message validation. Streaming (SSE) and non-streaming both work.
- Failures are honest and actionable: `omniroute_disabled`, `omniroute_not_configured`, `omniroute_auth_failed`, `omniroute_rate_limited`, `omniroute_timeout`, `omniroute_unreachable`, `omniroute_model_unavailable`, `omniroute_upstream_error`, `omniroute_no_models`. A model that is no longer present upstream is rejected with `400 invalid_model` before any upstream call.

Environment variables:

| Variable | Value |
| --- | --- |
| `OMNIROUTE_BASE_URL` | Base URL of the OmniRoute instance, e.g. `http://localhost:20128`. Trailing `/v1`, endpoint paths, credentials, and query strings are rejected/reduced safely. |
| `OMNIROUTE_API_KEY` | API key OmniRoute expects as `Authorization: Bearer ...`. Server-side only — never commit it. |
| `OMNIROUTE_ENABLED` | Optional. `true`/`1`/`yes` force-enables, `false`/`0`/`no` force-disables (even when URL and key are set). Unset: the gateway is enabled automatically when both `OMNIROUTE_BASE_URL` and `OMNIROUTE_API_KEY` are present. |

Verify a deployment:

```
curl -H "Authorization: Bearer $OMNIROUTE_API_KEY" "$OMNIROUTE_BASE_URL/v1/models"
# then, authenticated as any user:
curl -H "Cookie: vr_session=..." https://your-backend/api/settings/omniroute/status
```

`GET /api/settings/omniroute/status` reports `provider`, `enabled`, `configured`, `available`, `status`, and `modelCount` — never the URL or key.

### Running OmniRoute locally

1. Start OmniRoute on its default port and configure at least one upstream provider inside it, then create/read its API key:
   ```
   omniroute --port 20128
   curl http://localhost:20128/v1/models -H "Authorization: Bearer <your-omniroute-key>"
   ```
2. Point the backend at it:
   ```
   OMNIROUTE_BASE_URL=http://localhost:20128
   OMNIROUTE_API_KEY=<your-omniroute-key>
   npm run dev
   ```
3. Sign in, open the model menu, and pick a model under "OMNIROUTE GATEWAY". The footer shows "OmniRoute gateway" while a gateway model is active.

**Production caveat:** a Render-hosted backend cannot reach `http://localhost:20128` (that is the Render container itself). For public deployments, either run the backend on the same machine/network as OmniRoute, expose OmniRoute at a reachable HTTPS URL with authentication, or leave the integration disabled. If the URL is unreachable, the gateway simply reports `unreachable` and nothing else breaks.

## Password recovery (Brevo email, six-digit code)

Email-based password reset with a six-digit one-time code and a short-lived,
single-use reset authorization.

Endpoints (all rate-limited per IP):

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| `POST` | `/api/forgot-password` | `{ "email": "user@example.com" }` | Always `{ "message": "If that email exists, we sent a 6-digit code.", "remaining": 3, "limit": 4 }` — identical for existing and nonexistent accounts (no enumeration). `503` if email delivery is not configured; `400` for an invalid email; `429` with `code: "reset_send_limit"` after `PASSWORD_RESET_SEND_LIMIT_MAX` (default 4) sends in the rolling 24 hours. |
| `POST` | `/api/verify-code` | `{ "email": "user@example.com", "code": "012345" }` | `{ "success": true, "message": "Code verified successfully.", "resetAuthorization": "<single-use token>" }`; `400` with a generic message for invalid, expired, or exhausted codes. |
| `POST` | `/api/reset-password` | `{ "email": "...", "code": "012345", "newPassword": "..." }` | `{ "success": true, "message": "Password updated successfully." }`; `400` with a generic message for invalid credentials, weak passwords, or mismatches. The client sends exactly `email` + `code` + `newPassword`; the optional `resetAuthorization` (from verify-code) and `confirmPassword` are still accepted for older clients. |

How it works:

- The six-digit code is generated with `crypto.randomInt(0, 1000000)` and padded to six characters, so codes like `004213` keep their leading zeroes.
- The database stores only a bcrypt hash of the code plus its expiry (10 minutes) — never the raw code.
- Verification issues a 256-bit random reset authorization (URL-safe) whose SHA-256 digest is stored on the account with its own 10-minute expiry. It is bound to that account, single-use, replaced whenever a new code is requested, and cleared on any successful reset.
- Wrong codes increment `resetAttempts` atomically; after 5 failed attempts the code is locked (a new code resets the counter).
- Code/authorization consumption + password update happen in one atomic `findOneAndUpdate`, so concurrent requests can never both succeed and a failed update never burns the credential.
- A successful reset sets `passwordChangedAt`, which invalidates sessions issued before the reset (JWT `iat` check in `requireAuth`).
- Passwords are hashed with the existing bcrypt mechanism (cost 12).
- If Brevo rejects the email (bad key, unverified sender, rate limit, network error), the HTTP status and the provider's response body are logged on the server, the just-issued code is invalidated, and the API still returns the generic response. The OTP itself is never logged.
- Resend limit: at most `PASSWORD_RESET_SEND_LIMIT_MAX` (default 4) codes are sent per email address in a rolling 24-hour window. The counter lives in MongoDB (`resetsendlogs`, keyed by a sha256 hash of the normalized address — no plaintext email), so it survives restarts, works across instances, and cannot be bypassed by refreshing the page. It applies identically to unknown addresses (no enumeration oracle), records the attempt before delivery (failed sends still count), and the check-and-record step is a single atomic conditional update, so concurrent requests cannot overshoot. Exceeding it returns `429 { "code": "reset_send_limit" }` with a `Retry-After` header.

### Brevo setup

1. Create a free Brevo account and verify the sender address `vupriseoffical@gmail.com` under **Senders, Domains & Dedicated IPs → Senders** (Brevo sends a confirmation email to it).
2. Create an API key under **SMTP & API → API Keys** and set `BREVO_API_KEY` in the Render dashboard (never commit it). If the key was rotated, update it here too and redeploy.
3. Set `SENDER_EMAIL=vupriseoffical@gmail.com` in the Render dashboard.
4. Redeploy and verify: `POST /api/forgot-password` with a real account email; the email arrives with a large six-digit code valid for 10 minutes.

Frontend flow (all inside `/forgot-password`): step 1 collects the email, step 2 renders the six animated code boxes (React Bits `CodeSlots`) for the six-digit code (with the remaining resend allowance and a plain-text-masked password toggle in the next step), step 3 collects the new password — reveal/hide toggles per field, an "At least 8 characters" hint, a "Passwords do not match" hint, and an Update button that is only disabled while submitting or while the inputs are too short/mismatched. The form submits exactly `{ email, code, newPassword }` and, on success, clears the recovery state and redirects to `/signin`. Mid-flow email and code survive a page refresh via `sessionStorage` (cleared on success or when the 10-minute code expiry passes). `/reset-password` redirects to `/forgot-password` for compatibility with old links. The sign-in form links to `/forgot-password`.

## Image attachments (vision chats)

Users can attach images (attach button, drag & drop, or paste) to the current
message. Attachments are converted to OpenAI-compatible content parts for the
provider and are **never stored in the database** — history keeps only
`{ name, mimeType, bytes }` metadata per image.

How a request flows:

1. The client validates type and size, reads each file to a base64 data URL,
   and sends `images` **on the final message only**: `{ name, mimeType, data }`
   (no data-URL prefix). API clients may instead send `{ name?, mimeType?, url }`
   with a public HTTPS image URL. Earlier messages must stay text-only (`400`
   otherwise).
2. The server re-validates everything: allowed types, base64 charset, per-image
   and total size limits, and the decoded bytes must match a real image
   signature (magic-byte sniffing �?" the declared MIME type is never trusted).
   URL attachments must use HTTPS, cannot contain credentials, and cannot target
   localhost, private, link-local, or metadata hosts. The server never fetches
   remote URLs; the upstream provider does.
3. Validated messages are serialized once in `providerClient.js` as
   `[{ type: "text" }, { type: "image_url", image_url: { url } }]`, where `url`
   is a data URL or the validated remote HTTPS URL. This works for OpenRouter,
   personal OpenAI-compatible providers, and the shared Ollama server's `/v1`
   compatibility endpoint. Anthropic receives native base64 or URL image
   sources, and Responses-compatible endpoints receive `input_image` parts.
4. Message content may be empty when at least one image is attached
   (image-only messages are supported). Remote URL attachments store metadata
   with `bytes: 0` and never download or persist the image.

Limits (defaults; configurable via env shown in `.env.example`):

| Env | Default | Meaning |
| --- | --- | --- |
| `CHAT_IMAGE_MAX_COUNT` | `4` | Images per message |
| `CHAT_IMAGE_MAX_BYTES` | `4194304` (4 MB) | Per image, decoded |
| `CHAT_IMAGE_MAX_TOTAL_BYTES` | `8388608` (8 MB) | Per message, decoded |

The global JSON limit stays at 512 kB; `POST /api/chat` uses its own parser
sized from the image limits (base64 inflates decoded bytes by ~4/3, plus text
headroom).

Vision capability is enforced server-side:

- **OpenRouter shared models**: read automatically from the model metadata
  (`architecture.input_modalities`). `OPENROUTER_VISION_MODELS` can force-enable
  specific IDs when metadata is missing.
- **Ollama shared model**: treated as text-only unless the ID is listed in
  `OLLAMA_VISION_MODELS` (Ollama does not report vision support).
- **Personal providers**: unknown, so requests are allowed and no capability
  claim is made; the provider's own error surfaces if it rejects the image.
- **Vups v3 Galax via OpenRouter fallback**: image requests use
  `VUPS_VISION_MODEL` or the free default `nvidia/nemotron-3.5-super-vl:free`;
  text requests keep the configured text model. Dedicated `VUPS_*` deployments
  must set `VUPS_VISION_MODEL` (or `VUPS_VISION=true` for the dedicated model).
  A provider response saying no endpoint supports image input is returned as
  `400` `vups_vision_rejected`, not as a missing model.
- Requesting images from a shared model without vision support returns `400`
  `model_no_vision` with the list of vision-capable shared models.

`GET /api/settings/models` includes `vision` and a `capabilities` object per
model. Capabilities are derived only from provider metadata: OpenRouter
`architecture`/`supported_parameters`, Gemini token limits and modality fields,
and equivalent declared fields from other providers. Missing metadata stays
unknown (`null`) instead of being guessed; unknown personal models are still
allowed to receive images and the provider's own error is surfaced. The client
shows known capability badges and warns before sending images to a model that
explicitly reports `vision: false`.

## Security notes

- Provider API keys are encrypted with authenticated AES-256-GCM using `ENCRYPTION_SECRET`; ciphertexts carry a versioned key ID and are never returned to the client in full. `v2` is current, legacy `v1` records remain readable, and rotation is scripted.
- Sessions are HTTP-only cookies; tokens are not stored in `localStorage` by the shipped client.
- Auth endpoints are rate-limited (30 requests / 15 min / IP); chat is limited to 30 requests / min.
- Requests are size-limited (512 kB JSON globally; `/api/chat` allows the image-attachment budget described above). Upstream JSON responses are capped at 4 MB; streamed assistant text is capped at 2 million characters. Conversation history is capped server-side. Image bytes are validated by magic bytes and never persisted.
- Provider URLs are checked for loopback/private/link-local/metadata destinations. In production the hostname is also DNS-resolved before use; redirects are followed only within the same origin, so credentials are never forwarded cross-origin and a public endpoint cannot redirect the backend into a private network.
- The proxy never substitutes a different model when the requested model fails; it returns the provider's error instead.
- Connection checks never run inference; only the explicitly confirmed Test model action sends a small prompt.


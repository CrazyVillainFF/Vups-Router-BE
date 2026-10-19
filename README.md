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
| `CLIENT_ORIGIN` / `CLIENT_ORIGINS` | yes | Allowed frontend origins (comma-separated, no trailing slash) |
| `MONGODB_URI` | yes | MongoDB connection string |
| `JWT_SECRET` | yes | Session token signing secret, >= 32 random characters |
| `ENCRYPTION_SECRET` | yes | AES-256-GCM key for encrypting user provider API keys, >= 32 random characters |
| `AI_DAILY_QUOTA` | no (default 100) | Per-user daily AI request quota (resets midnight UTC) |
| `AI_MAX_CONCURRENCY` | no (default 3) | Max simultaneous AI requests per user |
| `ADMIN_EMAILS` | no | Comma-separated account emails allowed to call `/api/admin/*` |

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

All state-changing requests must use `Content-Type: application/json`; requests from browsers with an unknown `Origin` are rejected. Authentication uses the HTTP-only `vr_session` cookie (`SameSite=None; Secure; Partitioned` in production, `Lax` in dev). A `Bearer` token from the signup/signin response is also accepted for API clients.

### Auth

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/api/auth/signup` | `{ name, email, password }` -> `201`, sets session cookie. `409` for duplicate email, `400` for invalid input |
| `POST` | `/api/auth/signin` | `{ email, password }` -> `200`, sets session cookie. `401` for invalid credentials |
| `POST` | `/api/auth/logout` | Clears the session cookie |
| `GET` | `/api/auth/me` | Returns the signed-in user (persistent login) |

### Provider configuration (authenticated)

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/settings/provider` | Returns config with a masked API key only |
| `PUT` | `/api/settings/provider` | `{ provider, baseUrl, apiKey?, model? }`. `apiKey` optional if one is already saved. Encrypts the key with AES-256-GCM |
| `DELETE` | `/api/settings/provider` | Deletes the configuration |
| `POST` | `/api/settings/provider/test` | Tests draft or saved config: lists models and optionally sends one minimal completion for the selected model |
| `GET` | `/api/settings/models` | Lists models from the saved provider (`GET {baseUrl}/models`) |

### DeepSeek quick start

DeepSeek is supported through the existing encrypted OpenAI-compatible provider flow — no code changes per provider:

1. Sign in, open **API settings**, click the **DeepSeek** quick-start chip (fills provider `DeepSeek`, base URL `https://api.deepseek.com`, model `deepseek-chat`).
2. Paste your DeepSeek API key (from platform.deepseek.com), **Save configuration**.
3. **Load models** to fetch the live model list from `GET /models`, pick a model, then **Test connection**.

The settings page shows a status badge: Configuration Required, Connected, Insufficient Balance, Model Unavailable, or Connection Failed. Chat requests go to `POST {baseUrl}/chat/completions` through the backend; the model is never silently substituted. Model listings also drive validation, so a model that was removed by the provider produces an actionable error instead of a mystery failure.

### Administration (requires `ADMIN_EMAILS`)

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/api/admin/ai-access` | `{ email, enabled }` — enable/disable AI chat for a user |
| `GET` | `/api/admin/user?email=` | Account status plus today's usage |

All admin routes return `403` unless the signed-in user's email is listed in `ADMIN_EMAILS`. Disabled users keep normal accounts but receive `403 ai_disabled` from `/api/chat`. Quota exhaustion returns `429 quota_exceeded`; too many parallel requests return `429 concurrency_limit`.

### Chat and history (authenticated)

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/api/chat` | `{ conversationId?, messages, model?, temperature?, stream? }`. Proxies to `{baseUrl}/chat/completions`. Streams SSE (`meta`, `delta`, `done`, `error` events) by default |
| `GET` | `/api/conversations` | Lists the user's conversations |
| `GET` | `/api/conversations/:id` | Full conversation with messages |
| `DELETE` | `/api/conversations/:id` | Deletes one conversation |

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
| `NODE_ENV` | `production` (required: enables Secure/Partitioned cookies and strict startup checks) |

Do **not** set `PORT`; Render provides it automatically. `SERVER` is not needed either. The service exits at startup if `JWT_SECRET` or `ENCRYPTION_SECRET` is missing, so set them before deploying.

MongoDB Atlas: under **Network Access**, allow `0.0.0.0/0` (Render's free tier does not publish static outbound IPs), and make sure the database user can read/write the `vupsrouter` database.

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

Security: if a `.env` file was ever committed to this repo (it was, in the initial commit), rotate `JWT_SECRET` and `ENCRYPTION_SECRET` so the exposed values can no longer be used.

## OpenRouter shared model (production)

When `OPENROUTER_API_KEY` is set, every registered user — including brand-new accounts — gets a shared OpenRouter model with no personal key. OpenRouter takes precedence over the Ollama shared model (below); if no OpenRouter key is set, the Ollama shared model is used.

Verified live (2026-10): `nvidia/nemotron-3.5-lightning:free` is available on OpenRouter and answered a streamed chat through this backend. The backend checks `GET /api/v1/models` and only reports `available` when the exact configured model ID is currently listed; otherwise the status is `missing_model` / `unreachable`, and chat is blocked with a clear error instead of pretending to work.

Environment variables (set in the Render dashboard):

| Variable | Value |
| --- | --- |
| `OPENROUTER_API_KEY` | your OpenRouter key (`sk-or-v1-...`). Server-side only; never commit it and never send it to the frontend. |
| `OPENROUTER_MODEL` | `nvidia/nemotron-3.5-lightning:free` (default). Any free chat model ID currently in the OpenRouter list works. |
| `OPENROUTER_MAX_OUTPUT_TOKENS` | `1024` (default) — maximum output tokens per shared reply. |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` (default; override only for testing). |
| `PROVIDER_TIMEOUT_MS` / `PROVIDER_STREAM_TIMEOUT_MS` | `60000` / `300000` (defaults) — upstream timeouts, both personal and shared providers. |

Behavior and safety:

- Chat goes through the existing authenticated `POST /api/chat` proxy; the browser never contacts OpenRouter directly and never sees the key, the base URL, or any provider response headers.
- Shared requests reuse all existing protections: auth, chat rate limiting, per-user daily quota (`AI_DAILY_QUOTA`), per-user concurrency cap (`AI_MAX_CONCURRENCY`), message validation, and the output-token cap above.
- OpenRouter quota exhaustion (HTTP 429/402) is handled safely: users get `429 {"code":"shared_quota_exhausted"}` — "The shared AI model is temporarily at capacity. Try again later, or connect your own provider." Upstream key problems (401/403) map to `503 {"code":"shared_unavailable"}` and never instruct users to fix a personal key. No raw provider text or account details leak.
- Free OpenRouter models are shared across the whole account (roughly 50 free requests/day for accounts with under $10 balance), so the per-user daily quota protects the shared pool.
- Admins (`ADMIN_EMAILS`) can disable/re-enable the shared model at runtime: `POST /api/admin/shared-model {"enabled": false}`.

For a deploy sanity check, `node scripts/verify-openrouter.mjs` (with `OPENROUTER_API_KEY` in the environment) confirms the model list, the key, and performs a minimal chat completion — it never prints the key.

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
   Sign in as any user and open the app — the model selector should show `gemma3:4b` labeled "Shared · no key needed". `GET /api/settings/shared-model` (authenticated) reports `status: "available"` only when the model is actually installed and the server is reachable.
6. If the Ollama host is unreachable from Render (private network not routable), requests fail cleanly with `shared_unavailable`; users with personal providers are unaffected.

### Admin controls

Administrators (listed in `ADMIN_EMAILS`) can toggle the shared model for all users at runtime — no redeploy needed:

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/admin/shared-model` | current status (enabled/disabled + availability) |
| `POST` | `/api/admin/shared-model` | `{ "enabled": false }` disables the shared model for everyone; `true` re-enables |

Ordinary users receive `403` on all `/api/admin/*` routes, and the admin toggle is never exposed in the client UI.

## Security notes

- Provider API keys are encrypted with authenticated AES-256-GCM using `ENCRYPTION_SECRET` and are never returned to the client in full.
- Sessions are HTTP-only cookies; tokens are not stored in `localStorage` by the shipped client.
- Auth endpoints are rate-limited (30 requests / 15 min / IP); chat is limited to 30 requests / min.
- Requests are size-limited (512 kB JSON) and avatar of conversations capped server-side.
- The proxy never substitutes a different model when the requested model fails; it returns the provider's error instead.

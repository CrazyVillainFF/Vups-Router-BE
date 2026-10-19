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

All state-changing requests must use `Content-Type: application/json`; requests from browsers with an unknown `Origin` are rejected. Authentication uses the HTTP-only `vr_session` cookie (`SameSite=None; Secure; Partitioned` in production, `Lax` in dev). A `Bearer` token from the signup/signin response is also accepted for API clients.

### Auth

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/api/auth/signup` | `{ name, email, password }` -> `201`, sets session cookie. `409` for duplicate email, `400` for invalid input |
| `POST` | `/api/auth/signin` | `{ email, password }` -> `200`, sets session cookie. `401` for invalid credentials |
| `POST` | `/api/auth/logout` | Clears the session cookie |
| `GET` | `/api/auth/me` | Returns the signed-in user (persistent login) |

### Provider configuration (authenticated)

Each user can save **multiple providers at once** — every provider is an isolated document (`{ userId, providerId }` unique) with its own encrypted key, base URL, enabled flag, and saved model list. Saving, editing, or deleting one provider never touches another. Exactly one provider is `active` per user; `/api/chat` uses it. Legacy single-config users are migrated in place on first read (the old document gains a `providerId` slug derived from its name, and the old `/provider` endpoints keep working).

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/settings/providers` | Lists all saved providers (masked keys only) plus `activeProviderId` |
| `PUT` | `/api/settings/providers/:providerId` | Upserts one provider: `{ provider, baseUrl, apiKey?, model?, providerType? }`. A brand-new provider becomes active; editing an existing one never steals the active slot. `providerId` must be a lowercase slug (`^[a-z0-9][a-z0-9-]{0,59}$`) |
| `POST` | `/api/settings/providers/:providerId/activate` | Makes this provider the one chat uses (only this provider's document is written) |
| `DELETE` | `/api/settings/providers/:providerId` | Deletes this provider only; if it was active, the most recently created remaining provider is promoted |
| `POST` | `/api/settings/providers/:providerId/test` | Tests the saved provider (or supplied `baseUrl`/`apiKey`/`model` overrides) and records the result |
| `PUT` | `/api/settings/providers/:providerId/models` | `{ models: string[], defaultModel? }` — validates length/uniqueness; `defaultModel` must be in the list |
| `GET` | `/api/settings/models?providerId=` | Lists models for that saved provider (`GET {baseUrl}/models`). Without `providerId` it uses the active provider. If live discovery fails, the saved model list is returned with a `warning` instead of being erased |

Legacy endpoints (`GET/PUT/DELETE /api/settings/provider`, `POST /api/settings/provider/test`) remain for backward compatibility and operate on the active provider.

### Provider quick start (any OpenAI-compatible service)

1. Sign in and open **Provider settings**. Any real provider with an OpenAI-compatible API works with no code changes per provider: OpenRouter, DeepSeek, Groq, Google Gemini (OpenAI-compat path), Mistral, Cohere, Together, Fireworks, Cerebras, NVIDIA NIM, xAI, SambaNova, Novita, plus self-hosted gateways (Ollama, vLLM, LocalAI, LM Studio, LiteLLM, FlagshipRouter) and custom endpoints.
2. Pick a provider card (or Add provider), paste your key, save. Repeat for as many providers as you want — each keeps its own key and models.
3. **Load models** to fetch the live list, select the ones to keep, choose a default, then **Test connection**.
4. **Use for chat** switches the active provider; chat requests go to `POST {baseUrl}/chat/completions` through the backend and the model is never silently substituted.

Notes:

- **Localhost / private-network URLs**: a deployed backend (Render, Railway, …) cannot reach `http://localhost:...` on your computer — for example a FlagshipRouter or Ollama instance. On production, such URLs are rejected with `400 local_endpoint` / `private_endpoint` and an explanation (use a public HTTPS tunnel like ngrok/Cloudflare Tunnel, or run VupsRouter locally). During development and tests the guard is off; `ALLOW_PRIVATE_PROVIDER_URLS=true` re-enables private URLs for self-hosted backends that share the network.
- **URL normalization**: trailing `/chat/completions`, `/completions`, or `/models` suffixes are stripped from the base URL automatically, so pasting a full endpoint URL does not produce a doubled path.
- **Network errors are specific**: `dns_error`, `connection_refused`, `network_error`, and `timeout` are reported with the target hostname — never as an "invalid API key".
- The settings page shows a status badge per provider (Connected, Invalid key, Insufficient balance, Unreachable, Not tested). Model listings drive validation: if a provider later removes a model, chat returns an actionable `invalid_model` error instead of a mystery failure.

### Administration (requires `ADMIN_EMAILS`)

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/api/admin/ai-access` | `{ email, enabled }` — enable/disable AI chat for a user |
| `GET` | `/api/admin/user?email=` | Account status plus today's usage |

All admin routes return `403` unless the signed-in user's email is listed in `ADMIN_EMAILS`. Disabled users keep normal accounts but receive `403 ai_disabled` from `/api/chat`. Quota exhaustion returns `429 quota_exceeded`; too many parallel requests return `429 concurrency_limit`.

### Chat and history (authenticated)

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/api/chat` | `{ conversationId?, messages, model?, temperature?, stream? }`. The final message may carry `images: [{ name?, mimeType, data }]` (base64, PNG/JPEG/WebP/GIF). Proxies to `{baseUrl}/chat/completions`. Streams SSE (`meta`, `delta`, `done`, `error` events) by default |
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

### Frontend connectivity and CORS origins

The backend serves every application route under `/api/*` (`/api/auth`, `/api/settings`, `/api/conversations`, `/api/chat`, `/api/admin`) and `GET /api` now returns a small JSON index with all route paths — a bare `/api` no longer looks like a broken backend. The frontend's `VITE_API_BASE_URL` must therefore end in `/api` (it already does: `https://vups-router-be.onrender.com/api`).

If the browser shows "Could not reach the VupsRouter backend at https://vups-router-be.onrender.com/api" **while `curl` to the same backend works**, the cause is almost always CORS: `curl` sends no `Origin` header, browsers do. When the frontend's origin is not in the allowlist, the backend rejects the request without CORS headers and the browser hides the response, so the frontend can only report a generic network error. The Render logs show `Origin not allowed by CORS` or `Request blocked: origin not allowed`.

Every Vercel URL of the project counts as a different origin: the production alias (`vups-router-three.vercel.app`), the branch URL (e.g. `vups-router-git-main-<team>.vercel.app`), and the per-deployment URL (e.g. `vups-router-<hash>-<team>.vercel.app`). Opening the app via the Vercel dashboard's deployment link uses the deployment URL.

Origin variables (Render → Environment; the server re-reads them on every request, but changing env vars restarts the service anyway):

| Variable | Meaning |
| --- | --- |
| `CLIENT_ORIGIN`, `CLIENT_ORIGINS` | exact origins, comma-separated, no trailing slash |
| `CLIENT_ORIGIN_PATTERNS` | wildcard origins, comma-separated; `*` matches one hostname label (`a-z`, `0-9`, `-`), e.g. `https://vups-router-*-vishnu-4571.vercel.app` covers both the branch and deployment URLs of that project |

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

Security: if a `.env` file was ever committed to this repo (it was, in the initial commit), rotate `JWT_SECRET` and `ENCRYPTION_SECRET` so the exposed values can no longer be used.

## OpenRouter shared model (production)

When `OPENROUTER_API_KEY` is set, every registered user — including brand-new accounts — gets shared OpenRouter models with no personal key. Up to four free models are offered in the in-chat model menu under "Shared · Free"; OpenRouter takes precedence over the Ollama shared model (below); if no OpenRouter key is set, the Ollama shared model is used.

Verified live: the enabled free models answer real chat completions through this backend. The backend checks `GET /api/v1/models` and only lists models that are currently available; if the configured default is missing, status is `missing_model` / `unreachable`, and chat is blocked with a clear error instead of pretending to work. Enabled-but-unavailable models are rejected with `shared_model_unavailable` and the error names an available alternative.

Note (live-testing history): `google/gemma-4-31b-it:free` is kept in the default set. Its upstream provider (Google AI Studio) has intermittently returned `429 temporarily rate-limited upstream` on chat probes while the rest of the catalog stayed healthy — that is a provider-side throttle reported honestly to users (`shared_model_rate_limited` with retry guidance), not an invalid model ID and not a reason to disable the model. `nvidia/nemotron-3-ultra-550b-a55b:free` remains available for operators to add via `OPENROUTER_MODELS`. Re-run `scripts/verify-openrouter.mjs` after any model-list change.

Environment variables (set in the Render dashboard):

| Variable | Value |
| --- | --- |
| `OPENROUTER_API_KEY` | your OpenRouter key (`sk-or-v1-...`). Server-side only; never commit it and never send it to the frontend. |
| `OPENROUTER_MODELS` | comma-separated list of enabled shared model IDs. Defaults to `nvidia/nemotron-3.5-lightning:free,nvidia/nemotron-3-super-120b-a12b:free,cohere/north-mini-code:free,google/gemma-4-31b-it:free`. Only these IDs are accepted from clients — anything else is rejected with `400 invalid_model` before any upstream call. |
| `OPENROUTER_MODEL` | `nvidia/nemotron-3.5-lightning:free` (default). Sets which enabled model is the default; it is automatically included in the enabled list. |
| `OPENROUTER_MAX_OUTPUT_TOKENS` | `4096` (default) — maximum output tokens per shared reply. Clamped server-side to 8192. |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` (default; override only for testing). |
| `PROVIDER_TIMEOUT_MS` / `PROVIDER_STREAM_TIMEOUT_MS` | `60000` / `300000` (defaults) — upstream timeouts, both personal and shared providers. |

Behavior and safety:

- Chat goes through the existing authenticated `POST /api/chat` proxy; the browser never contacts OpenRouter directly and never sees the key, the base URL, or any provider response headers.
- Shared requests reuse all existing protections: auth, chat rate limiting, per-user daily quota (`AI_DAILY_QUOTA`), per-user concurrency cap (`AI_MAX_CONCURRENCY`), message validation, and the output-token cap above.
- Rate limits are distinguished: a model-specific rate limit returns `429 {"code":"shared_model_rate_limited"}` ("pick another shared model"), while account-wide free-quota exhaustion (OpenRouter `free-models-per-day` text or HTTP 402) returns `429 {"code":"shared_quota_exhausted"}` and explicitly says switching models will not help. Upstream key problems (401/403) map to `503 {"code":"shared_unavailable"}` and never instruct users to fix a personal key. No raw provider text or account details leak.
- Free OpenRouter models are shared across the whole account (roughly 50 free requests/day for accounts with under $10 balance), so the per-user daily quota protects the shared pool.
- Admins (`ADMIN_EMAILS`) can disable/re-enable the shared model at runtime: `POST /api/admin/shared-model {"enabled": false}`.

For a deploy sanity check, `node scripts/verify-openrouter.mjs` (with `OPENROUTER_API_KEY` in the environment) checks every enabled model against the live catalog and performs a minimal chat completion with each — it never prints the key and exits non-zero if any model is missing or not responding.

**Long responses & truncation.** The shared output limit defaults to `4096` tokens (`OPENROUTER_MAX_OUTPUT_TOKENS`, clamped server-side to `8192`). Every streaming reply forwards the provider's `finish_reason` in the final `done` SSE event (`stop`, `length`, …), plus token `usage` when the provider sends it. When a reply is cut off by the limit, the client keeps the partial answer, shows “Response reached its length limit”, and offers “Continue generating” — which asks the model to continue without repeating previous text. Code-generation prompts are instructed to split large projects into files and generate them in manageable stages.

**Error taxonomy.** Provider/model failures return safe, specific codes and are never labeled as database failures: `400` invalid request/model (`bad_request`, `not_found`, `invalid_model`), `401` bad credentials (`invalid_api_key`), `402` insufficient credits, `429` rate limits (`rate_limited`, `shared_model_rate_limited`, `shared_quota_exhausted`), `502` provider outage (`provider_unavailable`, `network_error`), `503` shared model unavailable (`shared_unavailable`, `shared_model_unavailable`), `504` timeout. Mid-stream provider errors arrive as `{ "type": "error" }` SSE events even though the HTTP status is already `200`. The database-unavailable message is only used for confirmed MongoDB connection/query failures.

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
   Sign in as any user and open the app — the model selector should show `gemma3:4b` labeled "Shared · Free · No API key needed". `GET /api/settings/shared-model` (authenticated) reports `status: "available"` only when the model is actually installed and the server is reachable.
6. If the Ollama host is unreachable from Render (private network not routable), requests fail cleanly with `shared_unavailable`; users with personal providers are unaffected.

### Admin controls

Administrators (listed in `ADMIN_EMAILS`) can toggle the shared model for all users at runtime — no redeploy needed:

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/admin/shared-model` | current status (enabled/disabled + availability) |
| `POST` | `/api/admin/shared-model` | `{ "enabled": false }` disables the shared model for everyone; `true` re-enables |

Ordinary users receive `403` on all `/api/admin/*` routes, and the admin toggle is never exposed in the client UI.

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
   (no data-URL prefix). Earlier messages must stay text-only (`400` otherwise).
2. The server re-validates everything: allowed types, base64 charset, per-image
   and total size limits, and the decoded bytes must match a real image
   signature (magic-byte sniffing — the declared MIME type is never trusted).
3. Validated messages are serialized once in `providerClient.js` as
   `[{ type: "text" }, { type: "image_url", image_url: { url: "data:…" } }]`,
   which works for OpenRouter, personal OpenAI-compatible providers, and the
   shared Ollama server's `/v1` compatibility endpoint.
4. Message content may be empty when at least one image is attached
   (image-only messages are supported).

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
- Requesting images from a shared model without vision support returns `400`
  `model_no_vision` with the list of vision-capable shared models.

`GET /api/settings/models` includes a `vision` flag per model (`true`/`false`
for shared models, `null` for personal ones) so the client can warn before
sending.

## Security notes

- Provider API keys are encrypted with authenticated AES-256-GCM using `ENCRYPTION_SECRET` and are never returned to the client in full.
- Sessions are HTTP-only cookies; tokens are not stored in `localStorage` by the shipped client.
- Auth endpoints are rate-limited (30 requests / 15 min / IP); chat is limited to 30 requests / min.
- Requests are size-limited (512 kB JSON globally; `/api/chat` allows the image-attachment budget described above). Conversation history is capped server-side. Image bytes are validated by magic bytes and never persisted.
- The proxy never substitutes a different model when the requested model fails; it returns the provider's error instead.

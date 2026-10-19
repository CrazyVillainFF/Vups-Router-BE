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

Verify after deploy: `curl https://vups-router-be.onrender.com/api/health` should return `"database":"connected"`. If it returns `"reason":"auth_failed"` / `"dns_error"` / `"timeout"`, the `hint` field tells you exactly what to fix in Atlas.

Security: if a `.env` file was ever committed to this repo (it was, in the initial commit), rotate `JWT_SECRET` and `ENCRYPTION_SECRET` so the exposed values can no longer be used.

## Security notes

- Provider API keys are encrypted with authenticated AES-256-GCM using `ENCRYPTION_SECRET` and are never returned to the client in full.
- Sessions are HTTP-only cookies; tokens are not stored in `localStorage` by the shipped client.
- Auth endpoints are rate-limited (30 requests / 15 min / IP); chat is limited to 30 requests / min.
- Requests are size-limited (512 kB JSON) and avatar of conversations capped server-side.
- The proxy never substitutes a different model when the requested model fails; it returns the provider's error instead.

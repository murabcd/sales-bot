---
summary: "Gateway admin UI (Next.js)"
read_when:
  - You want a simple control panel for Omni
---
# Admin UI

The admin UI is a minimal Next.js app under `apps/admin`.

## Setup

1) Install deps in the admin app:

```
cd apps/admin
bun install
```

2) Configure the API base URL (optional):

```
cp .env.example .env.local
```

By default, the UI derives the gateway base URL from the current host and
persists overrides in `localStorage`. If you deploy the admin UI separately,
set `NEXT_PUBLIC_ADMIN_API_BASE` to your Worker URL (for example, a local
Wrangler dev URL).

3) Run dev:

```
bun run dev
```

## Gateway connection

The UI connects to the gateway over WebSocket at `/gateway` and uses RPC-style
methods:

- `connect` (auth + status snapshot)
- `config.get` / `config.set` (edit settings)
- `cron.run` (manual daily report)
- `chat.send` (admin chat, streaming)
- `chat.abort` (cancel in-flight admin chat)

HTTP endpoints (`GET /admin/status`, `POST /admin/cron/run`) remain available for
fallback and debugging, but the UI uses WebSocket by default.

Auth is required via `ADMIN_API_TOKEN` (entered in the UI). The gateway checks
`ADMIN_ALLOWLIST` if it is set.

## Admin chat

The chat panel streams responses from the bot pipeline (same tools, prompts, and
policies as Telegram). It is meant for debugging and does not persist history.

- Streaming: UI uses AI SDK `useChat` with a gateway transport.
- Markdown: assistant messages render via Streamdown.
- Tool visibility: tool calls are surfaced as `Tools: ...` hints during streams.
- Image prompts: attach one or more images (PNG/JPEG/GIF/WebP) and optionally add a caption.
- Web search: the Search toggle defaults from `WEB_SEARCH_ENABLED` and can be overridden per message.

Stopping a response uses `chat.abort`, which cancels the in-flight stream.

## Image generation (Gemini + R2)

Admin chat and Telegram can render generated images when the Gemini image tool is enabled and R2
storage is configured. The worker signs image URLs and serves them via `GET /media/<key>`.

Required env (Worker):
- `IMAGE_SIGNING_SECRET` (secret; used to sign URLs)
- `PUBLIC_BASE_URL` (public worker URL, no trailing slash)
- `IMAGE_RETENTION_DAYS` (optional, defaults to 7)

The R2 bucket binding is `omni` (see `worker/wrangler.toml`).

## Skills

The sidebar includes a Skills view that loads a live skills status report from
the gateway over WebSocket (`skills.status`). It supports enabling/disabling
skills (`skills.update`). Credential requirements are handled via global env
values rather than per-skill API keys. Skills are grouped by tool server (for
example, yandex-tracker).

## Sessions and Cron

The Sessions page shows live gateway connection counts and active streams pulled
from the status snapshot. Cron shows the current schedule configuration.

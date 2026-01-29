---
summary: "Telegram bot configuration and webhook behavior for Omni"
read_when:
  - Working on Telegram commands or webhook delivery
---
# Telegram

Omni uses grammY with a Telegram Bot API token. In production it runs as a
Cloudflare Workers webhook; locally it can use long‑polling via `bun dev`.

## Required env vars

- `BOT_TOKEN` — Telegram bot token from @BotFather
- `ALLOWED_TG_IDS` — comma‑separated allowlist of numeric Telegram user IDs

Optional:
- `TELEGRAM_TIMEOUT_SECONDS` (default: 60)
- `TELEGRAM_TEXT_CHUNK_LIMIT` (default: 4000)
- `DEBUG_LOGS` (set `1` to enable)

## Webhook (Cloudflare Workers)

Webhook path is fixed to `/telegram`:

```
https://api.telegram.org/bot<YOUR_TOKEN>/setWebhook?url=https://<worker>.workers.dev/telegram
```

To verify:

```
https://api.telegram.org/bot<YOUR_TOKEN>/getWebhookInfo
```

## Local dev (polling)

```
bun dev
```

This starts long‑polling and ignores the webhook.

## Formatting

Outbound messages are sent as Telegram HTML. The bot converts `**bold**`
to `<b>bold</b>` and escapes other HTML for safety.

Transient send errors are retried with backoff. If Telegram rejects the HTML
formatting, the bot falls back to plain text.

## Attachments

- Images are supported from `message:photo`.
- PDF and DOCX documents are supported from `message:document`.
- Non-PDF/DOCX documents are ignored (reply: "Поддерживаются только PDF или DOCX документы.").
- Direct chat uploads are read automatically.
- Tracker issue attachments (PDF/DOCX) and Google Docs/Sheets links are offered after the first answer and read only with explicit consent.

Limits:
- `IMAGE_MAX_BYTES` (default: 5MB)
- `DOCUMENT_MAX_BYTES` (default: 10MB)
- `ATTACHMENT_MAX_BYTES` (default: 8MB, max size to read Tracker attachments)

# Telegram

## Group allowlist + mention gating

Set these environment variables:

```
ALLOWED_TG_GROUPS="-1001234567890,-1009876543210"
TELEGRAM_GROUP_REQUIRE_MENTION=1
```

Behavior:
- If `ALLOWED_TG_GROUPS` is set, only those groups are accepted.
- If `TELEGRAM_GROUP_REQUIRE_MENTION=1`, the bot only responds in groups when:
  - the message mentions the bot (`@botname`), or
  - the user replies to a bot message.

To allow all groups, set `ALLOWED_TG_GROUPS=""`.
To disable mention gating in groups, set `TELEGRAM_GROUP_REQUIRE_MENTION=0`.

## Reply threading

The bot replies to the triggering message in Telegram (uses `reply_to_message_id`)
so conversations stay threaded in groups and channels.

## Webhook reliability

The Cloudflare Worker acknowledges webhooks immediately and defers processing
to a Durable Object queue with retries and backoff. This avoids Telegram webhook
timeouts while preserving at-least-once delivery.

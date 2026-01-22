# Logging

This project uses **wide events**: one structured JSON log line per Telegram update.

## Why wide events

- Easier to debug a single update end-to-end.
- High-cardinality IDs make it easy to find specific users/updates.
- Consistent fields enable analytics and alerting.

## Log shape (wide event)

Every update emits one `telegram_update` event from middleware:

```json
{
  "timestamp": "2026-01-22T18:04:12.345Z",
  "level": "info",
  "service": "omni",
  "version": "1.0.0",
  "commit_hash": "a1b2c3d",
  "region": "us-east-1",
  "instance_id": "i-123",
  "event": "telegram_update",
  "request_id": "tg:123456789:987654321",
  "update_id": 123456789,
  "update_type": "message",
  "chat_id": 987654321,
  "user_id": 111222333,
  "username": "alice",
  "message_type": "text",
  "command": "/help",
  "tool": "issues_find",
  "model_ref": "primary",
  "model_id": "gpt-4.1-mini",
  "issue_key": "PROJ-123",
  "issue_key_count": 1,
  "outcome": "success",
  "status_code": 200,
  "duration_ms": 842
}
```

### Required fields

At minimum, each wide event should include:
- `timestamp`, `level`, `event`
- `request_id`, `update_id`, `update_type`
- `chat_id`, `user_id`
- `outcome`, `status_code`, `duration_ms`

### Optional fields

- Business context: `command`, `tool`, `issue_key`, `issue_key_count`
- Model context: `model_ref`, `model_id`
- Deployment context: `service`, `version`, `commit_hash`, `region`, `instance_id`

## Environment fields

These values are injected into every log line when set:

- `SERVICE_NAME`
- `RELEASE_VERSION` or `APP_VERSION`
- `COMMIT_HASH` or `GIT_COMMIT`
- `REGION`
- `INSTANCE_ID`

## Debug logs

`DEBUG_LOGS=1` enables extra structured debug events (event=`debug`).
Leave this off in production unless you are actively investigating an issue.

## Do not log secrets

Never log tokens, passwords, API keys, or raw user PII.
If you need to log user context, prefer stable identifiers (`user_id`, `chat_id`).

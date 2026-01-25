---
summary: "OpenAI provider configuration for Omni"
read_when:
  - Setting or rotating OpenAI credentials
  - Changing the default model
---
# OpenAI

Omni uses OpenAI via the AI SDK. Provide an API key and optionally override
the model.

## Required env var

- `OPENAI_API_KEY`

## Model selection

Default models and fallbacks live in `apps/bot/config/models.json`.

Override at runtime with:

```
OPENAI_MODEL=openai/gpt-4o-mini
```

## Notes

- Use `openai/<id>` format for explicit model refs.
- If `OPENAI_MODEL` is unset, the configured default is used.

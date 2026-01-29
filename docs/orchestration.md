---
summary: "Sub-agent orchestration and model overrides"
read_when:
  - Tuning sub-agent performance or costs
  - Overriding sub-agent models/providers
---
# Orchestration (sub-agents)

Omni can spawn sub-agents for specialized work (tracker/jira/posthog/web/memory).
Sub-agents default to the same model as the main agent, but you can override
model and provider.

## Defaults via env

Set global defaults for all sub-agents:

```
SUBAGENT_MODEL_PROVIDER="google"
SUBAGENT_MODEL_ID="gemini-2.5-flash"
```

Providers supported:
- `openai`
- `google` (Gemini)

If `SUBAGENT_MODEL_PROVIDER=google`, ensure `GEMINI_API_KEY` is set.

## Per-agent overrides

Use `AGENT_CONFIG_OVERRIDES` to override specific sub-agents:

```
AGENT_CONFIG_OVERRIDES='{
  "web": { "provider": "google", "modelId": "gemini-2.5-flash" },
  "tracker": { "provider": "openai", "modelId": "gpt-5.2" }
}'
```

Supported keys:
- `provider`: `"openai"` or `"google"`
- `modelId`: provider-specific model id
- `maxSteps`, `timeoutMs`, `instructions`

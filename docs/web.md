# Web Search

This bot can optionally use OpenAI's native web search tool to answer
up-to-date questions outside Yandex Tracker (news, public facts, prices).

## Enable

Set these environment variables:

```
WEB_SEARCH_ENABLED=1
WEB_SEARCH_CONTEXT_SIZE=low
```

`WEB_SEARCH_CONTEXT_SIZE` can be `low`, `medium`, or `high`.

## Behavior

- When enabled, the agent can call the `web_search` tool.
- The reply should include a short Sources list with URLs when web search is used.
- If disabled, the tool is not exposed to the agent.

## Notes

- Requires an OpenAI model that supports the native web search tool.
- This is separate from Yandex Tracker tools; it is only for public, external info.

---
summary: "Tool visibility and conflict handling in Omni"
read_when:
  - Adding tools or changing tool availability
  - Debugging missing tools in /tools
---
# Tool policy and conflicts

## Tool availability rules

Omni builds a tool registry at runtime and applies these rules:

- Tool names are normalized (trimmed + lowercased). Aliases are supported (e.g. `apply-patch` → `apply_patch`).
- Duplicate tool names are rejected. The first tool wins; later duplicates are skipped and logged.
- Tool availability can be filtered by a global allow/deny policy (see Environment variables).
- Tool availability can also be filtered by chat type using chat‑specific allow/deny lists.
- Group chats always deny `group:web` and `group:memory` unless explicitly overridden in code.

The `/tools` command shows active tools and also lists conflicts and policy‑suppressed tools.

## Environment variables

Use these to filter tools:

- `TOOL_ALLOWLIST` — comma‑separated tool names or groups to allow.
- `TOOL_DENYLIST` — comma‑separated tool names or groups to deny.
- `TOOL_ALLOWLIST_DM` / `TOOL_DENYLIST_DM` — overrides for 1‑1 chats.
- `TOOL_ALLOWLIST_GROUP` / `TOOL_DENYLIST_GROUP` — overrides for group chats.
- `TOOL_RATE_LIMITS` — per‑tool rate limits in `tool:max/windowSeconds` format (comma‑separated).
- `TOOL_APPROVAL_REQUIRED` — comma‑separated list of tools that require `/approve` before use.
- `TOOL_APPROVAL_TTL_MS` — approval TTL in milliseconds (default 600000).
- `TOOL_APPROVAL_STORE_PATH` — path to the approvals JSON file (default `data/approvals/approvals.json`).
- `TOOL_ALLOWLIST_USER_IDS` / `TOOL_DENYLIST_USER_IDS` — allow/deny tools for specific user ids.
- `TOOL_ALLOWLIST_USER_TOOLS` / `TOOL_DENYLIST_USER_TOOLS` — per‑user tool allow/deny lists.
- `TOOL_ALLOWLIST_CHAT_TOOLS` / `TOOL_DENYLIST_CHAT_TOOLS` — per‑chat tool allow/deny lists.

If `TOOL_ALLOWLIST` is set, only those tools/groups are enabled. The deny list is applied afterward.
Chat‑specific allow/deny lists are merged on top of the base lists.

Supported groups:

- `group:web` → `web_search`
- `group:tracker` → Tracker tools (`tracker_search`, `issues_find`, `issue_get`, `issue_get_comments`, `issue_get_url`)
- `group:jira` → Jira tools (`jira_search`, `jira_issues_find`, `jira_issue_get`, `jira_issue_get_comments`, `jira_sprint_issues`)
- `group:posthog` → PostHog read-only tools
- `group:memory` → Supermemory tools (`searchMemories`, `addMemory`)
- `group:runtime-skills` → reserved

Examples:

```
TOOL_ALLOWLIST=group:tracker,group:memory
TOOL_DENYLIST=web_search
TOOL_ALLOWLIST_GROUP=group:tracker
TOOL_RATE_LIMITS=web_search:10/60,tracker_search:20/60
TOOL_APPROVAL_REQUIRED=web_search
TOOL_APPROVAL_TTL_MS=600000
TOOL_APPROVAL_STORE_PATH=data/approvals/approvals.json
TOOL_ALLOWLIST_USER_TOOLS=187873791:web_search|jira_search
TOOL_DENYLIST_CHAT_TOOLS=-1001234567890:group:web
```

## Conflict diagnostics

When a conflict occurs, Omni logs a `tool_conflict` event and skips the duplicate tool. Use `/tools` to see the conflicts summary.

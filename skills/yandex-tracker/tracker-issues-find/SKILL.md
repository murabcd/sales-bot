---
name: tracker-issues-find
description: Runtime skill to search Yandex Tracker issues by query.
---

# tracker-issues-find

Uses the MCP tool `yandex-tracker.issues_find`.

Defaults
- `fields`: `key`, `summary`, `created_at`
- `per_page`: `50`

Telegram usage
```
/skill tracker-issues-find {"query":"Assignee: me"}
```

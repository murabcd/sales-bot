---
name: yandex-tracker
description: MCP tools map + usage notes for Yandex Tracker.
---

# yandex-tracker

This skill documents the MCP tools exposed by the Yandex Tracker server and how to use them via runtime skills or `mcporter`.

Quick start
- List tools: `mcporter list yandex-tracker --schema`
- Call a tool: `mcporter call yandex-tracker.issues_find --args '{"query":"Assignee: me"}'`
- Telegram: `/skill <name> <json>`

Runtime skills
- Each tool can be wrapped as a runtime skill in `skills/<name>/skill.json`.
- The `tool` field supports `yandex-tracker.<tool_name>`.

Available MCP tools

Queue Management
- `queues_get_all`
- `queue_get_tags`
- `queue_get_versions`
- `queue_get_fields`
- `queue_get_metadata`

User Management
- `users_get_all`
- `user_get`
- `user_get_current`
- `users_search`

Field Management
- `get_global_fields`

Status and Type Management
- `get_statuses`
- `get_issue_types`
- `get_priorities`
- `get_resolutions`

Issue Operations
- `issue_get`
- `issue_get_url`
- `issue_get_comments`
- `issue_get_links`
- `issue_get_worklogs`
- `issue_get_attachments`
- `issue_get_checklist`
- `issue_get_transitions`
- `issue_execute_transition`
- `issue_close`
- `issue_create`
- `issue_update`

Search and Discovery
- `issues_find`
- `issues_count`

---
summary: "Runtime skills for Omni"
read_when:
  - Adding or using runtime skills
---
# Skills

Omni loads runtime skills from `apps/bot/skills/**/skill.json` at startup. These are
shortcuts for calling Tracker tools with predefined arguments.

Notes:

- Skill names are normalized (trim + lowercase). Duplicate names are skipped.
- Duplicate tool references are skipped (same `server:tool` after normalization).

## Format

Each skill lives in its own folder with:

- `skill.json` — name, tool, args, timeout
- `SKILL.md` — human‑readable docs

Example `skill.json`:

```json
{
  "name": "issues_find",
  "description": "Search Tracker issues",
  "tool": "yandex-tracker.issues_find",
  "args": { "query": "Assignee: me" }
}
```

## Usage in Telegram

- `/skills` — list available runtime skills
- `/skill <name> <json>` — run a skill with optional JSON overrides

Example:

```
/skill issues_find {"query":"Assignee: me"}
```

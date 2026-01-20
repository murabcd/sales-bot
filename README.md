# Sales Bot (grammY + MCP)

Telegram bot using grammY and the Model Context Protocol (MCP) to call Yandex Tracker tools via the `yandex-tracker-mcp` server.

## Prereqs
- Node.js 18+
- `uvx` available in your PATH

## Setup

```bash
npm install
```

Create a `.env` file, or export env vars:

```bash
BOT_TOKEN=your_telegram_bot_token
TRACKER_TOKEN=your_tracker_token_here
TRACKER_CLOUD_ORG_ID=your_cloud_org_id_here
ALLOWED_TG_IDS=187873791
TELEGRAM_TIMEOUT_SECONDS=60
TELEGRAM_TEXT_CHUNK_LIMIT=4000
DEBUG_LOGS=0
OPENAI_API_KEY=your_openai_api_key
OPENAI_MODEL=openai/gpt-5.2
DEFAULT_TRACKER_QUEUE=PROJ
DEFAULT_ISSUE_PREFIX=PROJ
SESSION_DIR=data/sessions
HISTORY_MAX_MESSAGES=20
```

Create MCPorter config at `config/mcporter.json` (already included in this repo).

Note: `ALLOWED_TG_IDS` is required. The bot refuses to start if the allowlist is empty.

## Models

Model catalog is defined in `config/models.json` with a primary model and fallbacks.
Override the primary model at runtime with `OPENAI_MODEL` (use either `openai/<id>` or just `<id>`).

## Run

```bash
npm run dev
```

## Commands
- `/start` - intro
- `/help` - usage
- `/tools` - list MCP tools exposed by Yandex Tracker
- `/status` - MCP health check + uptime
- `/model` - show current model and fallbacks
- `/model list` - list available models
- `/model set <ref>` - switch model for this session
- `/model reasoning <level>` - set reasoning level (off|low|standard|high)
- `/skills` - list runtime skills
- `/skill <name> <json>` - run a runtime skill
- `/tracker <tool> <json>` - call a tool with JSON arguments
- Ask plain-text questions about integrations to trigger the AI flow

Example:

```
/tracker issues.search {"query":"Assignee: me"}
```

## MCP ops (mcporter CLI)

Use `mcporter` to validate MCP servers outside the bot process.

Examples:

```bash
# list configured MCP servers
mcporter list

# inspect available tools for the Yandex Tracker server
mcporter list yandex-tracker --schema

# call a tool directly with JSON args
mcporter call yandex-tracker.issues_find --args '{"query":"Assignee: me"}'
```

## Skills

This repo uses clawdbot-style skill docs (structured knowledge + tooling notes).
Runtime skills are loaded from `skills/**/skill.json` at startup.

- `skills/mcporter/SKILL.md` - MCP CLI usage and ops workflow
- `skills/yandex-tracker/SKILL.md` - MCP tool map and usage notes
- `skills/yandex-tracker/tracker-issues-find/skill.json` - runtime skill example
- `skills/yandex-tracker/tracker-issues-find/SKILL.md` - runtime skill docs and usage

## MCP server config example

```json
{
  "mcpServers": {
    "yandex-tracker": {
      "command": "uvx",
      "args": ["yandex-tracker-mcp@latest"],
      "env": {
        "TRACKER_TOKEN": "your_tracker_token_here",
        "TRACKER_CLOUD_ORG_ID": "your_cloud_org_id_here"
      }
    }
  }
}
```

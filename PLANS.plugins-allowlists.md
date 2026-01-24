# Plugins + Per‑Sender Tool Allowlists

This ExecPlan is a living document. The sections `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` must be kept up to date as work proceeds.

This plan follows the requirements in `.agent/PLANS.md` from the repository root. Keep this document aligned with that file at all times.

## Purpose / Big Picture

After this change, Omni supports a plugin registry with hook registration (similar to Clawdbot) and per‑sender tool allowlists. This lets you add new integrations without editing core code and safely limit tool access to specific users or chats. The behavior is observable by loading a test plugin that logs a tool hook and by restricting a tool to a specific user id and seeing it blocked for other users.

## Progress

- [x] (2026-01-24 11:05Z) Define plugin loading, allow/deny behavior, and hook interfaces.
- [x] (2026-01-24 11:07Z) Implement plugin registry + tool hook integration.
- [x] (2026-01-24 11:09Z) Implement per‑sender and per‑chat tool allowlists.
- [x] (2026-01-24 11:10Z) Add tests and docs; run full test suite and record results.

## Surprises & Discoveries

- Observation: None yet.
  Evidence: Not applicable.

## Decision Log

- Decision: Use local file‑based plugin loading with allow/deny lists rather than a network plugin registry.
  Rationale: Matches Omni’s current deployment model and avoids introducing a new service.
  Date/Author: 2026-01-24 / assistant

## Outcomes & Retrospective

Plugins are now loadable from local paths with allow/deny lists, can register tools and tool hooks, and show in /tools. Per‑sender and per‑chat tool allowlists are enforced in the global tool hook. Tests and docs are updated, and the full suite passes.

## Context and Orientation

Omni has tool hooks in `src/lib/tools/hooks.ts` and a centralized tool creation path in `src/bot.ts`. We will add a plugin registry under `src/lib/plugins/registry.ts` that can register tool hooks and tools. We will also add per‑sender allowlists in `src/lib/tools/access.ts` and enforce them in the tool hook wrapper (in `src/bot.ts`).

Key files:

`src/bot.ts` — wiring for tool creation, hooks, and commands.
`src/lib/tools/hooks.ts` — tool hook wrapper.
`src/lib/plugins/registry.ts` — plugin loader and hook registry.
`src/lib/tools/access.ts` — per‑sender tool allowlist parsing and checks.

## Plan of Work

First, implement a plugin registry. It loads plugin modules from paths defined by `PLUGINS_PATHS` (comma‑separated), filters by `PLUGINS_ALLOWLIST`/`PLUGINS_DENYLIST`, and allows plugins to register tools and hooks. Hooks should run in order and can block tool calls (before hook). Tools registered by plugins should appear in `/tools`.

Second, implement per‑sender and per‑chat allowlists. Add env vars:

- `TOOL_ALLOWLIST_USER_IDS` / `TOOL_DENYLIST_USER_IDS`
- `TOOL_ALLOWLIST_USER_TOOLS` / `TOOL_DENYLIST_USER_TOOLS`
- `TOOL_ALLOWLIST_CHAT_TOOLS` / `TOOL_DENYLIST_CHAT_TOOLS`

Allowlist format for per‑tool is:

`<id>:tool1|tool2|group:web; <id2>:jira_search`

Where `<id>` is user id (for USER) or chat id (for CHAT). Group entries (e.g. `group:web`) expand using existing tool groups.

Third, enforce these rules in the global tool hook wrapper inside `createAgentTools` in `src/bot.ts`. If a sender is not allowed, block the tool call with a deterministic reason and log it.

Fourth, add tests and update docs. Include a plugin test using a temp JS file and access policy tests for user/chat allowlists.

## Concrete Steps

Run commands from `/Users/murad-pc/Documents/Github/omni`.

1) Add plugin registry:

    - Create `src/lib/plugins/registry.ts` with `loadPlugins()`, `getTools()`, `getHooks()`.
    - Update `.env.example` with `PLUGINS_PATHS`, `PLUGINS_ALLOWLIST`, `PLUGINS_DENYLIST`.
    - Wire in `src/bot.ts` so plugin tools + hooks are applied.

2) Add per‑sender allowlists:

    - Create `src/lib/tools/access.ts` with parsing and `isToolAllowedForSender()`.
    - Update `.env.example` with allowlist envs.
    - Enforce in `src/bot.ts` tool hook.

3) Tests:

    - `tests/plugins/registry.test.ts`
    - `tests/tools/access.test.ts`

4) Docs:

    - Update `docs/tools/tool-policy.md` with new env vars.
    - Add `docs/plugins.md` describing plugin format and env vars.

5) Run validation:

    - `bun test`
    - `bun type-check`

## Validation and Acceptance

1) A plugin hook runs and can log tool calls; a plugin tool appears in `/tools`.
2) Per‑sender allowlists block tool usage for non‑authorized users.
3) `bun test` and `bun type-check` pass.

## Idempotence and Recovery

Plugin loading is additive. If a plugin fails to load, it is skipped with a log entry. If allowlists block too much, clear the env vars and restart.

## Artifacts and Notes

Example per‑sender allowlist env:

    TOOL_ALLOWLIST_USER_TOOLS=187873791:web_search|jira_search
    TOOL_DENYLIST_CHAT_TOOLS=-1001234567890:group:web

Actual test run (2026-01-24):

    bun test
    36 pass
    0 fail
    Ran 36 tests across 16 files.

Plan change note: Created this plan on 2026-01-24 to add plugin hooks and per‑sender tool allowlists.

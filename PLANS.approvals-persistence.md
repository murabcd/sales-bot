# Persisted Tool Approvals

This ExecPlan is a living document. The sections `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` must be kept up to date as work proceeds.

This plan follows the requirements in `.agent/PLANS.md` from the repository root. Keep this document aligned with that file at all times.

## Purpose / Big Picture

After this change, tool approvals persist across restarts and are visible via a `/approvals` command. Users can approve a tool once (with a TTL) and keep working without re‑approving after every deploy. This reduces friction while keeping explicit approval for risky tools. The behavior is observable by approving `web_search`, restarting the bot, and confirming `/approvals` still lists that approval until the TTL expires.

## Progress

- [x] (2026-01-24 10:45Z) Define the approval persistence format, storage location, and TTL semantics.
- [x] (2026-01-24 10:46Z) Implement persistent approval store + `/approvals` command.
- [x] (2026-01-24 10:47Z) Update docs and add tests; run full test suite and record results.

## Surprises & Discoveries

- Observation: None yet.
  Evidence: Not applicable.

## Decision Log

- Decision: Use a JSON file under `data/approvals/` for persistence with simple TTL handling.
  Rationale: Omni already writes local state for sessions, and a JSON file is simple and deployable without extra services.
  Date/Author: 2026-01-24 / assistant

## Outcomes & Retrospective

Approvals now persist to disk, `/approvals` lists current approvals per chat, and the feature is documented with tests. The approval store falls back to an empty state if the file is missing or invalid.

## Context and Orientation

Omni currently has an approval store in memory (`src/lib/tools/approvals.ts`) and a `/approve` command in `src/bot.ts`. Approvals are lost on restart. This plan adds a persistent store backed by a local JSON file and a `/approvals` command to list active approvals per chat.

Key files:

`src/lib/tools/approvals.ts` – approval store implementation.
`src/bot.ts` – `/approve` command and tool hook that enforces approvals.
`tests/tools/approval.test.ts` – approval tests.

## Plan of Work

First, extend the approval store to support persistence. Add a `filePath` option that loads existing approvals at startup and writes updates on approval or expiry. Use a simple map `{ chatId: { toolName: expiresAt } }` serialized to JSON. Store it under `data/approvals/approvals.json` by default, configurable with an env var `TOOL_APPROVAL_STORE_PATH`.

Second, add a `/approvals` command that lists current approvals for the chat (tool + expiration time). This command should be safe in group chats and only display that chat’s approvals.

Third, update the docs and tests. Add a test for persistence: write an approval, re‑instantiate the store, and verify it loads. Update `docs/tools/tool-policy.md` with the new env var and `/approvals` command.

## Concrete Steps

Run commands from `/Users/murad-pc/Documents/Github/omni`.

1) Extend approval store:

    - Update `src/lib/tools/approvals.ts` to accept optional `filePath`.
    - Add helper functions `loadApprovals()` and `saveApprovals()`.

2) Update bot wiring:

    - Add `TOOL_APPROVAL_STORE_PATH` env var.
    - Initialize approval store with persistence.
    - Add `/approvals` command in `src/bot.ts`.

3) Tests:

    - Update `tests/tools/approval.test.ts` to cover persistence.

4) Docs:

    - Update `docs/tools/tool-policy.md`.

5) Run validation:

    - `bun test`
    - `bun type-check`

## Validation and Acceptance

1) Approvals persist across restarts (simulate by re‑creating the store in tests).
2) `/approvals` lists current approvals for the chat with expiry timestamps.
3) `bun test` and `bun type-check` pass.

## Idempotence and Recovery

The approvals file can be deleted to reset approvals. If the file is corrupted, the store should ignore it and start fresh, logging a warning.

## Artifacts and Notes

Expected `/approvals` output:

    Active approvals:
    - web_search (expires at 2026-01-24T12:34:56.000Z)

Actual test run (2026-01-24):

    bun test
    32 pass
    0 fail
    Ran 32 tests across 14 files.

Plan change note: Created this plan on 2026-01-24 to add persistent tool approvals.

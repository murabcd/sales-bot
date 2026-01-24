# Add Tool Conflict Protections and Tool Governance for Omni

This ExecPlan is a living document. The sections `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` must be kept up to date as work proceeds.

This plan follows the requirements in `/Users/murad-pc/Documents/github/omni/.agent/PLANS.md`. Keep this document aligned with that file at all times.

## Purpose / Big Picture

After this change, Omni can safely scale to many tools without tool name collisions, tool call ID collisions, or transcript errors that cause provider failures. Operators will be able to load more tools and runtime skills with predictable allow/deny controls, and the bot will avoid duplicate tool outputs and “double sends.” The user-visible proof is that tools load consistently, conflicts are reported, and tool invocations work even when tool calls are malformed or duplicated by upstream providers.

## Progress

- [x] (2026-01-23 00:00Z) Create ExecPlan document for tool conflict protections.
- [x] (2026-01-23 00:30Z) Define tool registry and normalization layer for tool names and aliases.
- [x] (2026-01-23 00:45Z) Add tool allowlist/denylist policy resolution and integrate with tool construction + listing.
- [x] (2026-01-23 00:50Z) Implement tool call ID sanitizer with collision-safe mapping.
- [x] (2026-01-23 01:05Z) Add transcript repair for tool call / tool result pairing.
- [x] (2026-01-23 01:15Z) Add runtime skills validation for duplicate names and duplicate tool refs.
- [x] (2026-01-23 01:20Z) Add messaging-tool output dedupe and status dedupe integration.
- [x] (2026-01-23 01:30Z) Add diagnostics surface in `/tools` for conflicts and policy-suppressed tools.
- [x] (2026-01-23 01:45Z) Add tests for registry conflicts, tool ID sanitization, transcript repair, and skills duplicates.
- [x] (2026-01-23 02:10Z) Run type-check (tsc --noEmit) after fixes.
- [x] (2026-01-23 02:20Z) Fix transcript repair duplicate detection after test failure.
- [x] (2026-01-23 02:30Z) Run full test suite (vitest run) and confirm all tests pass.
- [x] (2026-01-23 02:40Z) Update chat-scoped tool policy (1-1: all, groups: no web/memory) and re-run tests.

## Surprises & Discoveries

- Observation: ToolLoopAgent exposes a `prepareCall` hook that can sanitize/repair transcripts before model calls.
  Evidence: `node_modules/ai/src/agent/tool-loop-agent.ts` uses `prepareCall` to transform call args.

## Decision Log

- Decision: Treat tool conflict protections as core infrastructure and implement them in `src/lib/tools/*` with minimal changes to existing bot logic.
  Rationale: Centralized handling avoids ad-hoc fixes as new tools are added.
  Date/Author: 2026-01-23 / assistant
- Decision: Apply transcript sanitization/repair in the agent `prepareCall` hook even when prompts are used today.
  Rationale: Keeps the path safe as soon as messages-based history is introduced without requiring a future refactor.
  Date/Author: 2026-01-23 / assistant

## Outcomes & Retrospective

- Implemented registry, policy, transcript repair, tool call ID sanitization, skills duplicate validation, tool status dedupe, and tests. Pending: run full test suite and capture results.

## Context and Orientation

Omni’s tool usage is defined in `src/bot.ts`. Tools are built by `createAgentTools()` using `ai` SDK’s `tool` and OpenAI `web_search`, plus Supermemory tools from `@supermemory/tools/ai-sdk`. Runtime skills are loaded from `skills/**/skill.json` by `src/skills.ts` and invoked by name via Telegram commands in `src/bot.ts`. There is no centralized tool registry today, so tool name collisions or duplicate tool call IDs are not detected or repaired.

A “tool” in this repo means a callable function exposed to the model through `ToolLoopAgent`. A “tool call ID” is the identifier used by the model to match a tool invocation with its tool result. A “tool result” is the response emitted by the tool execution. A “tool policy” is a set of allow/deny rules that define which tools are visible to a given agent or runtime context.

## Plan of Work

First, create a tool registry layer that normalizes tool names (trim + lowercase, alias mapping) and validates uniqueness. This registry should be used by `createAgentTools()` to detect collisions across core tools, optional tools, and runtime skill wrappers. Next, add a tool policy module that can apply allow/deny filters for global config and per-agent use; even if Omni does not yet expose policy configuration, the system should support it for future additions.

Then add tool call ID sanitization and collision-safe mapping, and use it whenever tool calls or tool results are processed in transcripts. Add a transcript repair module that moves tool results directly after their tool call and drops duplicates; if a tool result is missing, insert a synthetic error tool result that is explicitly marked and logged. This protects providers that enforce strict tool call/result pairing.

Next, validate runtime skills at load time: reject duplicate skill names and duplicate tool references, and log conflicts. Use the tool registry’s normalization rules to ensure matching logic is stable. For messaging tools, add a dedupe layer so messages sent via tools do not also get sent as assistant text. Reuse the existing status dedupe in `src/lib/tool-status.ts` but incorporate it into the tool runner lifecycle.

Finally, add tests and diagnostics. Tests must cover name conflict resolution, tool call ID sanitization, transcript repair behavior, and runtime skill validation. Diagnostics should be logged and surfaced in `/tools` or `/status` output so operators can see which tools were dropped and why.

## Concrete Steps

1) Create a new tool utilities module at `src/lib/tools/registry.ts` that provides:

    - `normalizeToolName(name: string): string` that lowercases, trims, and maps aliases.
    - `createToolRegistry(): ToolRegistry` that stores normalized and original names.
    - `registerTool(registry, toolMeta)` that returns `{ ok: boolean; reason?: string }` and logs conflicts.

2) Update `createAgentTools()` in `src/bot.ts` to build tools through the registry. If conflicts are detected, skip those tools and record diagnostics in a shared structure (exposed to `/tools` and logs).

3) Add `src/lib/tools/policy.ts` with `resolveToolPolicy()` and `filterToolsByPolicy()` so tools can be allowed/denied by name or group. Add basic alias and group support (`group:web`, `group:memory`, `group:tracker`, `group:runtime-skills`), even if no config currently uses them.

4) Add `src/lib/tools/tool-call-id.ts` with `sanitizeToolCallId()` and `sanitizeToolCallIdsForTranscript(messages)` following this behavior:

    - Sanitize to `^[a-zA-Z0-9_-]+$`.
    - If collisions happen, append a short hash suffix.
    - Cap the length at 40 characters while preserving uniqueness.

5) Add `src/lib/tools/transcript-repair.ts` with `repairToolUseResultPairing(messages)` that:

    - Moves tool results directly after matching tool calls.
    - Drops duplicate tool results for the same tool call id.
    - Inserts synthetic error tool results for missing ids.

6) Extend `src/skills.ts` to validate duplicates:

    - Track skill names and tool refs using the same normalization as the tool registry.
    - Log and skip duplicates with a reason.

7) Integrate tool output dedupe (messaging tools):

    - Add `src/lib/tools/messaging-dedupe.ts` that normalizes text (trim, lowercase, collapse whitespace) and suppresses duplicates beyond a minimum length.
    - Use this in the tool runner path so tool-produced replies do not also appear in assistant text.

8) Add diagnostics output:

    - Extend `/tools` command in `src/bot.ts` to show conflicts and suppressed tools.
    - Add log entries with a `tool_conflict` event containing tool name, source, and reason.

9) Add tests under `tests/tools/*.test.ts` that cover:

    - Tool registry conflict detection and alias behavior.
    - Tool call ID sanitization with collision cases.
    - Transcript repair for missing/duplicate tool results.
    - Runtime skill duplicate detection.

## Validation and Acceptance

Run tests in `/Users/murad-pc/Documents/github/omni`:

    bun run test

Expect tests to pass with new suites included. Verify runtime behavior by running the bot locally and calling `/tools` and `/skills` to confirm that conflicts are listed and valid tools load. If a tool name is duplicated on purpose in a test fixture, the bot should log a conflict and skip the duplicate tool without crashing.

Acceptance is met when:

- Tool name collisions are detected and do not crash the bot.
- Tool call ID sanitization prevents collisions in transcripts.
- Tool results are paired correctly even when out of order or duplicated.
- Duplicate runtime skill names or tool references are skipped with diagnostics.
- `/tools` output shows active tools plus a conflict summary.

## Idempotence and Recovery

All steps are additive and safe to repeat. If a step fails, rerun after fixing the reported error; registry state is ephemeral at runtime and does not persist across runs. If tests fail, inspect the new test output and adjust the conflicting logic; there is no migration or destructive change.

## Artifacts and Notes

Expected example log snippet for a tool conflict:

    [tool_conflict] name=web_search source=runtime-skill reason=duplicate-name

Expected `/tools` output excerpt:

    Active tools:
    - tracker_search
    - web_search

    Conflicts:
    - web_search (duplicate name, skipped runtime skill “web_search”)

## Interfaces and Dependencies

Create or update these interfaces:

- `src/lib/tools/registry.ts`:

    export type ToolMeta = {
        name: string;
        source: "core" | "runtime-skill" | "plugin" | "memory" | "web";
        description?: string;
    };

    export type ToolRegistry = {
        register: (tool: ToolMeta) => { ok: boolean; reason?: string };
        list: () => ToolMeta[];
        conflicts: () => Array<{ tool: ToolMeta; existing: ToolMeta; reason: string }>;
    };

- `src/lib/tools/policy.ts`:

    export type ToolPolicy = { allow?: string[]; deny?: string[] };
    export function filterToolsByPolicy(tools: ToolMeta[], policy?: ToolPolicy): ToolMeta[];

- `src/lib/tools/tool-call-id.ts`:

    export function sanitizeToolCallId(id: string): string;
    export function sanitizeToolCallIdsForTranscript(messages: Array<Record<string, unknown>>): Array<Record<string, unknown>>;

- `src/lib/tools/transcript-repair.ts`:

    export function repairToolUseResultPairing(messages: Array<Record<string, unknown>>): {
        messages: Array<Record<string, unknown>>;
        added: Array<Record<string, unknown>>;
        droppedDuplicateCount: number;
        droppedOrphanCount: number;
        moved: boolean;
    };

When integrating with `ToolLoopAgent`, ensure tool call IDs and tool results are passed through `sanitizeToolCallIdsForTranscript()` and `repairToolUseResultPairing()` before sending requests to the model.

---
Plan change note: Initial ExecPlan created to implement Clawdbot-inspired tool conflict protections in Omni. This establishes baseline scope and file layout for upcoming implementation.
Plan change note: Updated progress, decisions, and outcomes to reflect completed implementation steps and added prepareCall insight.
Plan change note: Recorded the successful type-check run after fixing ToolSet typing.
Plan change note: Adjusted transcript repair duplicate handling to count duplicates within the same assistant span.
Plan change note: Recorded full test run success.
Plan change note: Adjusted tool policy to be chat-scoped and confirmed tests pass.

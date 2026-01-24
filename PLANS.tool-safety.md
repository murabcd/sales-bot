# Tool Safety & Governance Hardening

This ExecPlan is a living document. The sections `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` must be kept up to date as work proceeds.

This plan follows the requirements in `.agent/PLANS.md` from the repository root. Keep this document aligned with that file at all times.

## Purpose / Big Picture

After this change, Omni provides Clawdbot‑style safety guarantees for tools: every tool call is audited, can be blocked by policy, and is rate‑limited per user/chat. Group chats continue to be safer than 1‑1 chats, but the behavior is explicit and testable. A user can observe the safety gates by issuing a prompt that would normally invoke web search in a group chat and seeing a deterministic “tool blocked by policy” response, and by running the test suite to see the new safety tests pass.

## Progress

- [x] (2026-01-23 15:45Z) Define the tool safety model (global hooks + per-chat policy + rate limits) and document user-visible behavior.
- [x] (2026-01-23 15:46Z) Implement global tool hooks and audit logging for all tools.
- [x] (2026-01-23 15:47Z) Implement per-chat tool policies and rate limits; wire them into tool execution.
- [x] (2026-01-23 15:49Z) Add tests and update docs; run full test suite and record results.

## Surprises & Discoveries

- Observation: None yet.
  Evidence: Not applicable.

## Decision Log

- Decision: Use in-process tool wrappers (before/after hooks) to enforce policy and logging instead of introducing a separate gateway process.
  Rationale: Omni runs inside a single Worker and already centralizes tool registration in `src/bot.ts`, so a wrapper is the least invasive and testable path.
  Date/Author: 2026-01-23 / assistant

## Outcomes & Retrospective

Tool execution is now globally wrapped with before/after hooks, per-chat policy is merged with base policy, and per-tool rate limits are enforced. New tests validate policy blocking and rate limiting, and all tests pass. The remaining gap versus Clawdbot is external sandboxing or approvals; those are out of scope for this plan but can be handled in a follow-up plan if required.

## Context and Orientation

Omni builds a tool map inside `src/bot.ts` in `createAgentTools`, then passes it to `ToolLoopAgent` (AI SDK) for execution. Tool policy is currently global and chat-scoped: `parseToolPolicyFromEnv` reads `TOOL_ALLOWLIST` / `TOOL_DENYLIST`, and `resolveChatToolPolicy` blocks `web_search` and Supermemory tools in group chats. Orchestration has its own tool hooks in `src/lib/agents/orchestrator.ts`, but the primary agent flow does not. This plan adds a global tool hook layer and per-chat policy/rate limits so that all tool calls (tracker, Jira, PostHog, web, memory, and future tools) are governed consistently.

Key files:

`src/bot.ts` defines tool creation, chat context, and the agent execution flow.
`src/lib/tools/policy.ts` parses allow/deny lists and expands tool groups.
`src/lib/tools/registry.ts` defines tool metadata and conflict handling.
`src/lib/agents/orchestrator.ts` defines subagents and already wraps tools with a hook for orchestration‑only runs.
`tests/` contains the current safety tests and tool-policy coverage.

Terms:

“Tool hook” means a function that runs before or after any tool execution to log or block the call.
“Per‑chat policy” means allow/deny lists that depend on chat type (DM vs group) and sender.
“Rate limit” means a max number of tool calls per time window per user/chat.

## Plan of Work

First, add a global tool hook layer that wraps every tool registered in `createAgentTools`. Create a small helper in `src/lib/tools/hooks.ts` that accepts a tool map and returns a wrapped tool map. The wrapper must call a `beforeToolCall` hook and optionally block by throwing a deterministic error, and then call an `afterToolCall` hook that records duration and errors. Wire this wrapper in `createAgentTools` so every tool is protected, and include the tool call id from the AI SDK in the hook payload. Add logging in `src/bot.ts` using the existing logger so audit logs include `tool`, `chat_id`, `user_id`, `toolCallId`, and the model id from `setLogContext`.

Second, extend tool policy to be chat‑aware and sender‑aware. Add new environment variables:

- `TOOL_ALLOWLIST_DM`, `TOOL_DENYLIST_DM`
- `TOOL_ALLOWLIST_GROUP`, `TOOL_DENYLIST_GROUP`
- `TOOL_RATE_LIMITS` (JSON string or comma‑separated rules, e.g. `web_search:10/60,tracker_search:20/60`)

Update `src/lib/tools/policy.ts` to parse these variables into `ToolPolicy` objects and provide a `mergeToolPolicies` helper for DM vs group. Update `resolveChatToolPolicy` in `src/bot.ts` to merge the base policy with the chat‑specific policy. Add a simple in‑memory rate limiter in `src/lib/tools/rate-limit.ts` keyed by `{tool, chatId, userId}` with a sliding window. The global tool hook should call the rate limiter and block when the limit is exceeded, returning a consistent error that the assistant can translate into a short user message.

Third, align orchestration with the global tool hook so behavior is consistent. Remove orchestration‑only hooks if they duplicate the global hook, or keep them but document that they are additional safeguards. Ensure that orchestration respects the chat‑specific policy and rate limits automatically because it uses the same wrapped tools.

Fourth, add tests and documentation. Add tests for group chat tool denial, rate limiting, and audit hooks. Update `docs/tools/tool-policy.md` and `docs/telegram.md` to describe the new env vars and behavior. Update any CLI help or /tools output if it should list chat‑specific policies.

## Concrete Steps

Run commands from `/Users/murad-pc/Documents/Github/omni`.

1) Create a new helper:

    - File: `src/lib/tools/hooks.ts`
    - Define `wrapToolMapWithHooks(tools, hooks)` and `ToolHookContext`.
    - The wrapper should call hooks with `toolCallId`, `toolName`, `input`, and `durationMs`.

2) Add a rate limiter:

    - File: `src/lib/tools/rate-limit.ts`
    - Define a `createToolRateLimiter(config)` that returns `check(tool, chatId, userId)`.
    - Parse config from `TOOL_RATE_LIMITS` and store in memory.

3) Wire hooks and rate limits into `createAgentTools` in `src/bot.ts`:

    - Build hooks that log and block; use `resolveChatToolPolicy` and the rate limiter.
    - Wrap the tool map before returning it to the agent.

4) Update env parsing and policy:

    - File: `src/lib/tools/policy.ts`
    - Add parsing for DM vs group allow/deny lists.
    - Update `resolveChatToolPolicy` in `src/bot.ts` to merge base + chat policy.

5) Tests:

    - Add `tests/tools/tool-hooks.test.ts` to validate blocking and rate limits.
    - Add a test that simulates group policy and ensures `web_search` is blocked by policy.

6) Docs:

    - Update `docs/tools/tool-policy.md` with new env vars and examples.
    - Update `docs/telegram.md` to call out group tool policy.

7) Run validation:

    - `bun test`
    - `bun type-check`

Expected output should include all tests passing. New tests should fail before the change and pass after.

## Validation and Acceptance

Behavioral acceptance:

1) In a group chat, a user message that clearly requests web search results in a reply that says the tool is disabled for group chats. This can be validated by a unit test in `tests/tools/tool-hooks.test.ts` that forces the policy and checks the error handling.

2) When a single user exceeds a configured tool rate limit, the tool wrapper blocks and the assistant responds with a short “rate limited” message. This should be verified by a unit test that triggers two tool calls in a window where only one is allowed.

3) `bun test` reports all tests passing and includes the new test file.

4) `bun type-check` completes without TypeScript errors.

## Idempotence and Recovery

The changes are additive and safe to re-run. The rate limiter is in-memory, so restarting the process resets counters. If the new policies block too aggressively, set `TOOL_RATE_LIMITS=` and remove chat-specific allow/deny env vars; the system will revert to base tool policy behavior.

## Artifacts and Notes

Expected log examples after implementation:

    {"event":"tool_call","tool":"web_search","tool_call_id":"...","chat_id":"...","user_id":"..."}
    {"event":"tool_blocked","tool":"web_search","reason":"policy"}
    {"event":"tool_rate_limited","tool":"tracker_search","limit":"20/60"}

Expected test transcript (example):

    RUN  vX.Y.Z /Users/murad-pc/Documents/Github/omni
     ✓ tests/tools/tool-hooks.test.ts (3 tests)
     ✓ tests/tools/registry.test.ts (2 tests)
    Test Files  10 passed (10)

Actual test run (2026-01-23):

    bun test
    29 pass
    0 fail
    Ran 29 tests across 13 files.

## Interfaces and Dependencies

In `src/lib/tools/hooks.ts`, define:

    export type ToolHookContext = {
      toolName: string;
      toolCallId?: string;
      input: unknown;
      chatId?: string;
      userId?: string;
    };

    export type ToolHooks = {
      beforeToolCall?: (ctx: ToolHookContext) => { allow?: boolean; reason?: string } | undefined;
      afterToolCall?: (ctx: ToolHookContext & { durationMs: number; error?: string }) => void;
    };

    export function wrapToolMapWithHooks(tools: ToolSet, hooks: ToolHooks): ToolSet;

In `src/lib/tools/rate-limit.ts`, define:

    export type ToolRateLimitRule = { tool: string; max: number; windowSeconds: number };
    export function parseToolRateLimits(raw: string): ToolRateLimitRule[];
    export function createToolRateLimiter(rules: ToolRateLimitRule[]): {
      check: (tool: string, chatId?: string, userId?: string) => { allowed: boolean; remaining: number; resetMs: number };
    };

Plan change note: Created initial tool safety ExecPlan on 2026-01-23 to address Clawdbot parity gaps for global tool hooks, per-chat policy, and rate limiting.
Plan change note: Marked plan complete and recorded test results after implementation on 2026-01-23.

# Add Multi-Agent Orchestration to Omni

This ExecPlan is a living document. The sections `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` must be kept up to date as work proceeds.

This plan follows the requirements in `/Users/murad-pc/Documents/github/omni/.agent/PLANS.md`. Keep this document aligned with that file at all times.

## Purpose / Big Picture

After this change, Omni can orchestrate multiple specialized agents instead of a single monolithic one. Users will be able to ask a question and have Omni automatically route sub-tasks to specialized subagents (Tracker, Jira, PostHog, web, memory) and then combine results into a final response. This reduces failures for complex requests, improves response quality, and makes tool usage safer by limiting tools per subagent. The user-visible proof is that a single user request can trigger multiple agent steps with clear summaries, and the final response explains which sources were consulted.

## Progress

- [x] (2026-01-23 03:10Z) Update ExecPlan scope to include Jira + PostHog and chat-scoped policies.
- [x] (2026-01-23 15:22Z) Define orchestration model (main agent + subagents + routing rules + aggregation).
- [x] (2026-01-23 15:22Z) Implement subagent spawning and tool policy restrictions per subagent.
- [x] (2026-01-23 15:22Z) Add orchestration state tracking + result aggregation format.
- [x] (2026-01-23 15:22Z) Enforce chat-scoped policy: skip web/memory subagents in groups.
- [x] (2026-01-23 15:22Z) Add safety gates inspired by Clawdbot (pre/post tool hooks, allow/deny, budgets).
- [x] (2026-01-23 15:22Z) Add observability for orchestration (plan + timings + tool usage + correlation ids).
- [x] (2026-01-23 15:22Z) Add tests for routing, subagent tool policies, and aggregation.
- [x] (2026-01-24 10:16Z) Run full test suite and document results.

## Surprises & Discoveries

- Observation: None yet.
  Evidence: Not applicable.

## Decision Log

- Decision: Use a main agent that delegates to subagents with restricted tool scopes rather than a fully parallel graph execution.
  Rationale: This matches Omni’s existing ToolLoopAgent integration and keeps concurrency manageable in Workers.
  Date/Author: 2026-01-23 / assistant
- Decision: Orchestration must respect existing chat-scoped policy (group chat blocks web + memory) and PostHog read-only tools.
  Rationale: Keeps production safety consistent with existing tool governance.
  Date/Author: 2026-01-23 / assistant
- Decision: Add orchestration safety gates similar to Clawdbot (tool call hooks, allow/deny lists, budgets) rather than relying only on static tool lists.
  Rationale: Clawdbot’s plugin hooks + tool policy model prevent unsafe tool usage and provide auditability.
  Date/Author: 2026-01-23 / assistant

## Outcomes & Retrospective

Orchestration is live with subagents, routing, tool scoping, and safety gates. Tests for routing and tool hooks pass, and production configuration is documented.

Test run (2026-01-24):

    bun test
    29 pass
    0 fail
    Ran 29 tests across 13 files.

## Context and Orientation

Omni currently uses a single `ToolLoopAgent` in `src/bot.ts` to answer user prompts. Tools are registered and filtered by policy. Runtime skills exist but are single-step tool wrappers. Jira and PostHog tools are now available, with PostHog read-only filtering. Group chats already block web search and Supermemory tools via chat-scoped policy.

A “subagent” is a specialized instance of `ToolLoopAgent` with a restricted tool set and a focused system prompt. The “main agent” is the orchestrator that decides which subagents to call and then combines results. “Routing” is the decision logic used to select which subagent(s) should handle a request based on message content (keywords, presence of issue keys, or intent like “analytics”).

The Worker entrypoint (`worker/index.ts`) passes environment variables into `createBot`, so orchestration must work both locally and in the Worker runtime.

## Plan of Work

First, add an orchestration layer in `src/lib/agents/` that defines subagents and routing rules. The main agent should interpret user requests, decide which subagents to call, and merge their outputs. Subagents must be restricted to specific tool subsets:

- `trackerAgent`: `tracker_search` only.
- `jiraAgent`: `jira_search` only.
- `posthogAgent`: PostHog read-only tools only.
- `webAgent`: `web_search` only.
- `memoryAgent`: `searchMemories` + `addMemory` only.

Second, integrate orchestration into `createBot` in `src/bot.ts` by replacing the single-agent call with a two-phase flow: (1) routing decision, (2) subagent execution, and (3) final response drafting by the main agent using subagent summaries. If routing yields no subagents, fall back to the current single-agent flow.

Third, add chat-aware routing and policy enforcement:

- In group chats, skip `webAgent` and `memoryAgent` regardless of routing intent.
- PostHog tools remain available in groups (read-only).

Fourth, define a stable aggregation schema so results can be combined deterministically. Each subagent should return:

- `agentId`, `summary`, `toolUsage`, and `sources` (if applicable).

Fifth, add safety gates inspired by Clawdbot:

- Introduce pre/post tool call hooks to log and optionally block tool calls.
- Add allow/deny lists for subagent routing (per chat type) and hard-stop unsafe tools.
- Add per-subagent budgets (max tool calls + timeout) and fail-safe fallbacks.

Finally, add observability and tests. Log orchestration plan and results (tools used, durations). Add tests for routing, tool access restrictions, and aggregation behavior.

## Concrete Steps

1) Create `src/lib/agents/orchestrator.ts` with:

    - `routeRequest(input: string, ctx): OrchestrationPlan` — returns which subagents to run and why.
    - `runOrchestration(plan, context): OrchestrationResult` — executes subagents and aggregates outputs.

2) Create subagent definitions in `src/lib/agents/subagents/*.ts`:

    - `trackerAgent` — tools: `tracker_search` only.
    - `jiraAgent` — tools: `jira_search` only.
    - `posthogAgent` — tools: PostHog read-only tools only.
    - `webAgent` — tools: `web_search` only.
    - `memoryAgent` — tools: `searchMemories` + `addMemory` only.

3) Update `src/bot.ts` to use the orchestrator:

    - Use routing to decide which subagents to run.
    - If none, fall back to existing single-agent flow.
    - Combine subagent summaries into final response.

4) Enforce tool policies for subagents:

    - Subagents only receive their tool subset.
    - Respect group chat restrictions (skip web + memory subagents).

5) Add orchestration safety gates:

    - Add pre/post tool call hooks for auditing and optional blocking.
    - Add allow/deny lists for routing decisions (per chat type).
    - Enforce per-subagent budgets (max steps + timeout).

6) Add observability:

    - Log orchestration plan and results (tools + timings).
    - Optional: add a brief orchestration summary to `/status` output.

7) Add tests under `tests/agents/orchestration.test.ts`:

    - Routing: issue key → trackerAgent or jiraAgent.
    - Analytics query → posthogAgent.
    - Group chat skips web/memory agents.
    - Aggregation output includes subagent summaries.

## Validation and Acceptance

Run tests in `/Users/murad-pc/Documents/github/omni`:

    bun run test

Acceptance is met when:

- The orchestrator selects the correct subagents based on prompt.
- Subagents only have access to their allowed tools.
- Group chat restrictions still block web and memory subagents.
- Final responses include subagent summaries and are returned without errors.

## Idempotence and Recovery

Changes are additive and safe to re-run. If orchestration fails, the system should fall back to the existing single-agent flow. No migrations are required.

## Artifacts and Notes

Expected log snippet:

    {"event":"orchestration","plan":["tracker","jira"],"tools":["tracker_search","jira_search"],"durationMs":1234}

## Interfaces and Dependencies

Define these interfaces:

- `OrchestrationPlan`:

    type OrchestrationPlan = {
      agents: Array<{ id: "tracker" | "jira" | "posthog" | "web" | "memory"; reason: string }>;
    };

- `OrchestrationResult`:

    type OrchestrationResult = {
      summaries: Array<{ agentId: string; text: string; toolUsage: string[] }>;
      toolUsage: string[];
    };

Ensure `runOrchestration` returns a safe fallback if any subagent fails.

---
Plan change note: Updated orchestration scope to include Jira, PostHog, and chat-scoped policy enforcement.

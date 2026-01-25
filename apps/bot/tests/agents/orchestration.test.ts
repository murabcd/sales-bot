import { tool } from "ai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
	applyRoutingPolicy,
	type OrchestrationPlan,
	wrapToolsForAgent,
} from "../../src/lib/agents/orchestrator.js";

describe("orchestration policy", () => {
	it("filters agents by allow/deny lists", () => {
		const plan: OrchestrationPlan = {
			agents: [
				{ id: "tracker", reason: "issue" },
				{ id: "jira", reason: "jira" },
				{ id: "web", reason: "web" },
			],
		};
		const filtered = applyRoutingPolicy(plan, {
			allowAgents: ["tracker", "web"],
			denyAgents: ["web"],
		});
		expect(filtered.agents.map((agent) => agent.id)).toEqual(["tracker"]);
	});

	it("drops web/memory when deny list contains them", () => {
		const plan: OrchestrationPlan = {
			agents: [
				{ id: "web", reason: "external" },
				{ id: "memory", reason: "history" },
				{ id: "tracker", reason: "issue" },
			],
		};
		const filtered = applyRoutingPolicy(plan, {
			denyAgents: ["web", "memory"],
		});
		expect(filtered.agents.map((agent) => agent.id)).toEqual(["tracker"]);
	});
});

describe("orchestration tool wrapping", () => {
	it("enforces max tool call budget", async () => {
		const base = tool({
			description: "echo",
			inputSchema: z.object({ value: z.string() }),
			execute: async ({ value }) => `ok:${value}`,
		});
		const wrapped = wrapToolsForAgent(
			"tracker",
			{ echo: base },
			{
				maxToolCalls: 1,
			},
		);
		await expect(wrapped.echo.execute({ value: "one" })).resolves.toBe(
			"ok:one",
		);
		await expect(wrapped.echo.execute({ value: "two" })).rejects.toThrow(
			"TOOL_CALL_BUDGET_EXCEEDED",
		);
	});

	it("blocks tool calls via beforeToolCall hook", async () => {
		const base = tool({
			description: "echo",
			inputSchema: z.object({ value: z.string() }),
			execute: async ({ value }) => `ok:${value}`,
		});
		const hook = vi.fn(() => ({ allow: false, reason: "blocked" }));
		const wrapped = wrapToolsForAgent(
			"tracker",
			{ echo: base },
			{
				hooks: { beforeToolCall: hook },
			},
		);
		await expect(wrapped.echo.execute({ value: "one" })).rejects.toThrow(
			"blocked",
		);
		expect(hook).toHaveBeenCalled();
	});

	it("supports summary injection formatting", () => {
		const summaries = [
			{
				agentId: "tracker",
				text: "Issue summary",
				toolUsage: ["tracker_search"],
			},
		];
		const summaryText = [
			"Orchestration summary (internal; do not quote to user):",
			...summaries.map((summary) => {
				const toolLine = summary.toolUsage.length
					? `Tools: ${summary.toolUsage.join(", ")}`
					: "Tools: none";
				return [
					`[${summary.agentId}]`,
					summary.text || "(no summary)",
					toolLine,
				].join("\n");
			}),
			"",
		].join("\n\n");
		expect(summaryText).toContain("Orchestration summary");
		expect(summaryText).toContain("tracker_search");
		expect(summaryText).toContain("[tracker]");
	});
});

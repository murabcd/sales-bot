import { type ModelMessage, tool } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { wrapToolMapWithHooks } from "../../src/lib/tools/hooks.js";
import {
	isToolAllowed,
	mergeToolPolicies,
} from "../../src/lib/tools/policy.js";
import {
	createToolRateLimiter,
	parseToolRateLimits,
} from "../../src/lib/tools/rate-limit.js";

describe("tool hooks", () => {
	it("blocks tool calls when policy denies the tool", async () => {
		const policy = mergeToolPolicies(undefined, { deny: ["group:web"] });
		const base = tool({
			description: "web search",
			inputSchema: z.object({ q: z.string() }),
			execute: async ({ q }) => `ok:${q}`,
		});
		const wrapped = wrapToolMapWithHooks(
			{ web_search: base },
			{
				beforeToolCall: ({ toolName }) => {
					if (policy && !isToolAllowed(toolName, policy)) {
						return { allow: false, reason: "policy" };
					}
				},
			},
		);
		await expect(
			wrapped.web_search.execute(
				{ q: "news" },
				{ toolCallId: "t1", messages: [] as ModelMessage[] },
			),
		).rejects.toThrow("TOOL_CALL_BLOCKED");
	});

	it("enforces rate limits", () => {
		const rules = parseToolRateLimits("web_search:1/60");
		const limiter = createToolRateLimiter(rules);
		const first = limiter.check("web_search", "chat", "user");
		expect(first.allowed).toBe(true);
		const second = limiter.check("web_search", "chat", "user");
		expect(second.allowed).toBe(false);
	});
});

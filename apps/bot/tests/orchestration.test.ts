import { describe, expect, it } from "vitest";
import { createOrchestrationHelpers } from "../src/lib/agent/orchestration.js";

describe("orchestration overrides", () => {
	it("parses provider override for subagents", () => {
		const helpers = createOrchestrationHelpers({
			allowAgentsRaw: "",
			denyAgentsRaw: "",
			subagentMaxSteps: 3,
			subagentMaxToolCalls: 4,
			subagentTimeoutMs: 20000,
			parallelism: 1,
			agentConfigOverrides: JSON.stringify({
				web: { modelId: "gemini-2.5-flash", provider: "google" },
			}),
			agentDefaultMaxSteps: 3,
			agentDefaultTimeoutMs: 20000,
			logger: { info: () => {} },
			isGroupChat: () => false,
			getActiveModelId: () => "gpt-5.2",
		});

		const policy = helpers.resolveOrchestrationPolicy({
			chat: { type: "private" },
		} as never);

		expect(policy.agentOverrides.web?.provider).toBe("google");
	});
});

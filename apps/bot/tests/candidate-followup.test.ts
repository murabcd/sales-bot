import { describe, expect, it } from "vitest";
import { buildAgentInstructions } from "../src/lib/prompts/agent-instructions.js";

const instructionsBase = {
	question: "сделай саммари по каждой",
	modelRef: "gpt-5.2",
	modelName: "GPT-5.2",
	reasoning: "standard",
	toolLines: "tracker_search - search",
};

describe("recent candidates instructions", () => {
	it("includes recent candidate rule", () => {
		const instructions = buildAgentInstructions({
			...instructionsBase,
			recentCandidates: [
				{ key: "PROJ-2961", summary: "Манзана ТЗ", score: 10 },
				{ key: "PROJ-3000", summary: "Манзана тикет", score: 8 },
			],
		});
		expect(instructions).toContain("Recent candidates");
		expect(instructions).toContain("PROJ-2961");
		expect(instructions).toContain("do NOT run tracker_search");
	});
});

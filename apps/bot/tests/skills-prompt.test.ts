import { describe, expect, it } from "vitest";
import { buildSkillsPrompt } from "../src/lib/prompts/skills-prompt.js";

describe("skills prompt", () => {
	it("formats available skills with paths", () => {
		const prompt = buildSkillsPrompt([
			{
				name: "jira_issue_get",
				description: "Get Jira issue by key.",
				tool: "jira.jira_issue_get",
			},
		]);
		expect(prompt).toContain("<available_skills>");
		expect(prompt).toContain("<name>jira</name>");
		expect(prompt).toContain("apps/bot/skills/jira/SKILL.md");
	});
});

import { describe, expect, it } from "vitest";
import { buildJiraJql, extractJiraText } from "../src/lib/jira.js";

describe("jira helpers", () => {
	it("builds JQL with project filter", () => {
		const jql = buildJiraJql("циан интеграция", "FL");
		expect(jql).toContain("project = FL");
		expect(jql).toContain("summary ~");
		expect(jql).toContain("description ~");
	});

	it("extracts text from ADF", () => {
		const adf = {
			type: "doc",
			content: [
				{ type: "paragraph", content: [{ type: "text", text: "Hello" }] },
				{ type: "paragraph", content: [{ type: "text", text: " world" }] },
			],
		};
		expect(extractJiraText(adf)).toBe("Hello world");
	});
});

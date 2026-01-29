import { describe, expect, it } from "vitest";
import { expandToolGroups } from "../../src/lib/tools/policy.js";

describe("tool policy groups", () => {
	it("expands tracker group to include command tools", () => {
		const expanded = expandToolGroups(["group:tracker"]);
		expect(expanded).toContain("yandex_tracker_search");
		expect(expanded).toContain("issue_get");
		expect(expanded).toContain("issue_get_comments");
		expect(expanded).toContain("issue_get_url");
	});

	it("expands jira group to include issue fetch tools", () => {
		const expanded = expandToolGroups(["group:jira"]);
		expect(expanded).toContain("jira_search");
		expect(expanded).toContain("jira_issues_find");
		expect(expanded).toContain("jira_issue_get");
		expect(expanded).toContain("jira_issue_get_comments");
		expect(expanded).toContain("jira_sprint_issues");
	});
});

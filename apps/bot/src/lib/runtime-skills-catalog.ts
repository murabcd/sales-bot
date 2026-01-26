import type { RuntimeSkill } from "../skills-core.js";
import { POSTHOG_READONLY_TOOL_NAMES } from "./posthog-tools.js";

export function buildBuiltinRuntimeSkills(): RuntimeSkill[] {
	const skills: RuntimeSkill[] = [
		{
			name: "tracker_search",
			description:
				"Search Yandex Tracker issues using keywords from the question.",
			tool: "tracker.tracker_search",
		},
		{
			name: "web_search",
			description: "Search the web for up-to-date information.",
			tool: "web.web_search",
		},
		{
			name: "jira_search",
			description: "Search Jira issues in a project.",
			tool: "jira.jira_search",
		},
		{
			name: "jira_sprint_issues",
			description: "List Jira issues for a sprint by name or id.",
			tool: "jira.jira_sprint_issues",
		},
		{
			name: "jira_issues_find",
			description: "Search Jira issues using JQL.",
			tool: "jira.jira_issues_find",
		},
		{
			name: "jira_issue_get",
			description: "Get Jira issue by key (e.g., FL-123).",
			tool: "jira.jira_issue_get",
		},
		{
			name: "jira_issue_get_comments",
			description: "Get comments for a Jira issue by key.",
			tool: "jira.jira_issue_get_comments",
		},
		{
			name: "searchMemories",
			description: "Search saved memories (Supermemory).",
			tool: "memory.searchMemories",
		},
		{
			name: "addMemory",
			description: "Store memory (Supermemory).",
			tool: "memory.addMemory",
		},
	];

	for (const name of POSTHOG_READONLY_TOOL_NAMES) {
		skills.push({
			name,
			description: "PostHog read-only tool",
			tool: `posthog.${name}`,
		});
	}

	return skills;
}

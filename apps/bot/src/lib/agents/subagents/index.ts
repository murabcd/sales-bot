import type { ToolSet } from "ai";
import { POSTHOG_READONLY_TOOL_NAMES } from "../../posthog-tools.js";
import { pickTools } from "./tools.js";

export function buildTrackerTools(allTools: ToolSet): ToolSet {
	return pickTools(allTools, ["tracker_search"]);
}

export function buildJiraTools(allTools: ToolSet): ToolSet {
	return pickTools(allTools, ["jira_search", "jira_sprint_issues"]);
}

export function buildWebTools(allTools: ToolSet): ToolSet {
	return pickTools(allTools, ["web_search"]);
}

export function buildMemoryTools(allTools: ToolSet): ToolSet {
	return pickTools(allTools, ["searchMemories", "addMemory"]);
}

export function buildPosthogTools(allTools: ToolSet): ToolSet {
	return pickTools(allTools, Array.from(POSTHOG_READONLY_TOOL_NAMES));
}

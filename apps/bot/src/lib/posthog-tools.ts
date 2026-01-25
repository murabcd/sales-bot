import type { ToolSet } from "ai";

export const POSTHOG_READONLY_TOOL_NAMES = new Set([
	"actions-get-all",
	"action-get",
	"dashboards-get-all",
	"dashboard-get",
	"docs-search",
	"error-details",
	"list-errors",
	"event-definitions-list",
	"properties-list",
	"experiment-get",
	"experiment-get-all",
	"experiment-results-get",
	"feature-flag-get-all",
	"feature-flag-get-definition",
	"insight-get",
	"insight-query",
	"insights-get-all",
	"query-generate-hogql-from-question",
	"query-run",
	"get-llm-total-costs-for-project",
	"logs-list-attribute-values",
	"logs-list-attributes",
	"logs-query",
	"organization-details-get",
	"organizations-get",
	"projects-get",
	"property-definitions",
	"entity-search",
	"survey-get",
	"survey-stats",
	"surveys-get-all",
	"surveys-global-stats",
]);

export function filterPosthogTools(tools: ToolSet): ToolSet {
	const filtered: ToolSet = {};
	for (const [name, tool] of Object.entries(tools)) {
		if (POSTHOG_READONLY_TOOL_NAMES.has(name)) {
			filtered[name] = tool;
		}
	}
	return filtered;
}

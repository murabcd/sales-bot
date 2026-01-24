import { normalizeToolName, type ToolMeta } from "./registry.js";

export type ToolPolicy = {
	allow?: string[];
	deny?: string[];
};

export const TOOL_GROUPS: Record<string, string[]> = {
	"group:web": ["web_search"],
	"group:tracker": [
		"tracker_search",
		"issues_find",
		"issue_get",
		"issue_get_comments",
		"issue_get_url",
	],
	"group:jira": [
		"jira_search",
		"jira_issues_find",
		"jira_issue_get",
		"jira_issue_get_comments",
		"jira_sprint_issues",
	],
	"group:posthog": [
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
	],
	"group:memory": ["searchmemories", "addmemory"],
	"group:runtime-skills": [],
};

export function expandToolGroups(list?: string[]): string[] {
	if (!list) return [];
	const expanded: string[] = [];
	for (const entry of list) {
		const normalized = normalizeToolName(entry);
		const group = TOOL_GROUPS[normalized];
		if (group) {
			expanded.push(...group);
			continue;
		}
		expanded.push(normalized);
	}
	return Array.from(new Set(expanded));
}

export function isToolAllowed(name: string, policy?: ToolPolicy): boolean {
	if (!policy) return true;
	const deny = new Set(expandToolGroups(policy.deny));
	const allowExpanded = expandToolGroups(policy.allow);
	const allow = allowExpanded.length > 0 ? new Set(allowExpanded) : null;
	const normalized = normalizeToolName(name);
	if (deny.has(normalized)) return false;
	if (allow) return allow.has(normalized);
	return true;
}

export function filterToolMetasByPolicy(
	tools: ToolMeta[],
	policy?: ToolPolicy,
): ToolMeta[] {
	if (!policy) return tools;
	return tools.filter((tool) => isToolAllowed(tool.name, policy));
}

export function filterToolMapByPolicy<T extends Record<string, unknown>>(
	tools: T,
	policy?: ToolPolicy,
): { tools: T; suppressed: string[] } {
	if (!policy) return { tools, suppressed: [] };
	const next = {} as T;
	const suppressed: string[] = [];
	for (const [name, tool] of Object.entries(tools)) {
		if (isToolAllowed(name, policy)) {
			(next as Record<string, unknown>)[name] = tool;
		} else {
			suppressed.push(name);
		}
	}
	return { tools: next, suppressed };
}

export function mergeToolPolicies(
	base?: ToolPolicy,
	override?: ToolPolicy,
): ToolPolicy | undefined {
	if (!base && !override) return undefined;
	return {
		allow: [...(base?.allow ?? []), ...(override?.allow ?? [])],
		deny: [...(base?.deny ?? []), ...(override?.deny ?? [])],
	};
}

export function parseToolPolicyFromEnv(
	env: Record<string, string | undefined>,
): ToolPolicy | undefined {
	return parseToolPolicyFromRaw(
		env.TOOL_ALLOWLIST ?? "",
		env.TOOL_DENYLIST ?? "",
	);
}

export function parseToolPolicyVariants(
	env: Record<string, string | undefined>,
) {
	return {
		base: parseToolPolicyFromRaw(
			env.TOOL_ALLOWLIST ?? "",
			env.TOOL_DENYLIST ?? "",
		),
		dm: parseToolPolicyFromRaw(
			env.TOOL_ALLOWLIST_DM ?? "",
			env.TOOL_DENYLIST_DM ?? "",
		),
		group: parseToolPolicyFromRaw(
			env.TOOL_ALLOWLIST_GROUP ?? "",
			env.TOOL_DENYLIST_GROUP ?? "",
		),
	};
}

function parseToolPolicyFromRaw(
	allowRaw: string,
	denyRaw: string,
): ToolPolicy | undefined {
	const allow = allowRaw
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
	const deny = denyRaw
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
	if (allow.length === 0 && deny.length === 0) return undefined;
	return {
		allow: allow.length ? allow : undefined,
		deny: deny.length ? deny : undefined,
	};
}

import type { CandidateIssue } from "../context/chat-state.js";
import { buildSystemPrompt } from "./system-prompt.js";

export type AgentInstructionOptions = {
	question: string;
	modelRef: string;
	modelName: string;
	reasoning: string;
	toolLines: string;
	recentCandidates?: CandidateIssue[];
	history?: string;
	userName?: string;
	systemPrompt?: string;
	globalSoul?: string;
	channelSoul?: string;
};

function buildSoulBlock(params: {
	globalSoul?: string;
	channelSoul?: string;
	systemPrompt?: string;
}): string {
	const sections: string[] = [];
	const globalSoul = params.globalSoul?.trim();
	if (globalSoul) {
		sections.push("SOUL (global):", globalSoul);
	}
	const channelSoul = (params.channelSoul ?? params.systemPrompt)?.trim();
	if (channelSoul) {
		sections.push("SOUL (channel):", channelSoul);
	}
	return sections.join("\n");
}

export function buildAgentInstructions(
	options: AgentInstructionOptions,
): string {
	const recentBlock = options.recentCandidates?.length
		? [
				"Recent candidates (most relevant first):",
				...options.recentCandidates
					.filter((item) => item.key)
					.map((item) =>
						`${item.key} — ${item.summary || "(no summary)"}`.trim(),
					),
				"",
				"Rule: If the user refers to these candidates, do NOT run tracker_search again.",
				"Instead, use issue_get and issue_get_comments for the candidate keys.",
				"",
			].join("\n")
		: "";

	const soulBlock = buildSoulBlock(options);

	const toolSections: string[] = [
		"Tool Use:",
		"- Use the appropriate tool for the task. Summarize results in Russian and do not invent facts.",
		"- If a tool is blocked with approval_required, ask the user to run /approve <tool> and retry.",
		"- Always include required params for each tool.",
	];

	if (options.toolLines.includes("tracker_search")) {
		toolSections.push(
			"- Use `tracker_search` for Yandex Tracker keyword queries, `issue_get` for specific issues.",
			"- If search returns ambiguous=true with candidates, ask the user to pick the correct issue key (list up to 3).",
		);
	}

	if (options.toolLines.includes("jira_search")) {
		toolSections.push(
			"- Use `jira_search` for Jira keyword queries, `jira_issue_get` for specific issues, `jira_sprint_issues` for sprints.",
		);
	}

	if (options.toolLines.includes("web_search")) {
		toolSections.push(
			"- Use `web_search` for up-to-date information (news, prices, public facts). Include a short Sources list with URLs.",
		);
	}

	if (
		options.toolLines.includes("searchMemories") ||
		options.toolLines.includes("addMemory")
	) {
		toolSections.push(
			"- Use `searchMemories` to recall prior context, `addMemory` to store durable facts.",
		);
	}

	if (
		options.toolLines.includes("posthog") ||
		options.toolLines.includes("insights") ||
		options.toolLines.includes("survey")
	) {
		toolSections.push(
			"- Use PostHog tools for analytics: insights, surveys, experiments, feature flags, dashboards.",
		);
	}

	if (
		options.toolLines.includes("cron_schedule") ||
		options.toolLines.includes("cron_list")
	) {
		toolSections.push(
			"- Use cron tools to schedule recurring reports or reminders.",
		);
	}

	return [
		buildSystemPrompt({
			modelRef: options.modelRef,
			modelName: options.modelName,
			reasoning: options.reasoning,
		}),
		soulBlock ? `\n${soulBlock}` : "",
		...toolSections,
		"",
		"Available tools:",
		options.toolLines || "(none)",
		"",
		options.history ?? "",
		options.userName ? `User name: ${options.userName}` : "",
		recentBlock,
		`User: ${options.question}`,
	].join("\n");
}

export type IssueInstructionOptions = {
	question: string;
	modelRef: string;
	modelName: string;
	reasoning: string;
	issueKey: string;
	issueText: string;
	commentsText: string;
	userName?: string;
	globalSoul?: string;
	channelSoul?: string;
	systemPrompt?: string;
};

export function buildIssueAgentInstructions(
	options: IssueInstructionOptions,
): string {
	const soulBlock = buildSoulBlock(options);
	return [
		buildSystemPrompt({
			modelRef: options.modelRef,
			modelName: options.modelName,
			reasoning: options.reasoning,
		}),
		soulBlock ? `\n${soulBlock}` : "",
		"Context:",
		`Issue key: ${options.issueKey}`,
		"Issue data (issue_get):",
		options.issueText || "(empty)",
		"Comments (issue_get_comments):",
		options.commentsText || "(empty)",
		"Rules:",
		"- Use the provided issue data and comments to answer.",
		"- Do not ask for issue_id; it is already provided.",
		"- If price/status/terms are not present in data, say they are not recorded.",
		options.userName ? `User name: ${options.userName}` : "",
		`User: ${options.question}`,
	].join("\n");
}

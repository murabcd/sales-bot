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
};

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

	return [
		buildSystemPrompt({
			modelRef: options.modelRef,
			modelName: options.modelName,
			reasoning: options.reasoning,
		}),
		"Tool Use:",
		"- Prefer `tracker_search` for integration/status/estimate questions when no exact issue key is provided.",
		"- Use Tracker tools when needed. If you use tools, summarize results in Russian and do not invent facts.",
		"- Always include required params. Example: issues_find requires query; issue_get and issue_get_comments require issue_id.",
		"- If tracker_search returns ambiguous=true with candidates, ask the user to pick the correct issue key (list up to 3 keys).",
		"- Be concise and helpful; expand only if asked.",
		"",
		"Available Tracker tools:",
		options.toolLines || "(none)",
		"",
		options.history ?? "",
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
};

export function buildIssueAgentInstructions(
	options: IssueInstructionOptions,
): string {
	return [
		buildSystemPrompt({
			modelRef: options.modelRef,
			modelName: options.modelName,
			reasoning: options.reasoning,
		}),
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
		"- Be concise and helpful; expand only if asked.",
		`User: ${options.question}`,
	].join("\n");
}

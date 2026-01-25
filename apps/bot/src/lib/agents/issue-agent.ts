import { openai } from "@ai-sdk/openai";
import { stepCountIs, ToolLoopAgent } from "ai";
import { buildIssueAgentInstructions } from "../prompts/agent-instructions.js";
import { truncateText } from "../text/normalize.js";

export type IssueAgentOptions = {
	question: string;
	modelRef: string;
	modelName: string;
	reasoning: string;
	issueKey: string;
	issueText: string;
	commentsText: string;
	modelId: string;
	userName?: string;
};

export async function createIssueAgent(
	options: IssueAgentOptions,
): Promise<ToolLoopAgent> {
	const instructions = buildIssueAgentInstructions({
		question: options.question,
		modelRef: options.modelRef,
		modelName: options.modelName,
		reasoning: options.reasoning,
		issueKey: options.issueKey,
		issueText: options.issueText,
		commentsText: options.commentsText,
		userName: options.userName,
	});
	return new ToolLoopAgent({
		model: openai(options.modelId),
		instructions,
		tools: {},
		stopWhen: stepCountIs(2),
	});
}

export type MultiIssueAgentOptions = {
	question: string;
	modelRef: string;
	modelName: string;
	reasoning: string;
	modelId: string;
	issues: Array<{
		key: string;
		issueText: string;
		commentsText: string;
	}>;
	userName?: string;
};

export async function createMultiIssueAgent(
	options: MultiIssueAgentOptions,
): Promise<ToolLoopAgent> {
	const issueBlocks = options.issues
		.map((issue) =>
			[
				`Issue key: ${issue.key}`,
				"Issue data (issue_get):",
				truncateText(issue.issueText, 4000),
				"Comments (issue_get_comments):",
				truncateText(issue.commentsText, 4000),
				"---",
			].join("\n"),
		)
		.join("\n");
	const instructions = [
		buildIssueAgentInstructions({
			question: options.question,
			modelRef: options.modelRef,
			modelName: options.modelName,
			reasoning: options.reasoning,
			issueKey: "(multiple)",
			issueText: "",
			commentsText: "",
			userName: options.userName,
		}),
		"Rules:",
		"- Use the provided issue data and comments to answer.",
		"- Provide a short summary for each issue.",
		"- Output format: '<KEY> — <summary>' (one line per issue).",
		"- If price/status/terms are not present in data, say they are not recorded.",
		"- Be concise: 1 short sentence per issue.",
		`User: ${options.question}`,
		"Context:",
		issueBlocks || "(empty)",
	].join("\n");

	return new ToolLoopAgent({
		model: openai(options.modelId),
		instructions,
		tools: {},
		stopWhen: stepCountIs(2),
	});
}

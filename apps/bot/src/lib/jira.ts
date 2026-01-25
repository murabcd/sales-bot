import { expandTermVariants, extractKeywords } from "./text/normalize.js";

export type JiraIssue = {
	id?: string;
	key?: string;
	fields?: {
		summary?: string;
		description?: unknown;
		status?: { name?: string };
		assignee?: { displayName?: string };
		duedate?: string;
		priority?: { name?: string };
		comment?: {
			comments?: Array<{
				body?: unknown;
			}>;
		};
	};
};

export function extractJiraText(node: unknown, limit = 8000): string {
	const parts: string[] = [];
	const push = (text: string) => {
		if (!text) return;
		parts.push(text);
	};
	const walk = (value: unknown) => {
		if (parts.join("").length > limit) return;
		if (!value) return;
		if (typeof value === "string") {
			push(value);
			return;
		}
		if (Array.isArray(value)) {
			for (const item of value) walk(item);
			return;
		}
		if (typeof value !== "object") return;
		const rec = value as Record<string, unknown>;
		if (typeof rec.text === "string") {
			push(rec.text);
		}
		const content = rec.content;
		if (Array.isArray(content)) {
			for (const item of content) walk(item);
		}
	};
	walk(node);
	return parts.join("").trim().slice(0, limit);
}

export function buildJiraJql(question: string, projectKey: string): string {
	const terms = extractKeywords(question);
	if (!terms.length) {
		const safe = question.replaceAll('"', "");
		return `project = ${projectKey} AND (summary ~ "${safe}" OR description ~ "${safe}")`;
	}
	const expanded = terms.flatMap((term) => expandTermVariants(term));
	const unique = Array.from(new Set(expanded));
	const orTerms = unique.flatMap((term) => {
		const safe = term.replaceAll('"', "");
		return [`summary ~ "${safe}"`, `description ~ "${safe}"`];
	});
	return `project = ${projectKey} AND (${orTerms.join(" OR ")})`;
}

export function normalizeJiraIssue(issue: JiraIssue) {
	const key = issue.key ?? "";
	const summary =
		typeof issue.fields?.summary === "string" ? issue.fields.summary : "";
	const description = extractJiraText(issue.fields?.description);
	return { key, summary, description };
}

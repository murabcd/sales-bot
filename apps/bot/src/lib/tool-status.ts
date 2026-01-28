import { POSTHOG_READONLY_TOOL_NAMES } from "./posthog-tools.js";
import { createMessagingDedupe } from "./tools/messaging-dedupe.js";

export type ToolStatusOptions = {
	delayMs?: number;
	webMessage?: string;
	trackerMessage?: string;
	jiraMessage?: string;
	posthogMessage?: string;
	memoryMessage?: string;
	cronMessage?: string;
};

export function createToolStatusHandler(
	sendReply: (message: string) => Promise<void> | void,
	options: ToolStatusOptions = {},
) {
	const delayMs = options.delayMs ?? 1500;
	const webMessage = options.webMessage ?? "Ищу в интернете…";
	const trackerMessage = options.trackerMessage ?? "Проверяю в Tracker…";
	const jiraMessage = options.jiraMessage ?? "Проверяю в Jira…";
	const posthogMessage = options.posthogMessage ?? "Смотрю аналитику…";
	const memoryMessage = options.memoryMessage ?? "Смотрю историю…";
	const cronMessage = options.cronMessage ?? "Настраиваю расписание…";
	const toolStatusSent = new Set<string>();
	const toolStatusTimers = new Map<string, ReturnType<typeof setTimeout>>();
	const { record, shouldSend } = createMessagingDedupe();
	const jiraTools = new Set([
		"jira_search",
		"jira_sprint_issues",
		"jira_issues_find",
		"jira_issue_get",
		"jira_issue_get_comments",
	]);
	const memoryTools = new Set(["searchMemories", "addMemory"]);
	const cronTools = new Set(["cron_schedule", "cron_list", "cron_remove"]);

	const scheduleStatus = (key: string, message: string) => {
		if (toolStatusSent.has(key) || toolStatusTimers.has(key)) return;
		const timer = setTimeout(() => {
			if (!shouldSend(message)) return;
			record(message);
			void sendReply(message);
			toolStatusSent.add(key);
			toolStatusTimers.delete(key);
		}, delayMs);
		toolStatusTimers.set(key, timer);
	};

	const clearStatus = (key: string) => {
		const timer = toolStatusTimers.get(key);
		if (timer) {
			clearTimeout(timer);
			toolStatusTimers.delete(key);
		}
	};

	const clearAllStatuses = () => {
		clearStatus("web_search");
		clearStatus("tracker_search");
		clearStatus("jira");
		clearStatus("posthog");
		clearStatus("memory");
		clearStatus("cron");
	};

	const onToolStep = (toolNames: string[]) => {
		const hasWeb = toolNames.includes("web_search");
		const hasTracker = toolNames.includes("tracker_search");
		const hasJira = toolNames.some((name) => jiraTools.has(name));
		const hasPosthog = toolNames.some((name) =>
			POSTHOG_READONLY_TOOL_NAMES.has(name),
		);
		const hasMemory = toolNames.some((name) => memoryTools.has(name));
		const hasCron = toolNames.some((name) => cronTools.has(name));
		if (hasWeb) scheduleStatus("web_search", webMessage);
		if (hasTracker) scheduleStatus("tracker_search", trackerMessage);
		if (hasJira) scheduleStatus("jira", jiraMessage);
		if (hasPosthog) scheduleStatus("posthog", posthogMessage);
		if (hasMemory) scheduleStatus("memory", memoryMessage);
		if (hasCron) scheduleStatus("cron", cronMessage);
		if (!hasWeb) clearStatus("web_search");
		if (!hasTracker) clearStatus("tracker_search");
		if (!hasJira) clearStatus("jira");
		if (!hasPosthog) clearStatus("posthog");
		if (!hasMemory) clearStatus("memory");
		if (!hasCron) clearStatus("cron");
	};

	const onToolStart = (toolName: string) => {
		if (toolName === "web_search") scheduleStatus("web_search", webMessage);
		if (toolName === "tracker_search")
			scheduleStatus("tracker_search", trackerMessage);
		if (jiraTools.has(toolName)) scheduleStatus("jira", jiraMessage);
		if (POSTHOG_READONLY_TOOL_NAMES.has(toolName))
			scheduleStatus("posthog", posthogMessage);
		if (memoryTools.has(toolName)) scheduleStatus("memory", memoryMessage);
		if (cronTools.has(toolName)) scheduleStatus("cron", cronMessage);
	};

	return { onToolStart, onToolStep, clearAllStatuses };
}

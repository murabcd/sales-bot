export type ToolStatusOptions = {
	delayMs?: number;
	webMessage?: string;
	trackerMessage?: string;
};

export function createToolStatusHandler(
	sendReply: (message: string) => Promise<void> | void,
	options: ToolStatusOptions = {},
) {
	const delayMs = options.delayMs ?? 1500;
	const webMessage = options.webMessage ?? "Ищу в интернете…";
	const trackerMessage = options.trackerMessage ?? "Проверяю в Tracker…";
	const toolStatusSent = new Set<string>();
	const toolStatusTimers = new Map<string, ReturnType<typeof setTimeout>>();

	const scheduleStatus = (key: string, message: string) => {
		if (toolStatusSent.has(key) || toolStatusTimers.has(key)) return;
		const timer = setTimeout(() => {
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
	};

	const onToolStep = (toolNames: string[]) => {
		const hasWeb = toolNames.includes("web_search");
		const hasTracker = toolNames.includes("tracker_search");
		if (hasWeb) scheduleStatus("web_search", webMessage);
		if (hasTracker) scheduleStatus("tracker_search", trackerMessage);
		if (!hasWeb) clearStatus("web_search");
		if (!hasTracker) clearStatus("tracker_search");
	};

	return { onToolStep, clearAllStatuses };
}

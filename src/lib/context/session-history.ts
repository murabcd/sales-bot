import { addMemoryTool, searchMemoriesTool } from "@supermemory/tools/ai-sdk";

export type HistoryMessage = {
	timestamp: string;
	role: "user" | "assistant";
	text: string;
};

type MemorySearchResult = {
	content?: string;
};

type MemorySearchResponse = {
	success: boolean;
	results?: MemorySearchResult[];
	count?: number;
	error?: string;
};

type SupermemoryConfig = {
	apiKey: string;
	projectId?: string;
	tagPrefix: string;
};

let supermemoryConfig: SupermemoryConfig = {
	apiKey: "",
	projectId: undefined,
	tagPrefix: "telegram:user:",
};

export function setSupermemoryConfig(config: SupermemoryConfig) {
	supermemoryConfig = config;
}

function buildToolOptions(chatId: string) {
	const containerTags = [`${supermemoryConfig.tagPrefix}${chatId}`];
	return supermemoryConfig.projectId
		? { projectId: supermemoryConfig.projectId, containerTags }
		: { containerTags };
}

function parseMemory(content: string): HistoryMessage | null {
	try {
		const parsed = JSON.parse(content) as HistoryMessage;
		if (parsed?.role && parsed?.text && parsed?.timestamp) return parsed;
	} catch {
		// ignore parse errors
	}
	return null;
}

export async function appendHistoryMessage(
	_baseDir: string,
	chatId: string,
	message: HistoryMessage,
): Promise<void> {
	if (!supermemoryConfig.apiKey || !chatId) return;
	try {
		const addMemory = addMemoryTool(
			supermemoryConfig.apiKey,
			buildToolOptions(chatId),
		);
		if (!addMemory.execute) return;
		await addMemory.execute(
			{ memory: JSON.stringify(message) },
			{
				toolCallId: "supermemory:addMemory",
				messages: [],
			},
		);
	} catch {
		// ignore memory write errors to avoid breaking runtime
	}
}

export async function loadHistoryMessages(
	_baseDir: string,
	chatId: string,
	limit: number,
	query: string,
): Promise<HistoryMessage[]> {
	if (!supermemoryConfig.apiKey || !chatId || !query) return [];
	try {
		const searchMemories = searchMemoriesTool(
			supermemoryConfig.apiKey,
			buildToolOptions(chatId),
		);
		if (!searchMemories.execute) return [];
		const result = (await searchMemories.execute(
			{ informationToGet: query, includeFullDocs: false, limit: limit || 20 },
			{ toolCallId: "supermemory:searchMemories", messages: [] },
		)) as MemorySearchResponse | AsyncIterable<MemorySearchResponse>;
		const resolved =
			typeof (result as AsyncIterable<MemorySearchResponse>)[
				Symbol.asyncIterator
			] === "function"
				? await (async () => {
						let last: MemorySearchResponse | null = null;
						for await (const chunk of result as AsyncIterable<MemorySearchResponse>) {
							last = chunk;
						}
						return last ?? { success: false };
					})()
				: (result as MemorySearchResponse);
		const raw = resolved?.results ?? [];
		const parsed = raw
			.map((entry: MemorySearchResult) =>
				entry?.content ? parseMemory(entry.content) : null,
			)
			.filter(
				(item: HistoryMessage | null): item is HistoryMessage => item !== null,
			);
		const sorted = parsed.sort((a, b) =>
			a.timestamp.localeCompare(b.timestamp),
		);
		return limit > 0 ? sorted.slice(-limit) : sorted;
	} catch {
		return [];
	}
}

export function clearHistoryMessages(_baseDir: string, _chatId: string): void {
	// Supermemory doesn't support fast per-user clears via tools.
	// Keep as no-op to avoid breaking command flow.
}

export function formatHistoryForPrompt(messages: HistoryMessage[]): string {
	if (!messages.length) return "";
	const lines = messages.map((msg) => {
		const role = msg.role === "user" ? "User" : "Assistant";
		return `${role}: ${msg.text}`;
	});
	return ["Relevant memories:", ...lines, ""].join("\n");
}

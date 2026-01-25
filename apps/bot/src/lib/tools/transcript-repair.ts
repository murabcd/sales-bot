type ToolCallLike = {
	id: string;
	name?: string;
};

function extractToolCallsFromAssistant(
	message: Record<string, unknown>,
): ToolCallLike[] {
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return [];
	const toolCalls: ToolCallLike[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const rec = block as { type?: unknown; id?: unknown; name?: unknown };
		if (typeof rec.id !== "string" || !rec.id) continue;
		if (
			rec.type === "toolCall" ||
			rec.type === "toolUse" ||
			rec.type === "functionCall"
		) {
			toolCalls.push({
				id: rec.id,
				name: typeof rec.name === "string" ? rec.name : undefined,
			});
		}
	}
	return toolCalls;
}

function extractToolResultId(message: Record<string, unknown>): string | null {
	const toolCallId = (message as { toolCallId?: unknown }).toolCallId;
	if (typeof toolCallId === "string" && toolCallId) return toolCallId;
	const toolUseId = (message as { toolUseId?: unknown }).toolUseId;
	if (typeof toolUseId === "string" && toolUseId) return toolUseId;
	return null;
}

function makeMissingToolResult(params: {
	toolCallId: string;
	toolName?: string;
}): Record<string, unknown> {
	return {
		role: "toolResult",
		toolCallId: params.toolCallId,
		toolName: params.toolName ?? "unknown",
		content: [
			{
				type: "text",
				text: "[omni] missing tool result in transcript; inserted synthetic error result.",
			},
		],
		isError: true,
		timestamp: Date.now(),
	};
}

export type ToolUseRepairReport<T extends Record<string, unknown>> = {
	messages: T[];
	added: T[];
	droppedDuplicateCount: number;
	droppedOrphanCount: number;
	moved: boolean;
};

export function repairToolUseResultPairing<T extends Record<string, unknown>>(
	messages: T[],
): ToolUseRepairReport<T> {
	const out: T[] = [];
	const added: T[] = [];
	const seenToolResultIds = new Set<string>();
	let droppedDuplicateCount = 0;
	let droppedOrphanCount = 0;
	let moved = false;
	let changed = false;

	const pushToolResult = (msg: Record<string, unknown>) => {
		const id = extractToolResultId(msg);
		if (id && seenToolResultIds.has(id)) {
			droppedDuplicateCount += 1;
			changed = true;
			return;
		}
		if (id) seenToolResultIds.add(id);
		out.push(msg as T);
	};

	for (let i = 0; i < messages.length; i += 1) {
		const msg = messages[i];
		if (!msg || typeof msg !== "object") {
			out.push(msg as T);
			continue;
		}
		const role = (msg as { role?: unknown }).role;
		if (role !== "assistant") {
			if (role !== "toolResult") {
				out.push(msg as T);
			} else {
				droppedOrphanCount += 1;
				changed = true;
			}
			continue;
		}

		const toolCalls = extractToolCallsFromAssistant(msg);
		if (toolCalls.length === 0) {
			out.push(msg as T);
			continue;
		}

		const toolCallIds = new Set(toolCalls.map((call) => call.id));
		const spanResultsById = new Map<string, Record<string, unknown>>();
		const remainder: Array<Record<string, unknown>> = [];

		let j = i + 1;
		for (; j < messages.length; j += 1) {
			const next = messages[j];
			if (!next || typeof next !== "object") {
				remainder.push(next);
				continue;
			}
			const nextRole = (next as { role?: unknown }).role;
			if (nextRole === "assistant") break;
			if (nextRole === "toolResult") {
				const id = extractToolResultId(next);
				if (id && toolCallIds.has(id)) {
					if (seenToolResultIds.has(id) || spanResultsById.has(id)) {
						droppedDuplicateCount += 1;
						changed = true;
						continue;
					}
					if (!spanResultsById.has(id)) {
						spanResultsById.set(id, next);
					}
					continue;
				}
			}

			if (nextRole !== "toolResult") {
				remainder.push(next);
			} else {
				droppedOrphanCount += 1;
				changed = true;
			}
		}

		out.push(msg as T);

		if (spanResultsById.size > 0 && remainder.length > 0) {
			moved = true;
			changed = true;
		}

		for (const call of toolCalls) {
			const existing = spanResultsById.get(call.id);
			if (existing) {
				pushToolResult(existing);
			} else {
				const missing = makeMissingToolResult({
					toolCallId: call.id,
					toolName: call.name,
				});
				added.push(missing as T);
				changed = true;
				pushToolResult(missing);
			}
		}

		for (const rem of remainder) {
			if (!rem || typeof rem !== "object") {
				out.push(rem as T);
				continue;
			}
			out.push(rem as T);
		}
		i = j - 1;
	}

	return {
		messages: changed || moved ? out : messages,
		added,
		droppedDuplicateCount,
		droppedOrphanCount,
		moved,
	};
}

import { createHash } from "node:crypto";

export function sanitizeToolCallId(id: string): string {
	if (!id || typeof id !== "string") return "default_tool_id";
	const replaced = id.replace(/[^a-zA-Z0-9_-]/g, "_");
	const trimmed = replaced.replace(/^[^a-zA-Z0-9_-]+/, "");
	return trimmed.length > 0 ? trimmed : "sanitized_tool_id";
}

function shortHash(text: string): string {
	return createHash("sha1").update(text).digest("hex").slice(0, 8);
}

function makeUniqueToolId(params: { id: string; used: Set<string> }): string {
	const maxLen = 40;
	const base = sanitizeToolCallId(params.id).slice(0, maxLen);
	if (!params.used.has(base)) return base;

	const hash = shortHash(params.id);
	const maxBaseLen = maxLen - 1 - hash.length;
	const clippedBase =
		base.length > maxBaseLen ? base.slice(0, maxBaseLen) : base;
	const candidate = `${clippedBase}_${hash}`;
	if (!params.used.has(candidate)) return candidate;

	for (let i = 2; i < 1000; i += 1) {
		const suffix = `_${i}`;
		const next = `${candidate.slice(0, maxLen - suffix.length)}${suffix}`;
		if (!params.used.has(next)) return next;
	}

	const ts = `_${Date.now()}`;
	return `${candidate.slice(0, maxLen - ts.length)}${ts}`;
}

function rewriteAssistantToolCallIds(params: {
	message: Record<string, unknown>;
	resolve: (id: string) => string;
}): Record<string, unknown> {
	const content = params.message.content;
	if (!Array.isArray(content)) return params.message;

	let changed = false;
	const next = content.map((block) => {
		if (!block || typeof block !== "object") return block;
		const rec = block as { type?: unknown; id?: unknown };
		const type = rec.type;
		const id = rec.id;
		if (
			(type !== "functionCall" && type !== "toolUse" && type !== "toolCall") ||
			typeof id !== "string" ||
			!id
		) {
			return block;
		}
		const nextId = params.resolve(id);
		if (nextId === id) return block;
		changed = true;
		return { ...(block as Record<string, unknown>), id: nextId };
	});

	if (!changed) return params.message;
	return { ...params.message, content: next };
}

function rewriteToolResultIds(params: {
	message: Record<string, unknown>;
	resolve: (id: string) => string;
}): Record<string, unknown> {
	const toolCallId =
		typeof (params.message as { toolCallId?: unknown }).toolCallId === "string"
			? ((params.message as { toolCallId?: unknown }).toolCallId as string)
			: undefined;
	const toolUseId =
		typeof (params.message as { toolUseId?: unknown }).toolUseId === "string"
			? ((params.message as { toolUseId?: unknown }).toolUseId as string)
			: undefined;

	const nextToolCallId = toolCallId ? params.resolve(toolCallId) : undefined;
	const nextToolUseId = toolUseId ? params.resolve(toolUseId) : undefined;

	if (nextToolCallId === toolCallId && nextToolUseId === toolUseId) {
		return params.message;
	}

	return {
		...params.message,
		...(nextToolCallId && { toolCallId: nextToolCallId }),
		...(nextToolUseId && { toolUseId: nextToolUseId }),
	};
}

export function sanitizeToolCallIdsForTranscript<
	T extends Record<string, unknown>,
>(messages: T[]): T[] {
	const map = new Map<string, string>();
	const used = new Set<string>();

	const resolve = (id: string) => {
		const existing = map.get(id);
		if (existing) return existing;
		const next = makeUniqueToolId({ id, used });
		map.set(id, next);
		used.add(next);
		return next;
	};

	let changed = false;
	const out = messages.map((msg) => {
		if (!msg || typeof msg !== "object") return msg;
		const role = (msg as { role?: unknown }).role;
		if (role === "assistant") {
			const next = rewriteAssistantToolCallIds({ message: msg, resolve });
			if (next !== msg) changed = true;
			return next;
		}
		if (role === "toolResult") {
			const next = rewriteToolResultIds({ message: msg, resolve });
			if (next !== msg) changed = true;
			return next;
		}
		return msg;
	});

	return (changed ? out : messages) as T[];
}

import { expandToolGroups } from "./policy.js";
import { normalizeToolName } from "./registry.js";

export type SenderToolAccess = {
	allowUserIds: Set<string>;
	denyUserIds: Set<string>;
	allowUserTools: Map<string, Set<string>>;
	denyUserTools: Map<string, Set<string>>;
	allowChatTools: Map<string, Set<string>>;
	denyChatTools: Map<string, Set<string>>;
};

function parseList(raw: string): Set<string> {
	return new Set(
		raw
			.split(",")
			.map((entry) => entry.trim())
			.filter(Boolean),
	);
}

function parseToolMap(raw: string): Map<string, Set<string>> {
	const map = new Map<string, Set<string>>();
	if (!raw.trim()) return map;
	const entries = raw
		.split(";")
		.map((entry) => entry.trim())
		.filter(Boolean);
	for (const entry of entries) {
		const colonIndex = entry.indexOf(":");
		if (colonIndex <= 0) continue;
		const idPart = entry.slice(0, colonIndex).trim();
		const toolsPart = entry.slice(colonIndex + 1).trim();
		if (!idPart || !toolsPart) continue;
		const expanded = expandToolGroups(
			toolsPart.split("|").map((tool) => tool.trim()),
		);
		const normalized = expanded.map((tool) => normalizeToolName(tool));
		map.set(idPart, new Set(normalized));
	}
	return map;
}

export function parseSenderToolAccess(options: {
	allowUserIds?: string;
	denyUserIds?: string;
	allowUserTools?: string;
	denyUserTools?: string;
	allowChatTools?: string;
	denyChatTools?: string;
}): SenderToolAccess {
	return {
		allowUserIds: parseList(options.allowUserIds ?? ""),
		denyUserIds: parseList(options.denyUserIds ?? ""),
		allowUserTools: parseToolMap(options.allowUserTools ?? ""),
		denyUserTools: parseToolMap(options.denyUserTools ?? ""),
		allowChatTools: parseToolMap(options.allowChatTools ?? ""),
		denyChatTools: parseToolMap(options.denyChatTools ?? ""),
	};
}

function isToolAllowedByMap(
	id: string | undefined,
	toolName: string,
	map: Map<string, Set<string>>,
): boolean | null {
	if (!id) return null;
	const tools = map.get(id);
	if (!tools) return null;
	return tools.has(normalizeToolName(toolName));
}

export function isToolAllowedForSender(
	toolName: string,
	sender: { userId?: string; chatId?: string },
	access: SenderToolAccess,
): { allowed: boolean; reason?: string } {
	const normalized = normalizeToolName(toolName);
	if (sender.userId && access.denyUserIds.has(sender.userId)) {
		return { allowed: false, reason: "user_denied" };
	}
	if (access.allowUserIds.size > 0 && sender.userId) {
		if (!access.allowUserIds.has(sender.userId)) {
			return { allowed: false, reason: "user_not_allowed" };
		}
	}
	const deniedUserTool = isToolAllowedByMap(
		sender.userId,
		normalized,
		access.denyUserTools,
	);
	if (deniedUserTool === true) {
		return { allowed: false, reason: "user_tool_denied" };
	}
	const allowedUserTool = isToolAllowedByMap(
		sender.userId,
		normalized,
		access.allowUserTools,
	);
	if (allowedUserTool === false) {
		return { allowed: false, reason: "user_tool_not_allowed" };
	}
	const deniedChatTool = isToolAllowedByMap(
		sender.chatId,
		normalized,
		access.denyChatTools,
	);
	if (deniedChatTool === true) {
		return { allowed: false, reason: "chat_tool_denied" };
	}
	const allowedChatTool = isToolAllowedByMap(
		sender.chatId,
		normalized,
		access.allowChatTools,
	);
	if (allowedChatTool === false) {
		return { allowed: false, reason: "chat_tool_not_allowed" };
	}
	return { allowed: true };
}

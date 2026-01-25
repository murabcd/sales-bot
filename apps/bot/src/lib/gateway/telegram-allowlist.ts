import type { Update } from "grammy/types";

type AllowlistDecision = { allowed: boolean; reason?: string };

function parseSet(raw: string | undefined) {
	if (!raw) return new Set<string>();
	return new Set(
		raw
			.split(",")
			.map((entry) => entry.trim())
			.filter(Boolean),
	);
}

function getUserId(update: Update) {
	if ("message" in update && update.message?.from?.id) {
		return String(update.message.from.id);
	}
	if ("callback_query" in update && update.callback_query?.from?.id) {
		return String(update.callback_query.from.id);
	}
	if ("edited_message" in update && update.edited_message?.from?.id) {
		return String(update.edited_message.from.id);
	}
	if ("channel_post" in update && update.channel_post?.sender_chat?.id) {
		return String(update.channel_post.sender_chat.id);
	}
	return "";
}

function getChatId(update: Update) {
	if ("message" in update && update.message?.chat?.id) {
		return String(update.message.chat.id);
	}
	if ("callback_query" in update && update.callback_query?.message?.chat?.id) {
		return String(update.callback_query.message.chat.id);
	}
	if ("edited_message" in update && update.edited_message?.chat?.id) {
		return String(update.edited_message.chat.id);
	}
	if ("channel_post" in update && update.channel_post?.chat?.id) {
		return String(update.channel_post.chat.id);
	}
	return "";
}

function isGroupChat(update: Update) {
	const chat =
		("message" in update ? update.message?.chat : undefined) ??
		("callback_query" in update
			? update.callback_query?.message?.chat
			: undefined) ??
		("edited_message" in update ? update.edited_message?.chat : undefined) ??
		("channel_post" in update ? update.channel_post?.chat : undefined);
	if (!chat) return false;
	const type = chat.type;
	return type === "group" || type === "supergroup";
}

export function allowTelegramUpdate(
	update: Update,
	env: Record<string, string | undefined>,
): AllowlistDecision {
	const allowedUsers = parseSet(env.ALLOWED_TG_IDS);
	const allowedGroups = parseSet(env.ALLOWED_TG_GROUPS);
	const userId = getUserId(update);
	const chatId = getChatId(update);

	if (allowedUsers.size > 0 && userId && !allowedUsers.has(userId)) {
		return { allowed: false, reason: "user_not_allowed" };
	}
	if (isGroupChat(update) && allowedGroups.size > 0) {
		if (!chatId || !allowedGroups.has(chatId)) {
			return { allowed: false, reason: "group_not_allowed" };
		}
	}
	return { allowed: true };
}

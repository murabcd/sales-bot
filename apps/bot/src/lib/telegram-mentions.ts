export type TelegramEntity = {
	type: string;
	offset: number;
	length: number;
};

export type TelegramMessageLike = {
	text?: string;
	entities?: TelegramEntity[];
	reply_to_message?: { from?: { id?: number } };
};

export type TelegramBotIdentity = {
	id?: number;
	username?: string;
};

export function isBotMentionedMessage(
	message: TelegramMessageLike | undefined,
	bot: TelegramBotIdentity | undefined,
): boolean {
	if (!message || !bot) return false;
	if (
		message.reply_to_message?.from?.id !== undefined &&
		bot.id !== undefined &&
		message.reply_to_message.from.id === bot.id
	) {
		return true;
	}

	const username = bot.username;
	if (!username) return false;
	if (typeof message.text !== "string") return false;

	const entities = message.entities ?? [];
	for (const entity of entities) {
		if (entity.type !== "mention") continue;
		const mention = message.text.slice(
			entity.offset,
			entity.offset + entity.length,
		);
		if (mention.toLowerCase() === `@${username.toLowerCase()}`) return true;
	}
	return false;
}

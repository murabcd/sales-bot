import { describe, expect, it } from "vitest";
import {
	isBotMentionedMessage,
	type TelegramMessageLike,
} from "../src/lib/telegram-mentions.js";

describe("isBotMentionedMessage", () => {
	it("returns true when replying to bot message", () => {
		const message: TelegramMessageLike = {
			reply_to_message: { from: { id: 42 } },
		};
		expect(isBotMentionedMessage(message, { id: 42, username: "omni" })).toBe(
			true,
		);
	});

	it("returns true for @mention", () => {
		const message: TelegramMessageLike = {
			text: "hi @Omni",
			entities: [{ type: "mention", offset: 3, length: 5 }],
		};
		expect(isBotMentionedMessage(message, { id: 1, username: "omni" })).toBe(
			true,
		);
	});

	it("returns false when there is no mention", () => {
		const message: TelegramMessageLike = {
			text: "hi there",
			entities: [{ type: "bold", offset: 0, length: 2 }],
		};
		expect(isBotMentionedMessage(message, { id: 1, username: "omni" })).toBe(
			false,
		);
	});
});

import { describe, expect, it } from "vitest";
import {
	appendHistoryMessage,
	formatHistoryForPrompt,
	loadHistoryMessages,
} from "../src/lib/context/session-history.js";

const chatId = "chat-1";

describe("session history", () => {
	it("returns empty history without supermemory config", async () => {
		await appendHistoryMessage(chatId, {
			timestamp: "2026-01-20T00:00:00.000Z",
			role: "user",
			text: "hello",
		});
		await appendHistoryMessage(chatId, {
			timestamp: "2026-01-20T00:00:01.000Z",
			role: "assistant",
			text: "hi",
		});

		const messages = await loadHistoryMessages(chatId, 20, "hello");
		expect(messages).toHaveLength(0);
		expect(formatHistoryForPrompt(messages)).toBe("");
	});

	it("formats history messages for prompt", () => {
		const formatted = formatHistoryForPrompt([
			{
				timestamp: "2026-01-20T00:00:00.000Z",
				role: "user",
				text: "hello",
			},
			{
				timestamp: "2026-01-20T00:00:01.000Z",
				role: "assistant",
				text: "hi",
			},
		]);
		expect(formatted).toContain("User: hello");
		expect(formatted).toContain("Assistant: hi");
	});
});

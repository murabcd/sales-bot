import type { Update } from "grammy/types";
import { describe, expect, it } from "vitest";
import { allowTelegramUpdate } from "../src/lib/gateway/telegram-allowlist.js";

function makeUpdate(params: { userId: number; chatId: number; type?: string }) {
	return {
		update_id: 1,
		message: {
			message_id: 1,
			date: 0,
			from: { id: params.userId, is_bot: false, first_name: "Test" },
			chat: { id: params.chatId, type: params.type ?? "private" },
			text: "hi",
		},
	} satisfies Update;
}

describe("gateway telegram allowlist", () => {
	it("allows when no allowlist configured", () => {
		const update = makeUpdate({ userId: 1, chatId: 1 });
		const decision = allowTelegramUpdate(update, {});
		expect(decision.allowed).toBe(true);
	});

	it("denies when user not in allowlist", () => {
		const update = makeUpdate({ userId: 2, chatId: 1 });
		const decision = allowTelegramUpdate(update, { ALLOWED_TG_IDS: "1" });
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toBe("user_not_allowed");
	});

	it("denies group when group not in allowlist", () => {
		const update = makeUpdate({ userId: 1, chatId: -10, type: "group" });
		const decision = allowTelegramUpdate(update, {
			ALLOWED_TG_IDS: "1",
			ALLOWED_TG_GROUPS: "-20",
		});
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toBe("group_not_allowed");
	});

	it("allows group when group is in allowlist", () => {
		const update = makeUpdate({ userId: 1, chatId: -20, type: "supergroup" });
		const decision = allowTelegramUpdate(update, {
			ALLOWED_TG_IDS: "1",
			ALLOWED_TG_GROUPS: "-20",
		});
		expect(decision.allowed).toBe(true);
	});
});

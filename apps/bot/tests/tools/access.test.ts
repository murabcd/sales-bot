import { describe, expect, it } from "vitest";
import {
	isToolAllowedForSender,
	parseSenderToolAccess,
} from "../../src/lib/tools/access.js";

describe("sender tool access", () => {
	it("denies tools for non-allowlisted users", () => {
		const access = parseSenderToolAccess({
			allowUserIds: "1,2",
		});
		const result = isToolAllowedForSender(
			"web_search",
			{ userId: "3" },
			access,
		);
		expect(result.allowed).toBe(false);
	});

	it("allows tools when user tool allowlist matches", () => {
		const access = parseSenderToolAccess({
			allowUserTools: "7:group:web",
		});
		const result = isToolAllowedForSender(
			"web_search",
			{ userId: "7" },
			access,
		);
		expect(result.allowed).toBe(true);
	});

	it("denies tools when chat tool denylist matches", () => {
		const access = parseSenderToolAccess({
			denyChatTools: "-100:group:web",
		});
		const result = isToolAllowedForSender(
			"web_search",
			{ chatId: "-100" },
			access,
		);
		expect(result.allowed).toBe(false);
	});
});

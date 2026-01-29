import { createHmac } from "crypto";
import { describe, expect, it } from "vitest";

import { verifyImageSignature } from "../lib/image-store.js";

describe("image store signing", () => {
	it("verifies valid signatures", () => {
		const signingSecret = "secret";
		const key = "images/2026/01/28/test.png";
		const exp = 1700000000000;
		const sig = createHmac("sha256", signingSecret)
			.update(`${key}:${exp}`)
			.digest("hex");
		expect(verifyImageSignature({ signingSecret, key, exp, sig })).toBe(true);
	});

	it("rejects invalid signatures", () => {
		const signingSecret = "secret";
		const key = "images/2026/01/28/test.png";
		const exp = 1700000000000;
		const sig = createHmac("sha256", "other")
			.update(`${key}:${exp}`)
			.digest("hex");
		expect(verifyImageSignature({ signingSecret, key, exp, sig })).toBe(false);
		expect(
			verifyImageSignature({
				signingSecret,
				key,
				exp: exp + 1000,
				sig,
			}),
		).toBe(false);
	});
});

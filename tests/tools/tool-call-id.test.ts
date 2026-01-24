import { describe, expect, it } from "vitest";
import { sanitizeToolCallIdsForTranscript } from "../../src/lib/tools/tool-call-id.js";

describe("tool call id sanitization", () => {
	it("avoids collisions when sanitization would collide", () => {
		const input = [
			{
				role: "assistant",
				content: [
					{ type: "toolCall", id: "call_a|b", name: "read" },
					{ type: "toolCall", id: "call_a:b", name: "read" },
				],
			},
			{
				role: "toolResult",
				toolCallId: "call_a|b",
				content: [{ type: "text", text: "one" }],
			},
			{
				role: "toolResult",
				toolCallId: "call_a:b",
				content: [{ type: "text", text: "two" }],
			},
		];

		const out = sanitizeToolCallIdsForTranscript(input);
		const assistant = out[0] as { content?: Array<{ id?: string }> };
		const a = assistant.content?.[0]?.id;
		const b = assistant.content?.[1]?.id;
		expect(a).toBeDefined();
		expect(b).toBeDefined();
		expect(a).not.toBe(b);
		const r1 = out[1] as { toolCallId?: string };
		const r2 = out[2] as { toolCallId?: string };
		expect(r1.toolCallId).toBe(a);
		expect(r2.toolCallId).toBe(b);
	});
});

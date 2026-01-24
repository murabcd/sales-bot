import { describe, expect, it } from "vitest";
import { repairToolUseResultPairing } from "../../src/lib/tools/transcript-repair.js";

describe("transcript repair", () => {
	it("drops orphan tool results and inserts missing ones", () => {
		const input = [
			{ role: "toolResult", toolCallId: "orphan", content: [] },
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "call_1", name: "web_search" }],
			},
			{ role: "user", content: [{ type: "text", text: "hi" }] },
		];
		const repaired = repairToolUseResultPairing(input);
		expect(repaired.droppedOrphanCount).toBe(1);
		expect(repaired.added).toHaveLength(1);
		const out = repaired.messages;
		expect(out[1]?.role).toBe("toolResult");
	});

	it("deduplicates tool results", () => {
		const input = [
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "call_1", name: "web_search" }],
			},
			{ role: "toolResult", toolCallId: "call_1", content: [] },
			{ role: "toolResult", toolCallId: "call_1", content: [] },
		];
		const repaired = repairToolUseResultPairing(input);
		expect(repaired.droppedDuplicateCount).toBe(1);
		const toolResults = repaired.messages.filter(
			(message) => message.role === "toolResult",
		);
		expect(toolResults).toHaveLength(1);
	});
});

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	createApprovalStore,
	parseApprovalList,
} from "../../src/lib/tools/approvals.js";

describe("approval store", () => {
	it("normalizes approval list entries", () => {
		const list = parseApprovalList(" Web_Search , JIRA_ISSUES_FIND ");
		expect(list).toEqual(["web_search", "jira_issues_find"]);
	});

	it("approves and expires tools per chat", () => {
		vi.useFakeTimers();
		const store = createApprovalStore(1000);
		expect(store.isApproved("chat", "web_search")).toBe(false);
		store.approve("chat", "web_search");
		expect(store.isApproved("chat", "web_search")).toBe(true);
		vi.advanceTimersByTime(1001);
		expect(store.isApproved("chat", "web_search")).toBe(false);
		vi.useRealTimers();
	});

	it("persists approvals to disk", () => {
		const filePath = path.join(
			process.cwd(),
			"data",
			"approvals",
			"approvals.test.json",
		);
		if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
		const store = createApprovalStore(60_000, { filePath });
		store.approve("chat", "web_search");
		const reloaded = createApprovalStore(60_000, { filePath });
		expect(reloaded.isApproved("chat", "web_search")).toBe(true);
		fs.unlinkSync(filePath);
	});
});

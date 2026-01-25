import { describe, expect, it } from "vitest";
import {
	filterPosthogTools,
	POSTHOG_READONLY_TOOL_NAMES,
} from "../src/lib/posthog-tools.js";

const makeTool = () => ({ execute: async () => ({}) });

describe("posthog tools", () => {
	it("filters to read-only tool set", () => {
		const tools = {
			"insight-get": makeTool(),
			"dashboard-create": makeTool(),
			"query-run": makeTool(),
		};
		const filtered = filterPosthogTools(tools);
		expect(Object.keys(filtered)).toEqual(["insight-get", "query-run"]);
	});

	it("has expected read-only names", () => {
		expect(POSTHOG_READONLY_TOOL_NAMES.has("insight-get")).toBe(true);
		expect(POSTHOG_READONLY_TOOL_NAMES.has("dashboard-create")).toBe(false);
	});
});

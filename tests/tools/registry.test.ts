import { describe, expect, it } from "vitest";
import {
	createToolRegistry,
	normalizeToolName,
} from "../../src/lib/tools/registry.js";

describe("tool registry", () => {
	it("detects duplicate tool names", () => {
		const registry = createToolRegistry();
		const first = registry.register({
			name: "web_search",
			source: "web",
		});
		const second = registry.register({
			name: "web_search",
			source: "command",
		});
		expect(first.ok).toBe(true);
		expect(second.ok).toBe(false);
		expect(registry.conflicts()).toHaveLength(1);
	});

	it("normalizes aliases for conflicts", () => {
		const registry = createToolRegistry();
		registry.register({ name: "apply-patch", source: "core" });
		const res = registry.register({ name: "apply_patch", source: "core" });
		expect(res.ok).toBe(false);
		expect(normalizeToolName("apply-patch")).toBe("apply_patch");
	});
});

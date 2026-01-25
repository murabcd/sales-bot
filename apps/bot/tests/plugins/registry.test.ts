import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PluginRegistry } from "../../src/lib/plugins/registry.js";

describe("plugin registry", () => {
	it("loads plugin tools and hooks", async () => {
		const pluginPath = path.join(
			process.cwd(),
			"data",
			"plugins",
			"test-plugin.js",
		);
		if (!fs.existsSync(path.dirname(pluginPath))) {
			fs.mkdirSync(path.dirname(pluginPath), { recursive: true });
		}
		fs.writeFileSync(
			pluginPath,
			`export default function (api) {
        api.registerTool({ name: "demo_tool", description: "demo", tool: { description: "demo", inputSchema: { type: "object", properties: {} }, execute: async () => "ok" } });
        api.registerHooks({ beforeToolCall: () => ({ allow: true }) });
      }`,
			"utf-8",
		);
		const registry = new PluginRegistry();
		await registry.load([pluginPath]);
		const tools = registry.getTools();
		expect(tools.some((tool) => tool.name === "demo_tool")).toBe(true);
		expect(registry.getHooks().length).toBe(1);
		fs.unlinkSync(pluginPath);
	});
});

import type { ToolSet } from "ai";

export function pickTools(source: ToolSet, names: string[]): ToolSet {
	const picked: ToolSet = {};
	for (const name of names) {
		const tool = source[name];
		if (tool) picked[name] = tool;
	}
	return picked;
}

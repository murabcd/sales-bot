export type RuntimeSkill = {
	name: string;
	description?: string;
	tool: string;
	args?: Record<string, unknown>;
	timeoutMs?: number;
};

export type ToolRef = {
	server: string;
	tool: string;
};

export function resolveToolRef(
	toolRef: string,
	defaultServer = "yandex-tracker",
): ToolRef {
	const trimmed = toolRef.trim();
	if (!trimmed) {
		return { server: defaultServer, tool: "" };
	}
	const dotIndex = trimmed.indexOf(".");
	if (dotIndex === -1) {
		return { server: defaultServer, tool: trimmed };
	}
	const server = trimmed.slice(0, dotIndex);
	const tool = trimmed.slice(dotIndex + 1);
	return { server, tool };
}

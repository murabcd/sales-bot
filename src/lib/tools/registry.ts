export type ToolSource =
	| "core"
	| "web"
	| "memory"
	| "tracker"
	| "posthog"
	| "runtime-skill"
	| "command"
	| "plugin"
	| "other";

export type ToolMeta = {
	name: string;
	description?: string;
	source: ToolSource;
	origin?: string;
};

export type ToolConflict = {
	tool: ToolMeta;
	existing: ToolMeta;
	reason: "duplicate-name";
	normalizedName: string;
};

export type ToolConflictLog = {
	event: "tool_conflict";
	name: string;
	normalizedName: string;
	source: ToolSource;
	origin?: string;
	existingSource: ToolSource;
	existingOrigin?: string;
	reason: "duplicate-name";
};

export type ToolRegistry = {
	register: (tool: ToolMeta) => { ok: boolean; reason?: string };
	list: () => ToolMeta[];
	conflicts: () => ToolConflict[];
};

const TOOL_NAME_ALIASES: Record<string, string> = {
	bash: "exec",
	"apply-patch": "apply_patch",
};

export function normalizeToolName(name: string): string {
	const normalized = name.trim().toLowerCase();
	return TOOL_NAME_ALIASES[normalized] ?? normalized;
}

function metaMatches(a: ToolMeta, b: ToolMeta): boolean {
	return (
		a.source === b.source &&
		a.name === b.name &&
		(a.origin ?? "") === (b.origin ?? "")
	);
}

export function createToolRegistry(options?: {
	logger?: (event: ToolConflictLog) => void;
}): ToolRegistry {
	const byName = new Map<string, ToolMeta>();
	const conflicts: ToolConflict[] = [];
	const conflictKeys = new Set<string>();
	const logger = options?.logger;

	const register = (tool: ToolMeta) => {
		const normalizedName = normalizeToolName(tool.name);
		if (!normalizedName) return { ok: false, reason: "empty-name" };
		const existing = byName.get(normalizedName);
		if (existing) {
			if (metaMatches(existing, tool)) return { ok: true };
			const key = `${normalizedName}:${existing.source}:${tool.source}`;
			if (!conflictKeys.has(key)) {
				conflictKeys.add(key);
				const conflict: ToolConflict = {
					tool,
					existing,
					reason: "duplicate-name",
					normalizedName,
				};
				conflicts.push(conflict);
				logger?.({
					event: "tool_conflict",
					name: tool.name,
					normalizedName,
					source: tool.source,
					origin: tool.origin,
					existingSource: existing.source,
					existingOrigin: existing.origin,
					reason: "duplicate-name",
				});
			}
			return { ok: false, reason: "duplicate-name" };
		}
		byName.set(normalizedName, tool);
		return { ok: true };
	};

	const list = () => Array.from(byName.values());
	const listConflicts = () => [...conflicts];

	return { register, list, conflicts: listConflicts };
}
